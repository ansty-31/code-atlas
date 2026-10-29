import { languageName, languageColor } from './shared/languages.mjs';
import { render } from 'solid-js/web';
import { msg, trLabel, initLanguage } from './i18n';
/**
 * Zombie Atlas — application bootstrap.
 *
 * Renders the shell (see `app/app.tsx`), then wires the store, the views, the
 * customisation sidebar, search, breadcrumbs and the render loop together.
 * Everything the UI shows is derived from the JSON bundle produced by
 * `tools/extract.mjs`.
 *
 * The shell mounts *before* `initLanguage()` runs, because that wires the
 * language `<select>` by id and the element has to exist first.
 */

import './styles.css';
import { App } from './app/app';
import {
  type Atlas,
  type ClassRec,
  KIND_NAMES,
  KIND_COLORS,
  metricValue,
  METRIC_KEYS,
  type MetricKey,
  loadAtlas,
} from './domain';
import { store, searchAtlas, type AppState, type Settings, type ViewId, applyFilters } from './state';
import { TreemapView, type TNode } from './views/treemap';
import { initHierarchy, renderHierarchy, teardownHierarchy, hierarchyStats } from './views/hierarchy';
import {
  initDependencies,
  renderDependencies,
  teardownDependencies,
  dependenciesControls,
  frameDependencies,
  resizeDependencies,
  depDebug,
} from './views/dependencies';
import { initSubsystems, renderSubsystems, teardownSubsystems } from './views/subsystems';
import { initInsights, renderInsights, teardownInsights } from './views/insights';
import { initInspector, render as renderInspector, setMemberCache } from './views/inspector';
import { $, debounce, fmtCompact, fmtInt, h, hashFor, sampleRamp, timeAgo } from './util';

const VIEWS: { id: ViewId; label: string; hint: string }[] = [
  { id: 'treemap', label: msg("Treemap"), hint: msg("Nested rectangles: packages → types → members") },
  { id: 'hierarchy', label: msg("Hierarchy"), hint: msg("Class inheritance forest") },
  { id: 'dependencies', label: msg("Dependencies"), hint: msg("Package and class reference graph") },
  { id: 'subsystems', label: msg("Subsystems"), hint: msg("Functional domains of the engine") },
  { id: 'insights', label: msg("Insights"), hint: msg("Rankings and distributions") },
];

let atlas: Atlas;
let treemap: TreemapView;
let currentHover: TNode | null = null;
let memberNames = new Map<number, string[]>();

/** ------------------------------------------------------------------ boot -- */

async function boot() {
  const status = $('#statusbar');
  status.textContent = msg("loading dataset…");
  try {
    atlas = await loadAtlas('data');
  } catch (err) {
    showMessage(
      msg("Failed to load the dataset ({0}).\n\nBuild it with \"npm run data\" and serve the app with \"npm run serve\".", (err as Error).message)
    );
    return;
  }

  store.state.atlas = atlas;
  store.state.ready = true;
  store.applyUrl(atlas);

  document.documentElement.dataset.theme = store.state.settings.theme;
  $('#brand-sub').textContent = msg("{0} files · {1} types · {2}", atlas.meta.counts.files, fmtInt(atlas.meta.counts.types), timeAgo(atlas.meta.generated));

  treemap = new TreemapView($('#canvas-wrap'), {
    onSelect: (n) => {
      store.update((s) => {
        if (!n) {
          s.selection.classId = null;
          s.selection.packagePath = null;
        } else if (n.classId != null) {
          s.selection.classId = n.classId ?? null;
          s.selection.packagePath = null;
        } else {
          s.selection.packagePath = n.pkg ?? null;
          s.selection.classId = null;
        }
      });
      if (n?.classId != null) void treemap.ensureMembers(store.state).then((ok) => ok && syncMembers());
    },
    onZoom: (path) => {
      store.update((s) => {
        s.selection.zoom = path;
      });
    },
  });

  initInspector(atlas);
  initHierarchy(atlas);
  initDependencies(atlas, $('#canvas-wrap'));
  initSubsystems(atlas);
  void initInsights(atlas);

  buildTabs();
  buildControls();
  bindSearch();
  bindKeys();
  bindHelp();

  window.addEventListener('resize', debounce(() => onResize(), 60));

  store.subscribe(onStateChange);
  onStateChange(store.state);
  requestAnimationFrame(loop);

  // Debug/automation handle: everything the UI knows is reachable from here.
  (window as unknown as Record<string, unknown>).zombieAtlas = {
    store,
    atlas,
    treemap,
    view: () => store.state.view,
    deps: depDebug,
  };
}

function showMessage(text: string) {
  const el = $('#stage-message');
  el.hidden = false;
  el.textContent = text;
}

/** -------------------------------------------------------------- rendering -- */

function onStateChange(s: AppState, opts: { skipControls?: boolean } = {}) {
  if (!s.atlas) return;
  renderTabs(s);
  if (!opts.skipControls) renderControls(s);
  renderLegend(s);
  renderBreadcrumbs(s);
  renderInspector(s);
  renderStatus(s);

  document.documentElement.dataset.theme = s.settings.theme;

  // view switching
  for (const v of ['hierarchy', 'dependencies', 'subsystems', 'insights'] as const) {
    if (s.view !== v) teardown(v);
  }
  const wrap = $('#canvas-wrap');
  (wrap.querySelector('#canvas') as HTMLCanvasElement).style.visibility = 'visible';
  $('#tooltip')!.hidden = true;

  switch (s.view) {
    case 'treemap':
      treemap.setSettings(s.settings, s.selection.classId);
      treemap.setZoom(s.selection.zoom);
      treemap.update(s);
      void maybeLoadMembers(s);
      break;
    case 'hierarchy':
      renderHierarchy(s);
      break;
    case 'dependencies':
      renderDependencies(s);
      break;
    case 'subsystems':
      renderSubsystems(s);
      break;
    case 'insights':
      renderInsights(s);
      break;
  }
  renderStageActions(s);
  renderEmptyState(s);
  store.saveSettings();
}

