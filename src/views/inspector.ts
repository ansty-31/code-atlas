import { languageName } from '../shared/languages.mjs';
import { msg, trLabel } from '../i18n';
/**
 * Inspector — the right-hand detail panel.
 *
 * Shows whatever is selected: a class (metrics, doc, ancestry, subtypes,
 * members, coupling) or a package group (aggregates, contents, coupling).
 * Falls back to a project overview when nothing is selected.
 */

import {
  type Atlas,
  type ClassRec,
  type MemberRec,
  type MemberRefs,
  type PkgNode,
  type RefRow,
  REF_KIND_LABEL,
  loadMembers,
  loadClassDeps,
  loadRefMeta,
  loadRefShard,
  ancestryOf,
  descendantsOf,
  KIND_NAMES,
} from '../domain';
import { store, type AppState } from '../state';
import { $, fmtBytes, fmtCompact, fmtInt, h, kv, preserveInputFocus, watchOverflowTitles } from '../util';
import { openSource } from './source';

const KIND_BADGE = ['C', 'I', 'E', 'R', '@', 'M'];

let atlas: Atlas | null = null;
let deps: { out: Map<number, { id: number; w: number }[]>; in: Map<number, { id: number; w: number }[]> } | null = null;
let depsLoading = false;
let memberCache = new Map<number, MemberRec[]>();
let memberFilter = '';
/** package -> per-class, per-member reference rows (loaded on demand) */
const refShards = new Map<string, Map<number, Map<number, MemberRefs>>>();
let refState: 'unknown' | 'loading' | 'ready' | 'absent' = 'unknown';
let refCounts: { sites: number; resolved: number; classOnly: number; unresolved: number } | null = null;

export function initInspector(a: Atlas) {
  atlas = a;
  document.getElementById('inspector-body')!.addEventListener('click', onBodyClick);
}

export function setMemberCache(m: Map<number, MemberRec[]>) {
  memberCache = m;
}

function ensureDeps() {
  if (deps || depsLoading || !atlas) return;
  depsLoading = true;
  loadClassDeps('data').then((edges) => {
    const out = new Map<number, { id: number; w: number }[]>();
    const inc = new Map<number, { id: number; w: number }[]>();
    for (const e of edges) {
      push(out, e.from, { id: e.to, w: e.w });
      push(inc, e.to, { id: e.from, w: e.w });
    }
    for (const arr of out.values()) arr.sort((a, b) => b.w - a.w);
    for (const arr of inc.values()) arr.sort((a, b) => b.w - a.w);
    deps = { out, in: inc };
    render(store.state);
  });
}

