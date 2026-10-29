import { msg, trLabel } from '../i18n';
/**
 * Hierarchy view — the class inheritance forest.
 *
 * Left: the roots of the hierarchy (types with no internal supertype) ranked by
 * subtree size. Right: an expandable tree of a chosen root, with the selected
 * type revealed automatically. Interfaces implemented by a type are shown as
 * dashed children when "show interfaces" is on.
 */

import { type Atlas, type ClassRec, KIND_NAMES } from '../domain';
import { store, type AppState } from '../state';
import { fmtCompact, h, preserveInputFocus } from '../util';

const KIND_COLOR = ['#4e9de0', '#59b39a', '#c9a227', '#b07fd6', '#8d8d8d'];
const KIND_BADGE = ['C', 'I', 'E', 'R', '@'];

let atlas: Atlas | null = null;
let host: HTMLElement | null = null;
let expanded = new Set<number>();
let rootId: number | null = null;
let showInterfaces = true;
let filterText = '';
let useLuaFilter = false;
let sortMode: 'size' | 'name' | 'kind' = 'size';
let lastSelected: number | null = null;

export function initHierarchy(a: Atlas) {
  atlas = a;
  host = document.getElementById('stage-message');
}

export function renderHierarchy(state: AppState) {
  if (!atlas || !host) return;
  if (store.state.view !== 'hierarchy') return;
  const stage = document.getElementById('canvas-wrap')!;
  // reuse the canvas area with a DOM overlay
  let pane = document.getElementById('hierarchy-pane');
  if (!pane) {
    pane = h('div', { id: 'hierarchy-pane', class: 'card-grid stage-pane', style: { gridTemplateColumns: 'minmax(220px, 280px) minmax(0, 1fr)' } });
    stage.append(pane);
  }
  pane.hidden = false;
  document.getElementById('canvas')!.style.visibility = 'hidden';
  document.getElementById('stage-message')!.hidden = true;

  const sel = state.selection.classId;
  if (sel != null && sel !== lastSelected) {
    revealPath(sel);
    lastSelected = sel;
  }

  pane.replaceChildren(sidebarList(), treePane(state));
}

export function teardownHierarchy() {
  document.getElementById('hierarchy-pane')?.remove();
  const cv = document.getElementById('canvas');
  if (cv) cv.style.visibility = 'visible';
}

const subtreeSizes = new Map<number, number>();
function subtreeSize(id: number): number {
  const cached = subtreeSizes.get(id);
  if (cached != null) return cached;
  const c = atlas!.byId[id];
  if (!c) return 0;
  let n = 1;
  subtreeSizes.set(id, 1); // cycle guard
  for (const s of c.subIds) n += subtreeSize(s);
  subtreeSizes.set(id, n);
  return n;
}

function revealPath(id: number) {
  const c = atlas!.byId[id];
  if (!c) return;
  // root = topmost internal ancestor
  let top = c;
  const seen = new Set<number>();
  while (top.superIds.length && !seen.has(top.id)) {
    seen.add(top.id);
    const p = atlas!.byId[top.superIds[0]];
    if (!p) break;
    top = p;
  }
  rootId = top.id;
  // expand the chain from top to the selected type
  const chain: number[] = [];
  let cur: ClassRec | undefined = c;
  const guard = new Set<number>();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    chain.unshift(cur.id);
    cur = cur.superIds.length ? atlas!.byId[cur.superIds[0]] : undefined;
  }
  for (const cid of chain) expanded.add(cid);
}

function roots(): ClassRec[] {
  const languages = store.state.settings.filters.languages;
  const out = atlas!.classes.filter((c) => c.kind !== 5 && c.superIds.length === 0 && (!languages.length || languages.includes(c.language ?? 'java')));
  const rank = (c: ClassRec) => {
    switch (sortMode) {
      case 'name': return 0;
      case 'kind': return c.kind;
      default: return -subtreeSize(c.id);
    }
  };
  out.sort((a, b) => (sortMode === 'name' ? a.name.localeCompare(b.name) : rank(a) - rank(b) || b.code - a.code));
  return out;
}