function teardown(v: 'hierarchy' | 'dependencies' | 'subsystems' | 'insights') {
  if (v === 'hierarchy') teardownHierarchy();
  if (v === 'dependencies') teardownDependencies();
  if (v === 'subsystems') teardownSubsystems();
  if (v === 'insights') teardownInsights();
}

let memberLoadKey = '';
async function maybeLoadMembers(s: AppState) {
  const key = `${s.settings.showMembers}|${s.settings.filters.query}|${s.selection.zoom.join(',')}`;
  if (key === memberLoadKey) return;
  memberLoadKey = key;
  const ok = await treemap.ensureMembers(s);
  if (ok) syncMembers();
}

function syncMembers() {
  const map = (treemap as unknown as { memberLists: Map<number, { name: string }[]> }).memberLists;
  if (!map) return;
  const names = new Map<number, string[]>();
  const full = new Map<number, never[]>();
  for (const [id, list] of map) {
    names.set(id, list.map((m) => m.name.toLowerCase()));
    full.set(id, list as never[]);
  }
  memberNames = names;
  setMemberCache(full as never);
  treemap.invalidate();
  treemap.update(store.state);
  renderInspector(store.state);
}

function loop() {
  // The treemap and the force graph share one canvas, so only the active view
  // is allowed to paint into it.
  if (store.state.view === 'dependencies') frameDependencies();
  else treemap.frame();
  requestAnimationFrame(loop);
}

function onResize() {
  treemap.resize();
  treemap.update(store.state);
  if (store.state.view === 'dependencies') {
    ($('#canvas-wrap').querySelector('canvas') as HTMLCanvasElement).style.visibility = 'visible';
    renderDependencies(store.state);
    resizeDependencies();
  }
}

/** ------------------------------------------------------------------ tabs -- */

function buildTabs() {
  const nav = $('#tabs');
  nav.replaceChildren(
    ...VIEWS.map((v) =>
      h('button', {
        role: 'tab',
        'data-view': v.id,
        title: v.hint,
        text: v.label,
        onclick: () =>
          store.update((s) => {
            s.view = v.id;
          }),
      })
    )
  );
}

function renderTabs(s: AppState) {
  for (const b of $('#tabs').querySelectorAll<HTMLButtonElement>('button')) {
    b.setAttribute('aria-selected', String(b.dataset.view === s.view));
  }
}

/** -------------------------------------------------------------- controls -- */

function field(label: string, control: HTMLElement | null, hint?: string): HTMLElement {
  return h('div', { class: 'field' }, h('label', { text: label }), control, hint ? h('div', { class: 'hint', text: hint }) : null);
}

function select<T extends string>(value: T, options: [T, string][], onChange: (v: T) => void): HTMLSelectElement {
  const el = h(
    'select',
    { onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value as T) },
    ...options.map(([v, label]) => h('option', { value: v, selected: v === value, text: label }))
  );
  return el;
}

function buildControls() {
  $('#btn-settings').addEventListener('click', () => {
    store.update((s) => {
      s.settings.sidebar = !s.settings.sidebar;
    });
  });
  $('#btn-theme').addEventListener('click', () => {
    store.update((s) => {
      s.settings.theme = s.settings.theme === 'dark' ? 'light' : 'dark';
    });
  });
}