function push<T>(m: Map<number, T[]>, k: number, v: T) {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

let memberLoadInFlight: number | null = null;
let refLoadInFlight: string | null = null;

/**
 * References arrive per package, like member lists. The index is probed once;
 * a bundle built with `--no-refs` simply never has them, and every surface
 * below renders nothing extra in that case.
 */
async function ensureRefs(pkg: string) {
  if (atlas?.meta.capabilities?.memberReferences === false) return;
  if (refState === 'absent' || refShards.has(pkg) || refLoadInFlight === pkg) return;
  refLoadInFlight = pkg;
  try {
    if (refState === 'unknown') {
      refState = 'loading';
      refCounts = await loadRefMeta('data');
      refState = refCounts ? 'ready' : 'absent';
      if (!refCounts) {
        render(store.state);
        return;
      }
    }
    refShards.set(pkg, await loadRefShard('data', pkg));
  } catch {
    /* shard missing: the panel shows the plain member list */
  } finally {
    refLoadInFlight = null;
    render(store.state);
  }
}

function refsFor(c: ClassRec): Map<number, MemberRefs> | null {
  return refShards.get(c.pkg)?.get(c.id) ?? null;
}

/** Total incoming rows for one member, by kind. */
function incoming(refs: Map<number, MemberRefs> | null, line: number): RefRow[] {
  return refs?.get(line)?.in ?? [];
}

async function ensureMembersFor(classId: number) {
  if (!atlas || memberLoadInFlight === classId) return;
  memberLoadInFlight = classId;
  try {
    const shard = await loadMembers('data', atlas.byId[classId].pkg);
    for (const [id, list] of shard) memberCache.set(id, list);
  } catch {
    /* shard missing: the panel simply shows no member list */
  } finally {
    memberLoadInFlight = null;
    render(store.state);
  }
}

function onBodyClick(e: MouseEvent) {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!el) return;
  const act = el.dataset.act!;
  const id = el.dataset.id ? Number(el.dataset.id) : null;
  const pkg = el.dataset.pkg ?? null;
  switch (act) {
    case 'class':
      store.update((s) => {
        s.selection.classId = id;
        s.selection.packagePath = null;
      });
      break;
    case 'pkg':
      store.update((s) => {
        s.selection.packagePath = pkg;
        s.selection.classId = null;
      });
      break;
    case 'zoom-pkg':
      store.update((s) => {
        s.view = 'treemap';
        s.selection.zoom = pkg ? pkg.split('.').map((_, i, arr) => `p:${arr.slice(0, i + 1).join('.')}`) : [];
        s.selection.packagePath = pkg;
      });
      break;
    case 'source':
      if (id != null && atlas) openSource(atlas.byId[id]);
      break;
    case 'focus':
      if (id != null) {
        store.update((s) => {
          s.view = 'hierarchy';
          s.selection.classId = id;
        });
      }
      break;
    case 'clear-filter':
      memberFilter = '';
      render(store.state);
      break;
  }
}

export function render(state: AppState) {
  const a = atlas;
  const body = $('#inspector-body');
  if (!a) return;
  const { classId, packagePath } = state.selection;
  // A shard that finishes loading repaints the whole panel — including the
  // filter input, if it is on screen. Typing itself never repaints the panel
  // (see `membersBlock`), so this only has to cover the asynchronous path.
  preserveInputFocus('member-filter', () => {
    if (classId != null && a.byId[classId]) {
      // Members are sharded per package: fetch the shard for whatever is selected
      // (treemap click, search hit, hierarchy node, insight row — all of them).
      if (!memberCache.has(classId)) void ensureMembersFor(classId);
      void ensureRefs(a.byId[classId].pkg);
      body.replaceChildren(classPanel(a.byId[classId]));
      ensureDeps();
    } else if (packagePath && a.pkgByPath.get(packagePath)) {
      body.replaceChildren(pkgPanel(a.pkgByPath.get(packagePath)!));
    } else {
      memberFilter = '';
      body.replaceChildren(overviewPanel());
    }
  });
  // Truncated metric values only show their full text while they are clipped.
  watchOverflowTitles(body);
}

/** ------------------------------------------------------------- class view -- */