function matches(c: ClassRec): boolean {
  if (useLuaFilter && !c.luaExposed) return false;
  if (!filterText) return true;
  const q = filterText.toLowerCase();
  return c.name.toLowerCase().includes(q) || c.fqn.toLowerCase().includes(q);
}

function hasMatchInSubtree(c: ClassRec, depth = 0): boolean {
  if (matches(c)) return true;
  if (depth > 12) return false;
  return c.subIds.some((id) => atlas!.byId[id] && hasMatchInSubtree(atlas!.byId[id], depth + 1));
}

function sidebarList(): HTMLElement {
  const panel = h('div', { class: 'card', style: { alignSelf: 'start' } });
  panel.append(
    h('h3', { text: msg("Hierarchy roots ({0})", roots().length) }),
    h(
      'div',
      { class: 'field' },
      h('input', {
        type: 'text',
        id: "hierarchy-filter",
        placeholder: msg("filter roots…"),
        value: filterText,
        oninput: (e: Event) => {
          filterText = (e.target as HTMLInputElement).value;
          // Whole-pane repaint (both the roots list and the tree follow the
          // filter), so the caret has to be put back explicitly.
          preserveInputFocus('hierarchy-filter', () => renderHierarchy(store.state));
        },
      })
    ),
    h(
      'div',
      { class: 'graph-controls', style: { marginBottom: '8px' } },
      h('label', { class: 'chk' }, h('input', {
        type: 'checkbox',
        checked: showInterfaces,
        onchange: (e: Event) => {
          showInterfaces = (e.target as HTMLInputElement).checked;
          renderHierarchy(store.state);
        },
      }), msg("interfaces")),
      h('label', { class: 'chk' }, h('input', {
        type: 'checkbox',
        checked: useLuaFilter,
        onchange: (e: Event) => {
          useLuaFilter = (e.target as HTMLInputElement).checked;
          renderHierarchy(store.state);
        },
      }), msg("lua only"))
    )
  );
  const list = h('div', { class: 'link-list' });
  for (const r of roots().filter((c) => !filterText || hasMatchInSubtree(c)).slice(0, 400)) {
    const size = subtreeSize(r.id);
    list.append(
      h(
        'div',
        {
          class: 'link',
          style: rootId === r.id ? { background: 'var(--bg-3)' } : {},
          onclick: () => {
            rootId = r.id;
            expanded.add(r.id);
            renderHierarchy(store.state);
          },
        },
        h('span', { class: 'kinddot', style: { background: KIND_COLOR[r.kind] } }),
        h('span', { class: 'nm', text: r.name }),
        h('span', { class: 'sub', text: size > 1 ? msg("{0} types", size) : msg("{0} ln", fmtCompact(r.code)) })
      )
    );
  }
  panel.append(list);
  return panel;
}

function treePane(state: AppState): HTMLElement {
  const panel = h('div', { class: 'card', style: { alignSelf: 'start', minWidth: 0 } });
  if (rootId == null || !atlas!.byId[rootId]) {
    panel.append(h('h3', { text: msg("Pick a root") }), h('div', { class: 'empty', text: msg("Select a hierarchy root on the left, or search for a class.") }));
    return panel;
  }
  const root = atlas!.byId[rootId];
  panel.append(
    h('h3', { text: msg("Inheritance tree · {0}", root.fqn) }),
    h('div', { class: 'sub', text: msg("{0} types in this hierarchy · click a name to inspect, caret to expand", subtreeSize(root.id)) })
  );
  const tree = h('div', { class: 'member-list', style: { lineHeight: '1.7' } });
  renderNode(tree, root, 0, state, new Set());
  panel.append(tree);
  return panel;
}