function renderControls(s: AppState) {
  const host = $('#controls');
  const set = s.settings;
  const wrap = h('div');

  // The query can come from a permalink or from persisted settings, in which
  // case the box would otherwise look empty while the map is filtered.
  const searchEl = $('#search') as HTMLInputElement;
  if (document.activeElement !== searchEl && searchEl.value !== set.filters.query) {
    searchEl.value = set.filters.query;
  }
  const upd = (fn: (x: Settings) => void) =>
    store.update((x) => {
      fn(x.settings);
    });

  wrap.append(
    field(
      msg("Size metric"),
      select(
        set.sizeMetric,
        [
          ['code', msg("Code lines (non-comment)")],
          ['loc', msg("Total lines")],
          ['bytes', msg("File size")],
          ['methods', msg("Method count")],
          ['fields', msg("Field count")],
          ['members', msg("Members")],
          ['complexity', msg("Cyclomatic complexity")],
          ['fanIn', msg("Fan-in (used by)")],
          ['fanOut', msg("Fan-out (uses)")],
          ...(atlas.classes.some((entity) => entity.luaExposed) ? [['luaWeight', msg("Lua exposure")]] as [string, string][] : []),
          ['density', msg("Branch density")],
          ['composite', msg("Custom composite…")],
        ],
        (v) => upd((x) => (x.sizeMetric = v as MetricKey))
      ),
      msg("Area of each rectangle")
    )
  );

  if (set.sizeMetric === 'composite') {
    const box = h('div', { style: { marginBottom: '9px' } });
    for (const k of ['code', 'complexity', 'methods', 'fanIn', 'luaWeight', 'bytes'] as const) {
      const val = set.weights[k] ?? 0;
      box.append(
        h(
          'div',
          { class: 'field' },
          h('label', { text: `${trLabel(k)} — ${val.toFixed(2)}` }),
          h('input', {
            type: 'range',
            min: '0',
            max: '1',
            step: '0.05',
            value: String(val),
            oninput: (e: Event) => {
              const v = Number((e.target as HTMLInputElement).value);
              (e.target as HTMLInputElement).previousElementSibling!.textContent = `${trLabel(k)} — ${v.toFixed(2)}`;
              upd((x) => (x.weights[k] = v));
            },
          })
        )
      );
    }
    wrap.append(box);
  }

  wrap.append(
    field(
      msg("Colour by"),
      select(
        set.colorMode,
        [
          ['domain', msg("Functional domain")],
          ['language', msg('languages')],
          ['package', msg("Package")],
          ['kind', msg("Declaration kind")],
          ['stereotype', msg("Stereotype")],
          ['fanIn', msg("Fan-in (heat)")],
          ['fanOut', msg("Fan-out (heat)")],
          ['complexity', msg("Complexity (heat)")],
          ['density', msg("Branch density (heat)")],
          ...(atlas.classes.some((entity) => entity.luaExposed) ? [['lua', msg("Lua exposure")]] as [string, string][] : []),
          ['depth', msg("Nesting depth")],
        ],
        (v) => upd((x) => (x.colorMode = v as Settings['colorMode']))
      )
    )
  );

  wrap.append(
    field(
      msg("Group by"),
      select(
        set.groupBy,
        [
          ['package', msg("Package hierarchy")],
          ['domain', msg("Functional domain")],
          ['stereotype', msg("Stereotype")],
          ['kind', msg("Declaration kind")],
          ['stereotype+package', msg("Stereotype → domain")],
        ],
        (v) => upd((x) => (x.groupBy = v as Settings['groupBy']))
      )
    )
  );

  wrap.append(
    h(
      'div',
      { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } },
      field(
        msg("Layout"),
        select(
          set.layout,
          [
            ['squarify', msg("Squarified")],
            ['sliceDice', msg("Slice & dice")],
            ['binary', msg("Binary")],
            ['strip', msg("Strips (slice)")],
          ],
          (v) => upd((x) => (x.layout = v as Settings['layout']))
        )
      ),
      field(
        msg("Sort"),
        select(
          set.sort,
          [
            ['size', msg("Size")],
            ['name', msg("Name")],
            ['fanIn', msg("Fan-in")],
            ['complexity', msg("Complexity")],
          ],
          (v) => upd((x) => (x.sort = v as Settings['sort']))
        )
      )
    )
  );

  wrap.append(
    h(
      'div',
      { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } },
      field(
        msg("Depth limit {0}", set.depthLimit || '∞'),
        h('input', {
          type: 'range',
          min: '0',
          max: '6',
          value: String(set.depthLimit),
          oninput: (e: Event) => upd((x) => (x.depthLimit = Number((e.target as HTMLInputElement).value))),
        })
      ),
      field(
        msg("Padding {0}px", set.padding),
        h('input', {
          type: 'range',
          min: '0',
          max: '8',
          value: String(set.padding),
          oninput: (e: Event) => upd((x) => (x.padding = Number((e.target as HTMLInputElement).value))),
        })
      )
    )
  );

  wrap.append(
    field(
      msg("Hide below {0}% of total", (set.minShare * 100).toFixed(1)),
      h('input', {
        type: 'range',
        min: '0',
        max: '1',
        step: '0.001',
        value: String(set.minShare),
        oninput: (e: Event) => upd((x) => (x.minShare = Number((e.target as HTMLInputElement).value))),
      }),
      msg("Culls tiny rectangles — useful on huge trees")
    )
  );

  wrap.append(
    h(
      'div',
      {},
      checkbox(msg("Show members as leaves"), set.showMembers, (v) => upd((x) => (x.showMembers = v)), msg("Zoom into a package for best results")),
      ...(atlas.classes.some((c) => c.luaExposed) ? [checkbox(msg("Only @UsedFromLua types"), set.filters.luaOnly, (v) =>
        upd((x) => {
          x.filters.luaOnly = v;
        })
      )] : []),
      checkbox(msg("Labels"), set.labelMode !== 'never', (v) => upd((x) => (x.labelMode = v ? 'auto' : 'never')))
    )
  );

  // ---- filters
  const languageChips = h('div', { class: 'chips' });
  for (const language of atlas.meta.languages ?? ['java']) {
    const on = set.filters.languages.includes(language);
    const count = atlas.classes.filter((entity) => (entity.language ?? 'java') === language).length;
    languageChips.append(h('button', {
      class: `chip${on ? ' on' : ''}`,
      text: `${languageName(language)} ${count}`,
      'aria-pressed': String(on),
      onclick: () => upd((settings) => {
        settings.filters.languages = on ? settings.filters.languages.filter((value) => value !== language) : [...settings.filters.languages, language];
      }),
    }));
  }
  wrap.append(field(msg('languages'), languageChips));
  const stereoCounts = new Map<string, number>();
  for (const c of atlas.classes) stereoCounts.set(c.stereotype, (stereoCounts.get(c.stereotype) ?? 0) + 1);
  const topStereos = [...stereoCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);

  const kindChips = h('div', { class: 'chips' });
  KIND_NAMES.forEach((k, i) => {
    if (!atlas.classes.some((entity) => entity.kind === i)) return;
    const on = set.filters.kinds.includes(i);
    kindChips.append(
      h('span', {
        class: `chip${on ? ' on' : ''}`,
        text: trLabel(k),
        onclick: () =>
          upd((x) => {
            x.filters.kinds = on ? x.filters.kinds.filter((v) => v !== i) : [...x.filters.kinds, i];
          }),
      })
    );
  });

  const stereoChips = h('div', { class: 'chips' });
  for (const [st, n] of topStereos) {
    const on = set.filters.stereotypes.includes(st);
    stereoChips.append(
      h('span', {
        class: `chip${on ? ' on' : ''}`,
        text: `${trLabel(st)} ${n}`,
        onclick: () =>
          upd((x) => {
            x.filters.stereotypes = on ? x.filters.stereotypes.filter((v) => v !== st) : [...x.filters.stereotypes, st];
          }),
      })
    );
  }

  const domainChips = h('div', { class: 'chips', style: { maxHeight: '120px', overflow: 'auto' } });
  for (const d of atlas.domains) {
    const on = set.filters.domains.includes(d.key);
    domainChips.append(
      h('span', {
        class: `chip${on ? ' on' : ''}`,
        style: { borderColor: on ? d.color : '', color: on ? d.color : '' },
        text: d.key,
        title: msg("{0} types · {1} lines", d.metrics.types, fmtCompact(d.metrics.code)),
        onclick: () =>
          upd((x) => {
            x.filters.domains = on ? x.filters.domains.filter((v) => v !== d.key) : [...x.filters.domains, d.key];
          }),
      })
    );
  }

  wrap.append(
    field(msg("Kind"), kindChips),
    field(msg("Stereotype"), stereoChips),
    field(msg("Domain ({0})", atlas.domains.length), domainChips),
    field(
      msg("Minimum code lines"),
      h('input', {
        type: 'number',
        min: '0',
        value: String(set.filters.minCode),
        onchange: (e: Event) =>
          upd((x) => {
            x.filters.minCode = Math.max(0, Number((e.target as HTMLInputElement).value));
          }),
      })
    )
  );
  const activeFilters =
    set.filters.languages.length + set.filters.kinds.length + set.filters.stereotypes.length + set.filters.domains.length + (set.filters.luaOnly ? 1 : 0) + (set.filters.query ? 1 : 0) + (set.filters.minCode ? 1 : 0);
  if (activeFilters) {
    wrap.append(
      h('button', {
        text: msg(activeFilters === 1 ? "Clear {0} filter" : "Clear {0} filters", activeFilters),
        style: { width: '100%', padding: '4px', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', cursor: 'pointer' },
        onclick: () =>
          store.update((x) => {
            x.settings.filters = { query: '', kinds: [], languages: [], stereotypes: [], domains: [], luaOnly: false, minCode: 0 };
            x.selection.zoom = [];
            ($('#search') as HTMLInputElement).value = '';
          }),
      })
    );
  }

  // ---- persistence footer
  const report = store.storage;
  const resetBtn = h('button', {
    text: msg("Restore defaults"),
    title: msg("Discard every saved setting and write the defaults back to localStorage"),
    style: {
      width: '100%', padding: '4px', background: 'var(--bg-2)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius)', cursor: 'pointer', color: 'var(--fg-1)',
    },
    onclick: (e: Event) => {
      store.resetSettings();
      const btn = e.target as HTMLButtonElement;
      btn.textContent = msg("✓ defaults restored");
      setTimeout(() => (btn.textContent = msg("Restore defaults")), 1400);
    },
  });

  const storageNote =
    report.status === 'missing' ? msg("No saved settings found — defaults written.")
    : report.status === 'repaired' ? msg(report.repairs.length === 1 ? "Saved settings repaired on load ({0} field)." : "Saved settings repaired on load ({0} fields).", report.repairs.length)
    : report.status === 'unavailable' ? msg("localStorage is unavailable — settings will not persist.")
    : null;

  wrap.append(
    h(
      'div',
      { class: 'field', style: { marginTop: '12px', paddingTop: '10px', borderTop: '1px solid var(--border-soft)' } },
      resetBtn,
      h('div', {
        class: 'hint',
        title: report.repairs.join('\n'),
        text: storageNote ?? msg("Saved in localStorage as {0}.", 'zombie-atlas.settings.v1'),
      })
    )
  );

  host.replaceChildren(wrap);
}