function classPanel(c: ClassRec): HTMLElement {
  const wrap = h('div');
  const kids = (c.subIds ?? []).map((id) => atlas!.byId[id]).filter(Boolean);
  const chain = ancestryOf(atlas!, c).reverse();
  const allDesc = c.subIds.length ? descendantsOf(atlas!, c) : [];

  wrap.append(
    h(
      'div',
      { class: 'insp-title' },
      h('span', { class: 'kinddot', style: { background: 'var(--accent)' } }),
      h('h1', { text: c.name }),
      h('span', { class: 'badge', text: trLabel(KIND_NAMES[c.kind]) }),
      c.luaExposed ? h('span', { class: 'badge', style: { color: 'var(--lua)', borderColor: 'var(--lua)' }, text: 'Lua API' }) : null,
      c.hiddenFromLua ? h('span', { class: 'badge', text: '@HiddenFromLua' }) : null
    )
  );
  wrap.append(h('div', { class: 'insp-path', text: `${c.fqn}${c.parentType ? msg("  (nested)") : ''}` }));
  if (c.doc) wrap.append(h('div', { class: 'insp-doc', text: c.doc }));

  wrap.append(
    h(
      'div',
      { class: 'stage-actions', style: { marginBottom: '10px' } },
      h('button', { 'data-act': 'source', 'data-id': c.id, text: msg("View source") }),
      c.kind !== 5 ? h('button', { 'data-act': 'focus', 'data-id': c.id, text: msg("Show in hierarchy") }) : null,
      h('button', {
        text: msg("Copy FQN"),
        onclick: () => navigator.clipboard?.writeText(c.fqn),
      })
    )
  );

  // ---- metrics
  wrap.append(
    section(
      msg("Metrics"),
      h(
        'dl',
        { class: 'kv' },
        kv(msg("languages"), c.language ?? 'java'),
        kv(msg("kind"), `${trLabel(KIND_NAMES[c.kind])} · ${trLabel(c.stereotype)}`),
        kv(msg("source lines"), fmtInt(c.loc)),
        kv(msg("code lines"), fmtInt(c.code)),
        kv(msg("comment lines"), fmtInt(c.comment)),
        kv(msg("file size"), fmtBytes(c.bytes)),
        kv(msg("declared at"), `${c.path}:${c.declLine}`),
        kv(msg("methods"), fmtInt(c.methods)),
        kv(msg("fields"), fmtInt(c.fields)),
        c.enumConstants ? kv(msg("enum constants"), String(c.enumConstants)) : null,
        kv(msg("complexity"), fmtInt(c.complexity)),
        kv(msg("fan-in / fan-out"), `${fmtInt(c.fanIn)} / ${fmtInt(c.fanOut)}`),
        kv(msg("modifiers"), c.modifiers || '—')
      )
    )
  );

  // ---- hierarchy
  const chainEl = h('div', { class: 'link-list' });
  if (!chain.length) chainEl.append(h('div', { class: 'empty', text: msg("No internal superclass (root type)") }));
  for (const a of chain) {
    chainEl.append(linkRow(a, `${KIND_BADGE[a.kind]} ${a.fqn}`));
  }
  chainEl.append(linkRow(c, `→ ${c.fqn}`, true));

  const subEl = h('div', { class: 'link-list' });
  if (!kids.length) subEl.append(h('div', { class: 'empty', text: msg("No direct subtypes") }));
  for (const k of kids.sort((a, b) => b.code - a.code)) {
    subEl.append(linkRow(k, `${KIND_BADGE[k.kind]} ${k.name}`, false, k.luaExposed ? 'lua' : msg("{0} ln", fmtCompact(k.code))));
  }

  if (c.kind !== 5) wrap.append(
    section(
      msg("Hierarchy{0}", allDesc.length ? msg(" · {0} transitive subtypes", allDesc.length) : ''),
      chainEl,
      kids.length ? h('h3', { style: { marginTop: '8px' }, text: msg("Direct subtypes") }) : null,
      kids.length ? subEl : null
    )
  );

  // ---- members
  // Badge totals come first: the rows below read them while they are built,
  // and the filter repaints those same rows later.
  refBadges = new Map();
  const classRefs = refsFor(c);
  if (classRefs) {
    for (const [line, m] of classRefs) refBadges.set(line, { outTotal: totalRows(m.out), inTotal: totalRows(m.in) });
  }
  const members = memberCache.get(c.id);
  const memSection = h('div', { class: 'insp-section' });
  if (!members) {
    memSection.append(h('h3', { text: msg("Members") }), h('div', { class: 'empty', text: msg("loading…") }));
  } else {
    memSection.append(membersBlock(members));
  }
  wrap.append(memSection);

  const refsEl = refsSection(c, classRefs);
  if (refsEl) wrap.append(refsEl);

  // ---- coupling
  if (deps) {
    const out = (deps.out.get(c.id) ?? []).slice(0, 14);
    const inc = (deps.in.get(c.id) ?? []).slice(0, 14);
    const outEl = h('div', { class: 'link-list' });
    for (const e of out) {
      const t = atlas!.byId[e.id];
      if (t) outEl.append(linkRow(t, t.fqn, false, `×${e.w}`));
    }
    const inEl = h('div', { class: 'link-list' });
    for (const e of inc) {
      const t = atlas!.byId[e.id];
      if (t) inEl.append(linkRow(t, t.fqn, false, `×${e.w}`));
    }
    wrap.append(
      section(
        'Coupling',
        h('h3', { text: msg("Depends on ({0})", deps.out.get(c.id)?.length ?? 0) }),
        out.length ? outEl : h('div', { class: 'empty', text: msg("nothing") }),
        h('h3', { style: { marginTop: '8px' }, text: msg("Used by ({0})", deps.in.get(c.id)?.length ?? 0) }),
        inc.length ? inEl : h('div', { class: 'empty', text: msg("nothing") })
      )
    );
  }
  return wrap;
}

