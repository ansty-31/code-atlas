/**
 * Bundle loading: reads the JSON emitted by `tools/extract.mjs` and turns the
 * compact columnar records into the indexed objects the views query.
 *
 * Nothing here is hard-coded to Project Zomboid specifics beyond the bundle
 * schema; the whole atlas is a function of the extracted data.
 */

import { addMetrics, emptyMetrics, METRIC_KEYS, metricValue } from './metrics';
import type {
  Atlas,
  ClassRec,
  DomainInfo,
  Kind,
  Meta,
  PkgNode,
} from './types';

const cache = new Map<string, Promise<unknown>>();

function fetchJSON<T>(url: string): Promise<T> {
  if (!cache.has(url)) {
    cache.set(
      url,
      fetch(url).then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
        return r.json();
      })
    );
  }
  return cache.get(url) as Promise<T>;
}

/** Categorical palette — distinguishable in both themes. */
const PALETTE = [
  '#4e9de0', '#59b39a', '#c9a227', '#d1785b', '#b07fd6',
  '#5fb3d4', '#8fbf5f', '#e08cb0', '#7f8ce0', '#c98b3f',
  '#4fbfa8', '#d16d9e', '#9aa7b8', '#6fbf73', '#c76b6b',
  '#8ab4f8', '#e0b357', '#63c6c6', '#b58cd6', '#a8b04a',
  '#e08f5f', '#5f9ed1', '#cf7fb0', '#7fc4a0', '#c0c060',
  '#9d7fd8', '#5cc0b0', '#d9a05b', '#86a8e0', '#b8b8b8',
];

