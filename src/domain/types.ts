/**
 * The shapes of the extracted dataset.
 *
 * Nothing here knows how the bundle is loaded — see `atlas.ts` — so views can
 * import the record types without dragging in the loader.
 */

export type Kind = 0 | 1 | 2 | 3 | 4 | 5;

export interface Metrics {
  types: number;
  classes: number;
  interfaces: number;
  enums: number;
  records: number;
  annotations: number;
  modules: number;
  loc: number;
  code: number;
  comment: number;
  blank: number;
  bytes: number;
  methods: number;
  fields: number;
  complexity: number;
  branch: number;
  luaExposed: number;
  fanIn: number;
  fanOut: number;
}

export interface EntityRec {
  /** Missing only in bundles generated before multi-language support. */
  language?: string;
  id: number;
  name: string;
  pkg: string;
  kind: Kind;
  code: number;
  loc: number;
  comment: number;
  blank: number;
  bytes: number;
  methods: number;
  fields: number;
  complexity: number;
  members: number;
  superIds: number[];
  ifaceIds: number[];
  subIds: number[];
  modifiers: string;
  luaExposed: boolean;
  hiddenFromLua: boolean;
  stereotype: string;
  declLine: number;
  path: string;
  parentType: string | null;
  doc: string | null;
  fanIn: number;
  fanOut: number;
  enumConstants: number;
  annotations: string[];
  /** fully qualified name including nesting (Outer.Inner) */
  fqn: string;
  /** top-level package = functional domain key */
  domain: string;
  /** true when the type is not nested inside another type */
  isTopLevel: boolean;
}

/** Compatibility name for existing integrations and schema-v2 clients. */
export type ClassRec = EntityRec;

export interface PkgNode {
  name: string;
  path: string;
  metrics: Metrics | null;
  domain: string;
  children: PkgNode[];
  parent: PkgNode | null;
  /** every class id in this package and below */
  ids: number[];
  /** classes declared directly in this package */
  ownIds: number[];
}

export interface MemberRec {
  kind: 'method' | 'ctor' | 'field';
  name: string;
  type: string;
  params: string[];
  modifiers: string;
  annotations: string[];
  line: number;
  complexity: number;
  bodyLines: number;
  doc: string | null;
  throws: string[];
  init: string | null;
}

export interface Meta {
  schemaVersion?: number;
  languages?: string[];
  languageCapabilities?: Record<string, { structure: boolean; inheritance: boolean; fileDependencies: boolean; memberReferences: boolean }>;
  parseErrors?: { files: number; names: string[] };
  capabilities?: { structure: boolean; fileDependencies: boolean; memberReferences: boolean };
  generated: string;
  /** how the source tree is displayed (relative to the repo when possible) */
  sourceRoot: string;
  /** path segment the source tree is served under: /src/<sourceMount>/** */
  sourceMount?: string;
  sourceRootAbs?: string;
  sourceDirOrigin?: string;
  decompiler: string | null;
  counts: Record<string, number>;
  domains: Record<string, string>;
  metrics: Record<string, string>;
}

export interface DepEdge {
  from: number;
  to: number;
  w: number;
}

/** A loaded bundle: the records plus every index the views query them by. */
export interface Atlas {
  meta: Meta;
  classes: ClassRec[];
  byId: ClassRec[];
  byPkg: Map<string, ClassRec[]>;
  byName: Map<string, ClassRec[]>;
  byPath: Map<string, ClassRec[]>;
  pkgRoot: PkgNode;
  pkgByPath: Map<string, PkgNode>;
  /** package path -> functional domain key */
  pkgDomain: Map<string, string>;
  /** the package that contains everything (e.g. `zombie`) */
  packageRoot: string | null;
  domains: DomainInfo[];
  pkgEdges: { from: string; to: string; w: number }[];
  /** max value per metric, used for normalisation */
  max: Record<string, number>;
}

export interface DomainInfo {
  key: string;
  label: string;
  color: string;
  metrics: Metrics;
  ids: number[];
  packages: string[];
  hubs: ClassRec[];
}