/** Badge totals for the member rows of the type currently rendered. */
let refBadges = new Map<number, { outTotal: number; inTotal: number }>();

/**
 * The member list and its name filter, as one block.
 *
 * The filter is a live control: typing repaints the list and the match count in
 * place and never touches the input itself, so focus and the caret stay exactly
 * where the user left them. Rebuilding the whole panel from the `input` event
 * (as this used to) replaced the input on every keystroke, and the replacement
 * took the caret back to position 0 — each new character landed *before* the
 * previous one.
 */
function membersBlock(members: MemberRec[]): HTMLElement {
  const count = h('span', { class: 'count' });
  const body = h('div');
  const input = h('input', {
    type: 'text',
    id: 'member-filter',
    placeholder: msg("filter…"),
    'aria-label': msg("Filter members by name"),
    value: memberFilter,
    style: { marginLeft: 'auto', width: '120px', padding: '1px 5px', fontSize: '11px' },
    oninput: () => {
      memberFilter = input.value;
      paint();
    },
  });

  function paint() {
    const f = memberFilter.trim().toLowerCase();
    const shown = f
      ? members.filter((m) => `${m.name} ${m.type} ${m.params.join(' ')} ${m.annotations.join(' ')}`.toLowerCase().includes(f))
      : members;
    const methods = shown.filter((m) => m.kind !== 'field');
    const fields = shown.filter((m) => m.kind === 'field');
    count.textContent = `${shown.length}/${members.length}`;
    const parts: HTMLElement[] = [];
    if (methods.length) {
      parts.push(h('h3', { style: { marginTop: '8px' }, text: msg("Methods ({0})", methods.length) }));
      const list = h('div', { class: 'member-list' });
      for (const m of methods.slice(0, 400)) list.append(memberRow(m));
      parts.push(list);
    }
    if (fields.length) {
      parts.push(h('h3', { style: { marginTop: '8px' }, text: msg("Fields ({0})", fields.length) }));
      const list = h('div', { class: 'member-list' });
      for (const m of fields.slice(0, 300)) list.append(memberRow(m));
      parts.push(list);
    }
    if (!shown.length) parts.push(h('div', { class: 'empty', text: msg("No members match the filter") }));
    body.replaceChildren(...parts);
  }

  paint();
  return h('div', {}, h('h3', {}, msg("Members "), count, input), body);
}

/** The name of a member of `c` declared at `line`, when the shard is loaded. */
function fieldNameOf(c: ClassRec, line: number): string | null {
  if (line < 0) return null;
  return (memberCache.get(c.id) ?? []).find((m) => m.line === line)?.name ?? null;
}

function totalRows(rows: RefRow[] | null | undefined): number {
  return (rows ?? []).reduce((a, r) => a + r[3], 0);
}

/**
 * The References section: what this type's members call and touch (outgoing),
 * what touches them (incoming), and how much of it resolved.
 */