function checkbox(label: string, checked: boolean, onChange: (v: boolean) => void, hint?: string): HTMLElement {
  return h(
    'label',
    { class: 'chk', title: hint ?? '' },
    h('input', { type: 'checkbox', checked, onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked) }),
    label
  );
}

/** ---------------------------------------------------------------- legend -- */

function renderLegend(s: AppState) {
  const host = $('#legend');
  const wrap = h('div');
  const mode = s.settings.colorMode;
  const numeric = ['fanIn', 'fanOut', 'complexity', 'density'];

  if (numeric.includes(mode)) {
    const grad = h('div', { class: 'legend-gradient' });
    const stops: string[] = [];
    for (let i = 0; i <= 10; i++) stops.push(sampleRamp(s.settings.palette, i / 10));
    grad.style.background = `linear-gradient(90deg, ${stops.join(',')})`;
    wrap.append(
      h('div', { style: { fontSize: '11px', color: 'var(--fg-2)', marginBottom: '4px' }, text: msg("low → high {0}", trLabel(mode)) }),
      h('div', { class: 'legend-scale' }, h('span', { text: '0' }), grad, h('span', { text: fmtInt(atlas.max[mode] ?? 0) })),
      h('div', { class: 'hint', style: { marginTop: '8px' }, text: msg("Scale is √-compressed so mid-range values stay readable.") })
    );
  } else if (mode === 'language') {
    for (const language of atlas.meta.languages ?? ['java']) {
      wrap.append(h('div', { class: 'legend-item' },
        h('span', { class: 'sw', style: { background: languageColor(language) } }),
        languageName(language),
        h('span', { class: 'cnt', text: fmtInt(atlas.classes.filter((entity) => (entity.language ?? 'java') === language).length) })));
    }
  } else if (mode === 'kind') {
    KIND_NAMES.forEach((k, i) => {
      const n = atlas.classes.filter((c) => c.kind === i).length;
      if (!n) return;
      wrap.append(
        h(
          'div',
          { class: 'legend-item' },
          h('span', { class: 'sw', style: { background: KIND_COLORS.dark[i] } }),
          trLabel(k),
          h('span', { class: 'cnt', text: fmtInt(n) })
        )
      );
    });
  } else if (mode === 'stereotype') {
    const counts = new Map<string, number>();
    for (const c of atlas.classes) counts.set(c.stereotype, (counts.get(c.stereotype) ?? 0) + 1);
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([st, n]) => {
        wrap.append(
          h(
            'div',
            { class: 'legend-item' },
            h('span', { class: 'sw', style: { background: sampleRamp(s.settings.palette, (hashFor(st) % 100) / 100) } }),
            trLabel(st),
            h('span', { class: 'cnt', text: fmtInt(n) })
          )
        );
      });
  } else if (mode === 'lua') {
    wrap.append(
      h('div', { class: 'legend-item' }, h('span', { class: 'sw', style: { background: '#c586c0' } }), '@UsedFromLua', h('span', { class: 'cnt', text: fmtInt(atlas.meta.counts.luaExposed) })),
      h('div', { class: 'legend-item' }, h('span', { class: 'sw', style: { background: '#39414f' } }), msg("not exposed"), h('span', { class: 'cnt', text: fmtInt(atlas.classes.length - atlas.meta.counts.luaExposed) }))
    );
  } else {
    const list = mode === 'package' ? atlas.domains.slice().sort((a, b) => b.metrics.code - a.metrics.code) : atlas.domains;
    for (const d of list) {
      const on = s.settings.filters.domains.includes(d.key);
      wrap.append(
        h(
          'div',
          {
            class: `legend-item${on ? '' : ''}`,
            title: trLabel(d.label),
            onclick: () =>
              store.update((x) => {
                x.settings.filters.domains = on
                  ? x.settings.filters.domains.filter((v) => v !== d.key)
                  : [...x.settings.filters.domains, d.key];
              }),
          },
          h('span', { class: 'sw', style: { background: d.color } }),
          d.key,
          h('span', { class: 'cnt', text: fmtInt(d.metrics.types) })
        )
      );
    }
    wrap.append(h('div', { class: 'hint', style: { marginTop: '8px' }, text: msg("Click a domain to filter the map.") }));
  }
  host.replaceChildren(wrap);
}