export async function loadAtlas(base = 'data'): Promise<Atlas> {
  const [meta, pkgTree, classFile, pkgEdgesRaw] = await Promise.all([
    fetchJSON<Meta>(`${base}/meta.json`),
    fetchJSON<PkgNode>(`${base}/packages.json`),
    fetchJSON<{ columns: string[]; rows: unknown[][] }>(`${base}/classes.json`),
    fetchJSON<[string, string, number][]>(`${base}/deps-packages.json`),
  ]);

  // The functional domain is the first package component *below* the source
  // root (all PZ code lives under `zombie.`), so `zombie.iso.areas` → `iso`.
  const topLevelPkgs = pkgTree.children.map((n) => n.name);
  const singleRoot = topLevelPkgs.length === 1 ? topLevelPkgs[0] : null;
  const domainOf = (pkg: string): string => {
    const parts = pkg.split('.');
    if (singleRoot && parts[0] === singleRoot) return parts.length > 1 ? parts[1] : singleRoot;
    return parts[0];
  };

  const C = classFile.columns;
  const idx = (n: string) => C.indexOf(n);
  const iId = idx('id');
  const iName = idx('name');
  const iPkg = idx('package');
  const iKind = idx('kind');
  const iCode = idx('code');
  const iLoc = idx('loc');
  const iComment = idx('comment');
  const iBlank = idx('blank');
  const iBytes = idx('bytes');
  const iMethods = idx('methods');
  const iFields = idx('fields');
  const iCx = idx('complexity');
  const iMembers = idx('members');
  const iSuper = idx('superIds');
  const iIface = idx('ifaceIds');
  const iSub = idx('subIds');
  const iMods = idx('modifiers');
  const iLua = idx('luaExposed');
  const iHidden = idx('hiddenFromLua');
  const iStereo = idx('stereotype');
  const iLine = idx('declLine');
  const iPath = idx('path');
  const iParent = idx('parentType');
  const iDoc = idx('doc');
  const iFanIn = idx('fanIn');
  const iFanOut = idx('fanOut');
  const iEnumConst = idx('enumConstants');
  const iAnnot = idx('annotations');
  const iLanguage = idx('language');
  const iFqn = idx('fqn');

  const classes: ClassRec[] = classFile.rows.map((r) => {
    const parentType = (r[iParent] as string) ?? null;
    const name = r[iName] as string;
    const pkg = r[iPkg] as string;
    return {
      id: r[iId] as number,
      name,
      language: iLanguage >= 0 ? r[iLanguage] as string : 'java',
      pkg,
      kind: r[iKind] as Kind,
      code: r[iCode] as number,
      loc: r[iLoc] as number,
      comment: r[iComment] as number,
      blank: r[iBlank] as number,
      bytes: r[iBytes] as number,
      methods: r[iMethods] as number,
      fields: r[iFields] as number,
      complexity: r[iCx] as number,
      members: r[iMembers] as number,
      superIds: (r[iSuper] as number[]) ?? [],
      ifaceIds: (r[iIface] as number[]) ?? [],
      subIds: (r[iSub] as number[]) ?? [],
      modifiers: (r[iMods] as string) ?? '',
      luaExposed: r[iLua] === 1,
      hiddenFromLua: r[iHidden] === 1,
      stereotype: (r[iStereo] as string) ?? 'class',
      declLine: r[iLine] as number,
      path: r[iPath] as string,
      parentType,
      doc: (r[iDoc] as string) ?? null,
      fanIn: r[iFanIn] as number,
      fanOut: r[iFanOut] as number,
      enumConstants: r[iEnumConst] as number,
      annotations: (r[iAnnot] as string[]) ?? [],
      fqn: iFqn >= 0 ? r[iFqn] as string : parentType ? `${parentType}.${name}` : pkg === '(default)' ? name : `${pkg}.${name}`,
      domain: domainOf(pkg),
      isTopLevel: !parentType,
    };
  });

  const byId: ClassRec[] = new Array(classes.length);
  const byPkg = new Map<string, ClassRec[]>();
  const byName = new Map<string, ClassRec[]>();
  const byPath = new Map<string, ClassRec[]>();
  for (const c of classes) {
    byId[c.id] = c;
    push(byPkg, c.pkg, c);
    push(byName, c.name, c);
    push(byPath, c.path, c);
  }

  // ---- package tree -------------------------------------------------------
  const pkgByPath = new Map<string, PkgNode>();
  const attach = (node: PkgNode, parent: PkgNode | null) => {
    node.parent = parent;
    node.ids = [];
    node.ownIds = [];
    pkgByPath.set(node.path, node);
    for (const ch of node.children) attach(ch, node);
  };
  attach(pkgTree, null);

  for (const c of classes) {
    // walk up the package chain adding the class to every ancestor
    let p = pkgByPath.get(c.pkg);
    if (!p) {
      // package not present in the tree (should not happen): synthesise a flat node
      p = { name: c.pkg, path: c.pkg, metrics: null, domain: c.domain, children: [], parent: null, ids: [], ownIds: [] };
      pkgByPath.set(c.pkg, p);
    }
    p.ownIds.push(c.id);
    let cur: PkgNode | null = p;
    while (cur) {
      cur.ids.push(c.id);
      cur = cur.parent;
    }
  }

  // ---- domains ------------------------------------------------------------
  const domainMap = new Map<string, DomainInfo>();
  const domainKeys = [...new Set(classes.map((c) => c.domain))].sort();
  domainKeys.forEach((key, i) => {
    domainMap.set(key, {
      key,
      label: meta.domains?.[key] ?? key,
      color: PALETTE[i % PALETTE.length],
      metrics: emptyMetrics(),
      ids: [],
      packages: [],
      hubs: [],
    });
  });
  for (const c of classes) {
    const d = domainMap.get(c.domain)!;
    d.ids.push(c.id);
    addMetrics(d.metrics, c);
  }
  // (per-domain metrics are accumulated from the classes themselves, so they
  // always match what the treemap is currently showing)
  for (const d of domainMap.values()) {
    d.hubs = d.ids
      .map((id) => byId[id])
      .sort((a, b) => b.fanIn - a.fanIn)
      .slice(0, 4);
  }

  // ---- metric maxima ------------------------------------------------------
  const max: Record<string, number> = {};
  for (const k of METRIC_KEYS) {
    let m = 0;
    for (const c of classes) m = Math.max(m, metricValue(c, k));
    max[k] = m || 1;
  }

  const pkgEdges = pkgEdgesRaw.map(([from, to, w]) => ({ from, to, w }));

  const pkgDomain = new Map<string, string>();
  for (const path of pkgByPath.keys()) if (path) pkgDomain.set(path, domainOf(path));

  return {
    meta,
    classes,
    byId,
    byPkg,
    byName,
    byPath,
    pkgRoot: pkgTree,
    pkgByPath,
    pkgDomain,
    packageRoot: singleRoot,
    domains: [...domainMap.values()].sort((a, b) => b.metrics.code - a.metrics.code),
    pkgEdges,
    max,
  };
}

function push<T>(m: Map<string, T[]>, k: string, v: T) {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}