function refsSection(c: ClassRec, refs: Map<number, MemberRefs> | null): HTMLElement | null {
  if (refState !== 'ready') return null;
  if (!refs) {
    return section(msg("References"), h('div', { class: 'empty', text: msg("loading references…") }));
  }

  const outRows = new Map<RefRow['2'] /* kind */, Map<string, RefRow>>();
  const inRows = new Map<number, Map<string, RefRow>>();
  const push = (map: Map<number, Map<string, RefRow>>, key: number, row: RefRow) => {
    let inner = map.get(key);
    if (!inner) map.set(key, (inner = new Map()));
    const id = `${row[0]}:${row[1]}:${row[2]}`;
    const prev = inner.get(id);
    if (prev) prev[3] += row[3];
    else inner.set(id, [...row] as RefRow);
  };
  for (const m of refs.values()) {
    for (const r of m.out ?? []) push(outRows as never, r[2], r);
    for (const r of m.in ?? []) push(inRows, m.line, r);
  }

  const totals = [...refs.values()].reduce(
    (acc, m) => {
      acc.out += totalRows(m.out);
      acc.in += totalRows(m.in);
      return acc;
    },
    { out: 0, in: 0 }
  );
  const header = h('h3', {}, msg("References"), h('span', { class: 'count', text: `→${totals.out} ←${totals.in}` }));
  // `data-refs` is the language-neutral hook the test suite locates by
  const wrap = h('div', { class: 'insp-section', 'data-refs': 'section' }, header);
  // The resolution figure describes the whole bundle, not the selected type, so
  // it gets a line of its own instead of a badge in the header — where "37%
  // resolved" read as if it were this type's score.
  if (refCounts) {
    wrap.append(
      h('div', {
        class: 'refs-total',
        text: msg("{0} / {1} sites resolved, tree-wide", fmtInt(refCounts.resolved), fmtInt(refCounts.sites)),
      })
    );
  }

  const group = (kind: number, label: string, limit = 12) => {
    const rows = [...(outRows.get(kind as never)?.values() ?? [])].sort((a, b) => b[3] - a[3]);
    if (!rows.length) return;
    wrap.append(h('h3', { style: { marginTop: '8px' }, text: msg("{0} ({1})", label, rows.length) }));
    const list = h('div', { class: 'link-list' });
    for (const r of rows.slice(0, limit)) {
      const target = atlas!.byId[r[0]];
      if (!target) continue;
      const member = (memberCache.get(r[0]) ?? []).find((mm) => mm.line === r[1]);
      list.append(refRow(target, member, r, 'out'));
    }
    if (rows.length > limit) list.append(h('div', { class: 'empty', text: msg("… and {0} more", rows.length - limit) }));
    wrap.append(list);
  };
  group(0, msg("Calls"));
  group(1, msg("Reads"));
  group(2, msg("Writes"));

  // ---- data flow: what the members store, return and hand to other code ----
  const flowRows: [string, string][] = [];
  for (const m of refs.values()) {
    const flow = m.flow;
    if (!flow) continue;
    for (const [param, fieldLine] of flow.p ?? []) {
      const field = fieldNameOf(c, fieldLine);
      flowRows.push([
        `${m.name}`,
        field ? msg("stores parameter {0} into {1}", param, field) : msg("stores parameter {0} into a field", param),
      ]);
    }
    for (const [prov, ref] of flow.r ?? []) {
      const where =
        prov === 0 ? msg("parameter {0}", ref)
        : prov === 1 ? (fieldNameOf(c, ref) ? msg("field {0}", fieldNameOf(c, ref)!) : msg("a field"))
        : prov === 2 ? msg("a local")
        : prov === 3 ? msg("a call result")
        : prov === 4 ? msg("a literal")
        : prov === 5 ? msg("a new object")
        : msg("an expression");
      flowRows.push([m.name, msg("returns {0}", where)]);
    }
    for (const [toClass, toLine, shape] of flow.g ?? []) {
      const target = atlas!.byId[toClass];
      const member = (memberCache.get(toClass) ?? []).find((mm) => mm.line === toLine);
      const where = target ? `${target.name}${member ? `.${member.name}` : ''}` : '?';
      flowRows.push([m.name, shape === 1 ? msg("registers itself with {0}", where) : msg("registers a callback with {0}", where)]);
    }
  }
  if (flowRows.length) {
    wrap.append(h('h3', { style: { marginTop: '8px' }, text: msg("Data flow ({0})", flowRows.length) }));
    const list = h('div', { class: 'link-list' });
    for (const [member, text] of flowRows.slice(0, 14)) {
      list.append(
        h(
          'div',
          { class: 'link', title: text },
          h('span', { class: 'nm', text: member }),
          h('span', { class: 'sub', text })
        )
      );
    }
    if (flowRows.length > 14) list.append(h('div', { class: 'empty', text: msg("… and {0} more", flowRows.length - 14) }));
    wrap.append(list);
  }

  // incoming, by the members of this type that are referenced
  const busiest = [...inRows.entries()].sort((a, b) => totalRows([...b[1].values()]) - totalRows([...a[1].values()])).slice(0, 10);
  if (busiest.length) {
    wrap.append(h('h3', { style: { marginTop: '8px' }, text: msg("Used by ({0} members)", inRows.size) }));
    const list = h('div', { class: 'link-list' });
    for (const [line, rows] of busiest) {
      const member = (memberCache.get(c.id) ?? []).find((mm) => mm.line === line);
      const top = [...rows.values()].sort((a, b) => b[3] - a[3]);
      for (const r of top.slice(0, 4)) {
        const caller = atlas!.byId[r[0]];
        if (!caller) continue;
        list.append(
          h(
            'div',
            { class: 'link', 'data-act': 'class', 'data-id': caller.id, 'data-refs': 'row', title: caller.fqn },
            h('span', { class: 'kinddot', style: { background: 'var(--accent-2)', opacity: '0.8' } }),
            h('span', { class: 'nm', text: `${caller.name}.${member?.name ?? '?'}` }),
            h('span', { class: 'sub', text: `${REF_KIND_LABEL[r[2]]} ${member?.name ?? ''} ×${r[3]}` })
          )
        );
      }
    }
    wrap.append(list);
  }

  if (!totals.out && !totals.in) {
    wrap.append(h('div', { class: 'empty', text: msg("no resolved references") }));
  }
  if (refCounts && refCounts.unresolved) {
    wrap.append(
      h('div', {
        class: 'empty',
        style: { marginTop: '6px' },
        text: msg(
          "{0} sites resolved at class level, {1} sites could not be typed",
          fmtInt(refCounts.classOnly),
          fmtInt(refCounts.unresolved)
        ),
      })
    );
  }
  return wrap;
}