/** ----------------------------------------------------------- breadcrumbs -- */

function renderBreadcrumbs(s: AppState) {
  const host = $('#breadcrumbs');
  const crumbs: HTMLElement[] = [];
  const mk = (label: string, last: boolean, onClick: () => void) =>
    h('button', { class: `crumb${last ? ' last' : ''}`, text: label, onclick: onClick });

  const zoom = s.selection.zoom;
  crumbs.push(
    mk(atlas.meta.sourceRoot, zoom.length === 0, () =>
      store.update((x) => {
        x.selection.zoom = [];
      })
    )
  );
  zoom.forEach((id, i) => {
    crumbs.push(h('span', { class: 'sep', text: '›' }));
    const rawLabel = id.replace(/^[a-z]+:/, '');
    const label = /^(k|st):/.test(id) ? trLabel(rawLabel) : rawLabel;
    crumbs.push(
      mk(label, i === zoom.length - 1, () =>
        store.update((x) => {
          x.selection.zoom = zoom.slice(0, i + 1);
        })
      )
    );
  });
  if (s.selection.classId != null) {
    const c = atlas.byId[s.selection.classId];
    if (c) {
      crumbs.push(h('span', { class: 'sep', text: '·' }));
      crumbs.push(h('span', { class: 'crumb last', style: { color: 'var(--accent)' }, text: c.name }));
    }
  }
  host.replaceChildren(...crumbs);
}

/** --------------------------------------------------------- stage actions -- */

/** Human-readable summary of every active filter, for the empty state. */
function activeFilterSummary(s: AppState): string {
  const f = s.settings.filters;
  const bits: string[] = [];
  if (f.query) bits.push(msg("query \"{0}\"", f.query));
  if (f.domains.length) bits.push(msg("domains: {0}", f.domains.join(', ')));
  if (f.languages.length) bits.push(`${msg('languages')}: ${f.languages.join(', ')}`);
  if (f.kinds.length) bits.push(msg("kinds: {0}", f.kinds.map((k) => trLabel(KIND_NAMES[k])).join(', ')));
  if (f.stereotypes.length) bits.push(msg("stereotypes: {0}", f.stereotypes.map(trLabel).join(', ')));
  if (f.luaOnly) bits.push(msg("only @UsedFromLua types"));
  if (f.minCode) bits.push(msg("at least {0} code lines", f.minCode));
  return bits.join('  ·  ');
}

