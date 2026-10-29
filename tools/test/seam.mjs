/**
 * The application's inspection seam — the *only* place the suite reaches into
 * application internals.
 *
 * Specs drive and read the app through the named operations below, never by
 * touching `window.zombieAtlas` themselves. When the application is
 * restructured (mutators renamed, the engine split into modules, the debug
 * handle reshaped) only this file changes; fourteen specs stay untouched.
 *
 * A note on what is being reached into:
 *
 *   - `store.update(fn)` / `store.state` / `store.resetSettings()` are the
 *     documented, user-facing console API (README, help dialog).
 *   - `treemap.nodes|leaves|root|nodeAt` and `deps()` are *probes*: `root`,
 *     `nodes`, `leaves` and `nodeAt` are TypeScript-`private`, reachable only
 *     because TS privacy is erased at runtime. They are the most fragile part
 *     of this contract and are wrapped here so a restructure has one edit site.
 *
 * Playwright cannot pass a function across the page boundary (verified), so
 * every operation takes plain data. `store.apply()` is the single general
 * mutator, expressed as a declarative patch.
 */

/** Declarative state patch applied by `store.apply()`. */
const applyPatch = (patch) => {
  const { store, atlas } = window.zombieAtlas;
  store.update((s) => {
    if (patch.view !== undefined) s.view = patch.view;
    if (patch.depMode !== undefined) s.depMode = patch.depMode;

    if (patch.zoom !== undefined) s.selection.zoom = patch.zoom.slice();
    if (patch.classId !== undefined) {
      s.selection.classId = patch.classId;
      s.selection.packagePath = null;
    }
    if (patch.classIdByName !== undefined) {
      const c = atlas.classes.find((x) => x.name === patch.classIdByName);
      if (!c) throw new Error(`fixture class "${patch.classIdByName}" is not in the dataset`);
      s.selection.classId = c.id;
      s.selection.packagePath = null;
    }
    if (patch.packagePath !== undefined) {
      s.selection.packagePath = patch.packagePath;
      s.selection.classId = null;
    }
    if (patch.clearSelection) {
      s.selection.classId = null;
      s.selection.packagePath = null;
    }

    if (patch.resetFilters) {
      s.settings.filters = { query: '', kinds: [], languages: [], stereotypes: [], domains: [], luaOnly: false, minCode: 0 };
    }
    if (patch.filters) Object.assign(s.settings.filters, patch.filters);
    if (patch.settings) {
      // `settings.filters` is merged rather than assigned: `filters` is a full
      // record and replacing it with a partial one breaks every reader
      // (`syncUrl` indexes straight into `filters.domains`). Accepting the
      // nested form keeps callers from tripping over that.
      const { filters, ...rest } = patch.settings;
      Object.assign(s.settings, rest);
      if (filters) Object.assign(s.settings.filters, filters);
    }
  });
};

export const store = {
  /** The whole state. Serialisable, so it can be compared across a reload. */
  state: (page) => page.evaluate(() => window.zombieAtlas.store.state),
  view: (page) => page.evaluate(() => window.zombieAtlas.store.state.view),
  depMode: (page) => page.evaluate(() => window.zombieAtlas.store.state.depMode),
  settings: (page) => page.evaluate(() => window.zombieAtlas.store.state.settings),
  filters: (page) => page.evaluate(() => window.zombieAtlas.store.state.settings.filters),
  selection: (page) => page.evaluate(() => window.zombieAtlas.store.state.selection),
  zoomPath: (page) => page.evaluate(() => window.zombieAtlas.store.state.selection.zoom),
  /** Settings written through to localStorage, parsed back. */
  persisted: (page, key) => page.evaluate((k) => {
    const raw = localStorage.getItem(k);
    return raw ? JSON.parse(raw) : null;
  }, key),

  apply: (page, patch) => page.evaluate(applyPatch, patch),
  reset: (page) => page.evaluate(() => window.zombieAtlas.store.resetSettings()),
};