/** One row of the references list: target type, member, count and first line. */
function refRow(target: ClassRec, member: MemberRec | undefined, row: RefRow, dir: 'in' | 'out'): HTMLElement {
  return h(
    'div',
    { class: 'link', 'data-act': 'class', 'data-id': target.id, title: `${target.fqn}${row[4]?.length ? `
${msg("line {0}", row[4].join(', '))}` : ''}` },
    h('span', { class: 'kinddot', style: { background: `var(--accent${dir === 'out' ? '' : '-2'})`, opacity: '0.8' } }),
    h('span', { class: 'nm', text: member ? `${target.name}.${member.name}` : target.name }),
    h('span', { class: 'sub', text: `×${row[3]}${row[4]?.length ? ` · ${msg("line {0}", row[4][0])}` : ''}` })
  );
}

function memberRow(m: MemberRec): HTMLElement {
  const lua = m.annotations.includes('UsedFromLua');
  const sig = h('span', { class: 'sig' });
  if (m.kind === 'field') {
    sig.append(h('span', { class: 'm-type', text: `${m.type} ` }), h('span', { class: 'm-name', text: m.name }));
    if (m.init) sig.append(h('span', { class: 'm-type', text: ` = ${m.init}` }));
  } else {
    sig.append(
      h('span', { class: 'm-type', text: m.type ? `${m.type} ` : '' }),
      h('span', { class: 'm-name', text: m.name }),
      h('span', { class: 'm-params', text: `(${m.params.join(', ')})` })
    );
  }
  const badges = h('span', { style: { display: 'flex', gap: '4px' } });
  if (m.complexity > 12) badges.append(h('span', { class: 'badge cx', text: msg("cx {0}", m.complexity) }));
  if (lua) badges.append(h('span', { class: 'badge lua', text: msg("lua") }));
  const refs = refBadges.get(m.line);
  if (refs) {
    const out = refs.outTotal;
    const inc = refs.inTotal;
    if (out || inc) {
      badges.append(
        h('span', {
          class: 'badge refs',
          title: msg("references: {0} outgoing, {1} incoming", out, inc),
          text: `${out ? `→${out}` : ''}${out && inc ? ' ' : ''}${inc ? `←${inc}` : ''}`,
        })
      );
    }
  }
  const row = h('div', { class: `member${lua ? ' lua' : ''}`, title: msg("{0} · line {1}{2}", m.modifiers, m.line, m.doc ? `\n\n${m.doc}` : '') }, sig, badges);
  return row;
}