/**
 * Filters that exclude everything used to leave a blank canvas with no
 * explanation, which is indistinguishable from a broken app.
 */
function renderEmptyState(s: AppState) {
  const box = $('#empty-state');
  const isEmpty = s.view === 'treemap' && treemap.isEmpty;
  box.hidden = !isEmpty;
  if (!isEmpty) return;

  const why = activeFilterSummary(s);
  const card = h(
    'div',
    { class: 'empty-state-card' },
    h('h3', { text: why ? msg("No types match the current filters") : msg("Nothing to draw at this zoom level") }),
    h('p', {
      text: why
        ? msg("The treemap is empty because every type was filtered out.")
        : msg("Every rectangle here was culled by the \"hide below % of total\" setting."),
    }),
    why ? h('div', { class: 'why', text: why }) : null,
    h(
      'div',
      { class: 'empty-state-actions' },
      why
        ? h('button', {
            class: 'primary',
            text: msg("Clear filters"),
            onclick: () =>
              store.update((x) => {
                x.settings.filters = { query: '', kinds: [], languages: [], stereotypes: [], domains: [], luaOnly: false, minCode: 0 };
                ($('#search') as HTMLInputElement).value = '';
              }),
          })
        : null,
      h('button', {
        text: msg("Reset view"),
        onclick: () =>
          store.update((x) => {
            x.settings.filters = { query: '', kinds: [], languages: [], stereotypes: [], domains: [], luaOnly: false, minCode: 0 };
            x.settings.minShare = 0;
            x.settings.depthLimit = 0;
            x.selection = { classId: null, packagePath: null, hoverId: null, zoom: [] };
            ($('#search') as HTMLInputElement).value = '';
          }),
      })
    )
  );
  box.replaceChildren(card);
}

function renderStageActions(s: AppState) {
  const host = $('#stage-actions');
  const actions: HTMLElement[] = [];

  if (s.view === 'treemap') {
    actions.push(
      h('div', { class: 'toggle-group' }, ...[
        ['squarify', msg("Squarified")],
        ['sliceDice', msg("Slice")],
        ['binary', msg("Binary")],
      ].map(([k, label]) =>
        h('button', {
          class: s.settings.layout === k ? 'on' : '',
          text: label,
          onclick: () =>
            store.update((x) => {
              x.settings.layout = k as Settings['layout'];
            }),
        })
      ))
    );
    actions.push(
      h('button', {
        text: s.settings.showMembers ? msg("Leaves: members") : msg("Leaves: types"),
        onclick: () =>
          store.update((x) => {
            x.settings.showMembers = !x.settings.showMembers;
          }),
      })
    );
    if (s.selection.zoom.length) {
      actions.push(
        h('button', {
          text: msg("↑ Up"),
          onclick: () =>
            store.update((x) => {
              x.selection.zoom = x.selection.zoom.slice(0, -1);
            }),
        }),
        h('button', {
          text: msg("⌂ Root"),
          onclick: () =>
            store.update((x) => {
              x.selection.zoom = [];
            }),
        })
      );
    }
    actions.push(
      h('button', {
        text: 'PNG',
        title: msg("Download the current view as PNG"),
        onclick: exportPng,
      }),
      h('button', {
        text: 'JSON',
        title: msg("Download the visible tree as JSON"),
        onclick: exportJson,
      })
    );
  }

  if (s.view === 'dependencies') actions.push(dependenciesControls(s));
  if (s.view === 'hierarchy') {
    actions.push(
      h('button', { text: msg("Collapse all"), onclick: () => collapseHierarchy() }),
      h('button', { text: msg("Expand two levels"), onclick: () => expandHierarchy() })
    );
  }

  const perma = h('button', { text: msg("🔗 Permalink"), title: msg("Copy a shareable link to this exact view") });
  perma.addEventListener('click', () => {
    store.syncUrl();
    navigator.clipboard?.writeText(location.href);
    perma.textContent = msg("✓ copied");
    setTimeout(() => (perma.textContent = msg("🔗 Permalink")), 1200);
  });
  actions.push(perma);
  host.replaceChildren(...actions);
}

function collapseHierarchy() {
  store.update((s) => {
    s.selection.zoom = s.selection.zoom; // no-op, forces rerender
  });
  // collapse state lives in the hierarchy view; re-render applies it
  document.dispatchEvent(new CustomEvent('atlas:collapse'));
  renderHierarchy(store.state);
}

function expandHierarchy() {
  document.dispatchEvent(new CustomEvent('atlas:expand'));
  renderHierarchy(store.state);
}