export const atlas = {
  entities: (page) => page.evaluate(() => window.zombieAtlas.atlas.classes),
  meta: (page) => page.evaluate(() => window.zombieAtlas.atlas.meta),
  counts: (page) => page.evaluate(() => window.zombieAtlas.atlas.meta.counts),
  /** Id of a type by simple name. Throws when the fixture is absent. */
  classId: (page, name) => page.evaluate((n) => {
    const c = window.zombieAtlas.atlas.classes.find((x) => x.name === n);
    if (!c) throw new Error(`fixture class "${n}" is not in the dataset`);
    return c.id;
  }, name),
  /** Path of the first extracted type, for the raw-source plumbing checks. */
  firstPath: (page) => page.evaluate(() => window.zombieAtlas.atlas.classes[0].path),
  /**
   * The `n` types with the longest simple names.
   *
   * Real fixtures for the panel's width behaviour, derived from the bundle
   * instead of hard-coded: the inspector repeats a member's name in its rows, so
   * these are the types whose rows are widest — and they survive renames that a
   * literal fixture would not.
   */
  longestNames: (page, n) =>
    page.evaluate(
      (count) =>
        [...window.zombieAtlas.atlas.classes]
          .sort((a, b) => b.name.length - a.name.length)
          .slice(0, count)
          .map((c) => c.name),
      n
    ),
};

export const treemap = {
  waitForMembers: (page) => page.waitForFunction(() => window.zombieAtlas.treemap.nodes.some((node) => node.data.kind === 'member')),
  records: (page) => page.evaluate(() => window.zombieAtlas.treemap.nodes.map((node) => ({
    id: node.data.id, kind: node.data.kind, groupType: node.data.groupType, classId: node.data.classId,
  }))),
  /**
   * `root` is the current zoom subtree's root, so its id *is* the last id of
   * the zoom path that resolved.
   */
  zoomRootId: (page) => page.evaluate(() => window.zombieAtlas.treemap.root?.data?.id ?? null),
  snapshot: (page) => page.evaluate(() => {
    const t = window.zombieAtlas.treemap;
    return {
      zoomRootId: t.root?.data?.id ?? null,
      aggregate: t.root?.data?.agg,
      nodes: t.nodes.length,
      leaves: t.leaves.length,
      isEmpty: !!t.isEmpty,
    };
  }),

  /**
   * Find a rectangle that is a group with children of its own, and return its
   * centre in *page* coordinates so it can be clicked directly.
   */
  findGroup: (page, opts = {}) => page.evaluate(({ step, margin }) => {
    const t = window.zombieAtlas.treemap;
    const cv = document.querySelector('#canvas');
    const r = cv.getBoundingClientRect();
    for (let y = margin; y < cv.clientHeight - margin; y += step) {
      for (let x = margin; x < cv.clientWidth - margin; x += step) {
        const n = t.nodeAt(x, y);
        if (n && n.parent && n.children?.length) return { x: r.left + x, y: r.top + y, id: n.data.id };
      }
    }
    return null;
  }, { step: opts.step ?? 7, margin: opts.margin ?? 30 }),
};

const graph = {
  /** `deps()` returns live functions; keep only the serialisable fields. */
  snapshot: (page) => page.evaluate(() => {
    const d = window.zombieAtlas.deps();
    return {
      mode: d.mode,
      zoom: d.zoom,
      panX: d.panX,
      panY: d.panY,
      nodes: d.nodes,
      edges: d.edges,
      panning: d.panning,
      draggingNode: d.draggingNode,
      hover: d.hover,
    };
  }),

  /** A point over empty canvas, for pan gestures that must not grab a node. */
  findEmptyPoint: (page, opts = {}) => page.evaluate(({ step, margin }) => {
    const d = window.zombieAtlas.deps();
    const cv = document.querySelector('#canvas');
    for (let y = margin; y < cv.clientHeight - margin; y += step) {
      for (let x = margin; x < cv.clientWidth - margin; x += step) {
        if (!d.hitTest(x, y)) return { x, y };
      }
    }
    return null;
  }, { step: opts.step ?? 25, margin: opts.margin ?? 40 }),

  /** A point over a node, plus that node's package path. */
  findNode: (page, opts = {}) => page.evaluate(({ step, margin }) => {
    const d = window.zombieAtlas.deps();
    const cv = document.querySelector('#canvas');
    for (let y = margin; y < cv.clientHeight - margin; y += step) {
      for (let x = margin; x < cv.clientWidth - margin; x += step) {
        const hit = d.hitTest(x, y);
        if (hit) return { x, y, path: hit };
      }
    }
    return null;
  }, { step: opts.step ?? 13, margin: opts.margin ?? 60 }),
};

/**
 * Grouped namespace, so a spec reads as `seam.store.apply(...)` /
 * `seam.treemap.findGroup(...)`. The individual exports are kept for callers
 * that only want one surface.
 */
export const seam = { store, atlas, treemap, graph };