function linkRow(c: ClassRec, label: string, current = false, right?: string): HTMLElement {
  return h(
    'div',
    { class: 'link', 'data-act': 'class', 'data-id': c.id, title: c.fqn },
    h('span', { class: 'kinddot', style: { background: `var(--accent${current ? '' : '-2'})`, opacity: current ? 1 : 0.75 } }),
    h('span', { class: 'nm', text: label }),
    right ? h('span', { class: 'sub', text: right }) : null
  );
}

/** ----------------------------------------------------------- package view -- */

function pkgPanel(p: PkgNode): HTMLElement {
  const wrap = h('div');
  const m = p.metrics;
  wrap.append(h('div', { class: 'insp-title' }, h('h1', { text: p.name })));
  wrap.append(h('div', { class: 'insp-path', text: p.path }));
  wrap.append(
    h(
      'div',
      { class: 'stage-actions', style: { marginBottom: '10px' } },
      h('button', { 'data-act': 'zoom-pkg', 'data-pkg': p.path, text: msg("Zoom treemap here") }),
      h('button', { 'data-act': 'clear-filter', text: msg("Clear") })
    )
  );
  if (m) {
    wrap.append(
      section(
        msg("Package metrics"),
        h(
          'dl',
          { class: 'kv' },
          kv(msg("types"), fmtInt(m.types)),
          kv(msg("classes / ifaces"), `${m.classes} / ${m.interfaces}`),
          kv(msg("enums / records"), `${m.enums} / ${m.records}`),
          kv(msg("code lines"), fmtInt(m.code)),
          kv(msg("methods"), fmtInt(m.methods)),
          kv(msg("fields"), fmtInt(m.fields)),
          kv(msg("complexity"), fmtInt(m.complexity)),
          kv(msg("lua-exposed"), String(m.luaExposed)),
          kv(msg("cross-pkg fan-in"), fmtInt(m.fanIn)),
          kv(msg("cross-pkg fan-out"), fmtInt(m.fanOut))
        )
      )
    );
  }
  const kids = [...p.children].sort((a, b) => (b.metrics?.code ?? 0) - (a.metrics?.code ?? 0));
  if (kids.length) {
    const list = h('div', { class: 'link-list' });
    for (const k of kids) {
      list.append(
        h(
          'div',
          { class: 'link', 'data-act': 'pkg', 'data-pkg': k.path },
          h('span', { class: 'kinddot', style: { background: 'var(--accent)' } }),
          h('span', { class: 'nm', text: k.name }),
          h('span', { class: 'sub', text: msg("{0} types · {1} ln", k.ownIds.length, fmtCompact(k.metrics?.code ?? 0)) })
        )
      );
    }
    wrap.append(section(msg("Sub-packages ({0})", kids.length), list));
  }

  const own = p.ownIds.map((id) => atlas!.byId[id]).sort((a, b) => b.code - a.code);
  const list = h('div', { class: 'link-list' });
  for (const c of own.slice(0, 60)) list.append(linkRow(c, c.name, false, msg("{0} ln", fmtCompact(c.code))));
  wrap.append(section(msg("Types here ({0})", own.length), own.length ? list : h('div', { class: 'empty', text: msg("none") })));
  return wrap;
}

