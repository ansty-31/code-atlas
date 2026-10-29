/**
 * A tiny synthetic atlas for unit tests.
 *
 * The real bundle is ~11 MB and needs a browser to fetch, so the pure modules
 * that take an `Atlas` are tested against this instead: a handful of types with
 * deliberately varied metrics, kinds, packages and annotations, so each filter
 * has something to exclude.
 *
 * Lives outside `tools/test/unit/` on purpose — `node --test <dir>` treats every
 * `.mjs` under such a directory as a test file.
 */

/** Four types, chosen so every filter has a distinguishable effect. */
export const SAMPLE_CLASSES = [
  {
    id: 0,
    name: 'Alpha',
    pkg: 'zombie.core',
    kind: 0,
    stereotype: 'class',
    code: 100,
    complexity: 20,
    luaExposed: false,
    annotations: [],
  },
  {
    id: 1,
    name: 'Beta',
    pkg: 'zombie.iso',
    kind: 1,
    stereotype: 'interface',
    code: 5,
    complexity: 1,
    luaExposed: true,
    annotations: ['UsedFromLua'],
  },
  {
    id: 2,
    name: 'AlphaBeta',
    pkg: 'zombie.iso',
    kind: 2,
    stereotype: 'enum',
    code: 50,
    complexity: 9,
    luaExposed: false,
    annotations: [],
  },
  {
    id: 3,
    name: 'Gamma',
    pkg: 'zombie.network',
    kind: 0,
    stereotype: 'manager',
    code: 2,
    complexity: 1,
    luaExposed: false,
    annotations: ['UsedFromLua'],
  },
];

/** Build one `ClassRec`, filling in everything the filters do not exercise. */
export function makeClass(overrides = {}) {
  const id = overrides.id ?? 0;
  const name = overrides.name ?? `C${id}`;
  const pkg = overrides.pkg ?? 'zombie.core';
  const parentType = overrides.parentType ?? null;
  return {
    id,
    name,
    pkg,
    kind: 0,
    code: 10,
    loc: 12,
    comment: 1,
    blank: 1,
    bytes: 240,
    methods: 1,
    fields: 1,
    complexity: 2,
    members: 3,
    superIds: [],
    ifaceIds: [],
    subIds: [],
    modifiers: 'public',
    luaExposed: false,
    hiddenFromLua: false,
    stereotype: 'class',
    declLine: 1,
    path: `${pkg.replace(/\./g, '/')}/${name}.java`,
    parentType,
    doc: null,
    fanIn: 0,
    fanOut: 0,
    enumConstants: 0,
    annotations: [],
    fqn: parentType ? `${parentType}.${name}` : `${pkg}.${name}`,
    domain: pkg.split('.')[1] ?? pkg,
    isTopLevel: parentType === null,
    ...overrides,
  };
}

const push = (map, key, value) => {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
};

/** Assemble the indexes `applyFilters` and `searchAtlas` read. */
export function makeAtlas(classOverrides = SAMPLE_CLASSES) {
  const classes = classOverrides.map((c, i) => makeClass({ id: i, ...c }));
  const byId = [];
  const byPkg = new Map();
  const byName = new Map();
  const byPath = new Map();
  for (const c of classes) {
    byId[c.id] = c;
    push(byPkg, c.pkg, c);
    push(byName, c.name, c);
    push(byPath, c.path, c);
  }

  const pkgByPath = new Map();
  for (const path of new Set(classes.map((c) => c.pkg))) {
    pkgByPath.set(path, {
      name: path.split('.').pop(),
      path,
      metrics: null,
      domain: path.split('.')[1] ?? path,
      children: [],
      parent: null,
      ids: [],
      ownIds: classes.filter((c) => c.pkg === path).map((c) => c.id),
    });
  }

  return {
    meta: { generated: '', sourceRoot: 'zombie', decompiler: null, counts: {}, domains: {}, metrics: {} },
    classes,
    byId,
    byPkg,
    byName,
    byPath,
    pkgRoot: { name: '', path: '', metrics: null, domain: '', children: [], parent: null, ids: [], ownIds: [] },
    pkgByPath,
    pkgDomain: new Map(),
    packageRoot: 'zombie',
    domains: [],
    pkgEdges: [],
    max: {},
  };
}