function exportPng() {
  const cv = $('#canvas') as HTMLCanvasElement;
  cv.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `zombie-atlas-${store.state.settings.sizeMetric}-${store.state.settings.colorMode}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
}

function exportJson() {
  const s = store.state;
  const { ids } = applyFilters(atlas, s.settings, memberNames);
  const payload = {
    generated: new Date().toISOString(),
    source: atlas.meta.sourceRoot,
    metric: s.settings.sizeMetric,
    colorMode: s.settings.colorMode,
    groupBy: s.settings.groupBy,
    zoom: s.selection.zoom,
    filters: s.settings.filters,
    types: [...ids].map((id) => {
      const c = atlas.byId[id];
      return {
        fqn: c.fqn,
        kind: KIND_NAMES[c.kind],
        stereotype: c.stereotype,
        package: c.pkg,
        code: c.code,
        methods: c.methods,
        fields: c.fields,
        complexity: c.complexity,
        fanIn: c.fanIn,
        fanOut: c.fanOut,
        luaExposed: c.luaExposed,
        extends: c.superIds.map((i) => atlas.byId[i]?.fqn).filter(Boolean),
        implements: c.ifaceIds.map((i) => atlas.byId[i]?.fqn).filter(Boolean),
        path: c.path,
      };
    }),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'zombie-atlas-selection.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** ---------------------------------------------------------------- search -- */

function bindSearch() {
  const input = $('#search') as HTMLInputElement;
  const results = $('#search-results');
  let items: ReturnType<typeof searchAtlas> = [];
  let active = 0;

  const close = () => {
    results.hidden = true;
  };

  /** Rebuild the result rows (only when the query changed). */
  const paint = () => {
    if (!items.length) {
      results.replaceChildren(h('div', { class: 'sr-empty', text: msg("No matches") }));
      results.hidden = false;
      return;
    }
    results.replaceChildren(
      ...items.map((it, i) =>
        h(
          'div',
          {
            class: `sr-item${i === active ? ' active' : ''}`,
            onclick: () => choose(it),
            // hovering only moves the highlight — rebuilding the row here would
            // detach the hovered node and retrigger mouseenter forever
            onmouseenter: () => setActive(i),
          },
          h('span', { class: 'sr-kind', text: trLabel(it.type) }),
          h('span', { class: 'sr-name', text: it.name }),
          h('span', { class: 'sr-pkg', text: it.sub }),
          h('span', { class: 'sr-meta', text: it.meta })
        )
      )
    );
    results.hidden = false;
  };

  /** Move the keyboard/hover highlight without touching the DOM structure. */
  const setActive = (i: number) => {
    active = i;
    const rows = results.querySelectorAll('.sr-item');
    rows.forEach((el, k) => el.classList.toggle('active', k === i));
  };

  const choose = (hit: (typeof items)[number]) => {
    close();
    input.blur();
    store.update((s) => {
      if (hit.type === 'class' && hit.id != null) {
        s.selection.classId = hit.id;
        s.selection.packagePath = null;
        void treemap.ensureMembers(s).then((ok) => ok && syncMembers());
      } else {
        s.selection.packagePath = hit.sub;
        s.selection.classId = null;
        s.view = 'treemap';
        s.selection.zoom = hit.sub.split('.').map((_, i, arr) => `p:${arr.slice(0, i + 1).join('.')}`);
      }
    });
  };

  input.addEventListener('input', () => {
    const q = input.value;
    store.update(
      (s) => {
        s.settings.filters.query = q;
      },
      { silent: true }
    );
    if (q.trim().length < 1) {
      close();
      onStateChange(store.state, { skipControls: true });
      return;
    }
    items = searchAtlas(atlas, q);
    active = 0;
    paint();
    onStateChange(store.state, { skipControls: true });
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      setActive(Math.min(items.length - 1, active + 1));
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      setActive(Math.max(0, active - 1));
      e.preventDefault();
    } else if (e.key === 'Enter' && items[active]) {
      choose(items[active]);
      e.preventDefault();
    } else if (e.key === 'Escape') {
      input.value = '';
      store.update((s) => {
        s.settings.filters.query = '';
      });
      close();
      input.blur();
    }
  });

  document.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('.search-wrap')) close();
  });
}

/** -------------------------------------------------------------- keyboard -- */

function bindKeys() {
  window.addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    switch (e.key) {
      case '/':
        e.preventDefault();
        ($('#search') as HTMLInputElement).focus();
        break;
      case 'Escape':
        if (store.state.selection.zoom.length) {
          store.update((s) => {
            s.selection.zoom = s.selection.zoom.slice(0, -1);
          });
        } else {
          store.update((s) => {
            s.selection.classId = null;
            s.selection.packagePath = null;
          });
        }
        break;
      case 't':
        store.update((s) => {
          s.settings.theme = s.settings.theme === 'dark' ? 'light' : 'dark';
        });
        break;
      case 's':
        store.update((s) => {
          s.settings.sidebar = !s.settings.sidebar;
        });
        break;
      case 'i':
        store.update((s) => {
          s.settings.inspector = !s.settings.inspector;
        });
        break;
      case 'm':
        store.update((s) => {
          s.settings.showMembers = !s.settings.showMembers;
        });
        break;
      case '?':
        openHelp();
        break;
      case '1':
      case '2':
      case '3':
      case '4':
      case '5': {
        const idx = Number(e.key) - 1;
        if (VIEWS[idx]) {
          store.update((s) => {
            s.view = VIEWS[idx].id;
          });
        }
        break;
      }
    }
  });

  window.addEventListener('hashchange', () => {
    store.applyUrl(atlas);
    onStateChange(store.state);
  });
}

/** ------------------------------------------------------------------ help -- */

function bindHelp() {
  $('#btn-help').addEventListener('click', openHelp);
}

function openHelp() {
  const root = $('#modal-root');
  const backdrop = h('div', { class: 'modal-backdrop' });
  const modal = h('div', { class: 'modal' });
  modal.append(
    h('h2', { text: 'Code Atlas' }),
    h('p', {
      text: msg("An interactive map of the decompiled Project Zomboid source tree ({0} files, {1} types, {2} code lines). Every number is parsed straight from {3}/ — no manual curation.", atlas.meta.counts.files, fmtInt(atlas.meta.counts.types), fmtInt(atlas.meta.counts.code), atlas.meta.sourceRoot),
    }),
    h('h3', { text: msg("Views") }),
    h(
      'table',
      {},
      h('tbody', {}, ...VIEWS.map((v) => h('tr', {}, h('td', { style: { width: '130px' }, text: v.label }), h('td', { text: v.hint }))))
    ),
    h('h3', { text: msg("Mouse & keyboard") }),
    h(
      'table',
      {},
      h(
        'tbody',
        {},
        row(msg("click"), msg("select a type or package")),
        row(msg("double-click"), msg("zoom into a package / focus a type")),
        row(msg("right-click"), msg("zoom out to the root")),
        row(msg("hover"), msg("full readout for the rectangle under the cursor")),
        row('/ ', msg("focus search")),
        row('Esc', msg("zoom out one level / clear selection")),
        row('1…5', msg("switch view")),
        row('T', msg("toggle light / dark theme")),
        row('S', msg("toggle the sidebar")),
        row('I', msg("toggle the inspector")),
        row('M', msg("toggle member-level leaves"))
      )
    ),
    h('h3', { text: msg("Customisation") }),
    h('p', {
      text: msg("Set the rectangle size to any single metric or blend your own composite with the weight sliders; recolour by domain, package, kind, stereotype, heat maps or Lua exposure; regroup the whole tree by package, domain, stereotype or kind; change the tiling algorithm, padding, depth limit and small-node culling. Settings persist in localStorage and the current view is encoded in the URL — use the Permalink button to share an exact configuration."),
    }),
    h('h3', { text: msg("Where your settings live") }),
    h('p', {
      html:
        msg("Configuration is stored in <code>localStorage</code> under the single key ") +
        msg("<code>zombie-atlas.settings.v1</code> (size metric, colours, grouping, layout, filters, panel visibility). ") +
        msg("The view, zoom path, selection and filter summary also travel in the URL hash, so a permalink reproduces what you see. ") +
        msg("On load every field is validated and anything missing or malformed falls back to its default, then the repaired payload is written back — ") +
        msg("so clearing storage, hand-editing it or upgrading the app can never wedge the UI."),
    }),
    h('p', {
      html:
        msg("To start over, press <b>Restore defaults</b> at the bottom of the View controls, or run ") +
        msg("<code>zombieAtlas.store.resetSettings()</code> in the console. Remove the URL hash as well if a bookmark is re-applying filters."),
    }),
    h('h3', { text: msg("Data pipeline") }),
    h('p', {
      html:
        msg("<code>tools/extract.mjs</code> parses every <code>.java</code> file with the tree-sitter grammar and extracts packages, types, members, javadoc, annotations and the reference graph, then writes the JSON bundle in <code>dist/data/</code>. <code>tools/validate.mjs</code> re-checks the result against the raw source with an independent scanner."),
    }),
    h(
      'div',
      { class: 'close-row' },
      h('button', { class: 'primary', text: msg("Close"), onclick: () => root.replaceChildren() })
    )
  );
  backdrop.append(modal);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) root.replaceChildren();
  });
  root.replaceChildren(backdrop);

  function row(k: string, v: string) {
    return h('tr', {}, h('td', { style: { width: '130px' } }, h('kbd', { text: k })), h('td', { text: v }));
  }
}

/** -------------------------------------------------------------- statusbar -- */

function renderStatus(s: AppState) {
  const bar = $('#statusbar');
  const { ids } = applyFilters(atlas, s.settings, memberNames);
  const shown = ids.size;
  const bits: (HTMLElement | string)[] = [];
  bits.push(
    h('span', {}, h('b', { text: fmtInt(shown) }), msg(" / {0} types shown", fmtInt(atlas.classes.length)))
  );
  bits.push(h('span', { text: msg("{0} packages", fmtInt(atlas.meta.counts.packages)) }));
  bits.push(h('span', { text: msg("{0} code lines", fmtInt(atlas.meta.counts.code)) }));
  if (s.view === 'dependencies') bits.push(h('span', { text: msg("{0} package edges · {1} class refs", fmtInt(atlas.meta.counts.pkgEdges), fmtInt(atlas.meta.counts.classEdges)) }));
  if (s.view === 'hierarchy') bits.push(h('span', { text: hierarchyStats() }));
  if (currentHover) {
    bits.push(h('span', { style: { color: 'var(--fg-1)' }, text: `▸ ${currentHover.name}` }));
  }
  bits.push(h('span', { class: 'grow' }));
  bits.push(h('span', { text: `${trLabel(s.settings.sizeMetric)} · ${trLabel(s.settings.colorMode)} · ${trLabel(s.settings.groupBy)}` }));
  bar.replaceChildren(...bits);
}

// Mount the shell first: `initLanguage()` reaches for `#language` by id.
const mount = document.getElementById('root');
if (!mount) throw new Error('missing #root — index.html must provide the mount point');
render(App, mount);

initLanguage(() => {
  if (store.state.ready) {
    store.saveSettings();
    store.syncUrl();
  }
});
boot();