/** ---------------------------------------------------------- overview view -- */

function overviewPanel(): HTMLElement {
  const a = atlas!;
  const wrap = h('div');
  const c = a.meta.counts;
  wrap.append(h('div', { class: 'insp-title' }, h('h1', { text: msg("Project overview") })));
  wrap.append(h('div', { class: 'insp-path', text: `${a.meta.sourceRoot} · ${a.meta.decompiler ?? ''}` }));
  wrap.append(
    section(
      msg("Extracted from source"),
      h(
        'dl',
        { class: 'kv' },
        kv(msg("files"), fmtInt(c.files)),
        kv(msg("types"), fmtInt(c.types)),
        kv(msg("packages"), fmtInt(c.packages)),
        kv(msg("code lines"), fmtInt(c.code)),
        kv(msg("total lines"), fmtInt(c.loc)),
        kv(msg("methods"), fmtInt(c.methods)),
        kv(msg("fields"), fmtInt(c.fields)),
        ...(c.luaExposed ? [kv(msg("lua-exposed types"), fmtInt(c.luaExposed))] : []),
        ...(c.luaMembers ? [kv(msg("lua-exposed members"), fmtInt(c.luaMembers))] : []),
        kv(msg("class refs"), fmtInt(c.classEdges)),
        kv(msg("package refs"), fmtInt(c.pkgEdges)),
        kv(msg("source size"), fmtBytes(c.bytes))
      )
    )
  );
  const support = h('div', { class: 'link-list' });
  for (const language of a.meta.languages ?? ['java']) {
    const capabilities = a.meta.languageCapabilities?.[language];
    support.append(h('div', { class: 'empty', text: `${languageName(language)} · ${msg('Structure and file dependencies')}${capabilities?.memberReferences ? ` · ${msg('Member references')}` : ''}` }));
  }
  support.append(h('div', { class: 'hint', text: msg('Static syntax analysis; macros and dynamic bindings may remain unresolved.') }));
  if (a.meta.parseErrors?.files) {
    support.append(h('div', { class: 'empty', text: msg('Syntax diagnostics in {0} files', a.meta.parseErrors.files), title: a.meta.parseErrors.names.join('\n') }));
  }
  wrap.append(section(msg('Analysis support'), support));
  const top = [...a.classes].sort((x, y) => y.code - x.code).slice(0, 10);
  const list = h('div', { class: 'link-list' });
  for (const t of top) list.append(linkRow(t, t.fqn, false, msg("{0} ln", fmtCompact(t.code))));
  wrap.append(section(msg("Largest types"), list));
  wrap.append(
    section(
      msg("Tips"),
      h('div', { class: 'empty', text: msg("Click any rectangle to inspect it. Double-click a package to zoom, right-click to zoom out. Press / to search, ? for help.") })
    )
  );
  return wrap;
}

function section(title: string, ...children: (HTMLElement | null)[]): HTMLElement {
  const el = h('div', { class: 'insp-section' }, h('h3', { text: title }));
  for (const c of children) if (c) el.append(c);
  return el;
}