function renderNode(container: HTMLElement, c: ClassRec, depth: number, state: AppState, seen: Set<number>) {
  if (seen.has(c.id) || depth > 24) return;
  const nextSeen = new Set(seen);
  nextSeen.add(c.id);

  const subs = c.subIds.map((id) => atlas!.byId[id]).filter(Boolean).filter((s) => !filterText || hasMatchInSubtree(s));
  const ifaces = showInterfaces ? c.ifaceIds.map((id) => atlas!.byId[id]).filter(Boolean) : [];
  const isOpen = expanded.has(c.id);
  const isSel = state.selection.classId === c.id;

  const row = h(
    'div',
    {
      style: {
        display: 'flex',
        gap: '5px',
        alignItems: 'baseline',
        paddingLeft: `${depth * 15}px`,
        background: isSel ? 'color-mix(in srgb, var(--accent) 16%, transparent)' : '',
        borderRadius: '3px',
        cursor: 'pointer',
      },
    },
    h('span', {
      style: { width: '11px', display: 'inline-block', color: 'var(--fg-3)', userSelect: 'none' },
      text: subs.length || ifaces.length ? (isOpen ? '▾' : '▸') : '·',
      onclick: (e: Event) => {
        e.stopPropagation();
        if (isOpen) expanded.delete(c.id);
        else expanded.add(c.id);
        renderHierarchy(store.state);
      },
    }),
    h('span', {
      class: 'badge',
      style: { borderColor: KIND_COLOR[c.kind], color: KIND_COLOR[c.kind], fontSize: '9px', padding: '0 3px' },
      text: KIND_BADGE[c.kind],
    }),
    h('span', {
      class: 'm-name',
      style: { color: isSel ? 'var(--accent)' : 'var(--fg-0)', fontWeight: isSel ? 600 : 400 },
      text: c.name,
      title: `${trLabel(KIND_NAMES[c.kind])} · ${c.fqn}\n${c.doc ?? ''}`,
      onclick: (e: Event) => {
        e.stopPropagation();
        store.update((s) => {
          s.selection.classId = c.id;
        });
      },
    }),
    h('span', { class: 'm-type', style: { color: 'var(--fg-3)', fontSize: '10.5px' }, text: msg("{0} ln", fmtCompact(c.code)) }),
    c.luaExposed ? h('span', { class: 'badge lua', style: { fontSize: '9px' }, text: msg("lua") }) : null,
    subs.length ? h('span', { style: { color: 'var(--fg-3)', fontSize: '10.5px' }, text: `+${subs.length}` }) : null
  );
  container.append(row);

  if (!isOpen) return;
  for (const s of subs) renderNode(container, s, depth + 1, state, nextSeen);
  for (const i of ifaces) {
    container.append(
      h(
        'div',
        {
          style: {
            display: 'flex',
            gap: '5px',
            alignItems: 'baseline',
            paddingLeft: `${(depth + 1) * 15}px`,
            color: 'var(--fg-2)',
            cursor: 'pointer',
          },
        },
        h('span', { style: { width: '11px', color: 'var(--fg-3)' }, text: '⟶' }),
        h('span', { class: 'badge', style: { fontSize: '9px', padding: '0 3px' }, text: 'I' }),
        h('span', {
          class: 'm-name',
          style: { color: 'var(--fg-2)' },
          text: i.name,
          onclick: (e: Event) => {
            e.stopPropagation();
            store.update((s) => {
              s.selection.classId = i.id;
            });
          },
        }),
        h('span', { style: { fontSize: '10px', color: 'var(--fg-3)' }, text: msg("implements") })
      )
    );
  }
}

/** Side summary used by the status bar. */
export function hierarchyStats(): string {
  if (!atlas) return '';
  const roots = atlas.classes.filter((c) => c.superIds.length === 0).length;
  const ifaceImpls = atlas.classes.reduce((a, c) => a + c.ifaceIds.length, 0);
  return msg("{0} roots · {1} implements edges", roots, ifaceImpls);
}
