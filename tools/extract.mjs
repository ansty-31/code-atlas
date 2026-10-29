/**
 * zombie-atlas extractor
 * ----------------------
 * Parses the decompiled Project Zomboid source tree (`zombie/`) into a compact
 * JSON bundle consumed by the SPA in `src/`.
 *
 * Everything the atlas shows is derived from the source itself: package
 * structure, type hierarchy, members, javadoc, annotations and the import /
 * fully-qualified-name reference graph.
 *
 * Usage:  node tools/extract.mjs [--src <dir>] [--out <dir>] [--pretty]
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCommonArgs, resolveDataOut, resolveSourceDir, resolveLanguages } from './lib/config.mjs';
import { initJavaParser, parseJavaFileWith } from './lib/java-ast.mjs';
import { REF_KINDS, buildReferences, summarise } from './lib/java-refs.mjs';
import { normalizeTypeRef, simpleName } from './lib/java-names.mjs';
import { languageForPath, selectLanguages, IGNORED_DIRS } from '../src/shared/languages.mjs';
import { loadAdapter } from './lib/adapters.mjs';
import { fileDependencyResolver } from './lib/source-ast.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// args / configuration
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
let PRETTY = argv.includes("--pretty");
let QUIET = argv.includes('--quiet');
const { src: cliSrc, out: cliOut, languages: cliLanguages } = parseCommonArgs(argv);

// Fine-grained references can be skipped for a lean bundle (they are an order
// of magnitude more rows than the class graph: ~13 MB of lazy shards).
const SKIP_REFS = argv.includes('--no-refs') || process.env.ZOMBIE_ATLAS_SKIP_REFS === '1';

/** The parser asked for on the command line, if any. Tree-sitter is the only one there is. */
const parserArg = (() => {
  const i = argv.indexOf('--parser');
  return i >= 0 ? argv[i + 1] : undefined;
})();
/** Ast extraction options: the canonical branch-node set (see docs/parser-parity.md). */
const AST_OPTIONS = { excludeDefaultLabels: true, references: !SKIP_REFS };

/** Resolved lazily so the module can be imported without touching the disk. */
let SRC = null;
function source() {
  if (!SRC) SRC = resolveSourceDir(cliSrc);
  return SRC;
}
const SRC_DIR = () => source().dir;
const MOUNT = () => source().mount;
let OUT_DIR = resolveDataOut(cliOut);

let t0 = Date.now();

// ---------------------------------------------------------------------------
// file discovery
// ---------------------------------------------------------------------------
/** @returns {string[]} absolute paths of every .java file, sorted */
function walk(dir) {
  // Git already implements .gitignore (including nested rules and negation).
  const listed = spawnSync('git', ['-C', dir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (listed.status === 0) {
    return [...new Set(listed.stdout.split('\0').filter(Boolean))]
      .filter((name) => languageForPath(name) && !name.split('/').some((part) => IGNORED_DIRS.has(part) || part.startsWith('.')))
      .map((name) => path.resolve(dir, name))
      .filter((file) => { try { return fs.lstatSync(file).isFile(); } catch { return false; } })
      .sort();
  }
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && !IGNORED_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(p);
      else if (e.isFile() && languageForPath(e.name)) out.push(p);
    }
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// classification helpers (all source-derived)
// ---------------------------------------------------------------------------

/** Stereotype inferred from the declaration itself. */
function stereotype(t) {
  const n = t.name;
  if (t.kind === 'module') return 'module';
  if (t.annotations.includes('UsedFromLua')) return 'lua-api';
  if (t.kind === 'interface') return 'interface';
  if (t.kind === 'enum') return 'enum';
  if (t.kind === 'record') return 'record';
  if (t.kind === 'annotation') return 'annotation';
  if (/(?:Exception|Error)$/.test(n)) return 'exception';
  if (/^(?:I|Abstract)/.test(n) && t.modifiers.includes('abstract')) return 'abstraction';
  if (/Manager$/.test(n)) return 'manager';
  if (/Packet$/.test(n)) return 'packet';
  if (/(?:UI|Panel|Window|Dialog|Widget|Element|Screen)$/.test(n)) return 'ui';
  if (/(?:Factory|Builder|Builder$|Provider)$/.test(n)) return 'factory';
  if (/(?:Util|Utils|Helper|Tools)$/.test(n)) return 'utility';
  if (/(?:Event|Listener|Callback|Handler)$/.test(n)) return 'event';
  if (/(?:Test|Debug)$/.test(n)) return 'debug';
  if (t.modifiers.includes('abstract')) return 'abstract';
  if (/(?:Info|Data|State|Type|Config|Options|Settings|Descriptor|Definition)$/.test(n)) return 'data';
  return 'class';
}

/** Coarse functional domain, taken from the owning top-level package. */
const DOMAINS = {
  zombie: 'Root / engine singletons',
  ai: 'AI & NPC behaviour',
  asset: 'Asset loading',
  audio: 'Audio & sound',
  basements: 'Basement generation',
  buildingRooms: 'Building room definitions',
  characterTextures: 'Character texture assembly',
  characters: 'Characters, players, zombies, moods, skills',
  chat: 'Chat & messaging',
  combat: 'Combat resolution',
  commands: 'Player/admin commands',
  config: 'Configuration & key bindings',
  core: 'Engine core: maths, rendering, threads, files, logging',
  creative: 'Creative mode tools',
  debug: 'Debug tooling & inspectors',
  entity: 'Entity component system',
  erosion: 'World erosion over time',
  fileSystem: 'File system access',
  fireFighting: 'Fire simulation & firefighting',
  gameStates: 'Game state machine (menus, loading, in-game)',
  gizmo: 'Gizmo / editor manipulators',
  globalObjects: 'Global object registry',
  input: 'Input handling',
  interfaces: 'Shared interfaces / callbacks',
  inventory: 'Items, containers, inventory',
  iso: 'Isometric world: cells, squares, objects, rendering',
  Lua: 'Lua <-> Java bridge (Kahlua)',
  meta: 'Meta world: map events, story, zones',
  modding: 'Mod loading',
  network: 'Multiplayer networking, packets, sync',
  pathfind: 'Pathfinding',
  popman: 'Population manager, zombie spawning',
  pot: 'Procedural object toolkit (POTUS)',
  profanity: 'Profanity filter',
  radio: 'Radio & TV media',
  randomizedWorld: 'Randomised world generation',
  sandbox: 'Sandbox option definitions',
  savefile: 'Save/load serialisation',
  scripting: 'Script (zedscript) parsing & object model',
  seams: 'Seam / boundary handling',
  seating: 'Seat & vehicle position logic',
  spnetwork: 'Singleplayer network emulation',
  spriteModel: 'Sprite model / attachments',
  statistics: 'Statistics & telemetry',
  text: 'Text & translation',
  tileDepth: 'Tile depth sorting',
  ui: 'UI widgets & HUD',
  util: 'Generic utilities',
  vehicleNetworkSound: 'Vehicle network sound sync',
  vehicleSound: 'Vehicle sound engine',
  vehicles: 'Vehicles & parts',
  viewCone: 'Vision cones',
  vispoly: 'Visibility polygons',
  world: 'World generation & map data',
  worldMap: 'In-game world map',
  '(default)': 'Default package',
};

function domainOf(pkg) {
  // PZ code all lives under the `zombie` root package, so the functional domain
  // is the first component *below* it (`zombie.iso.areas` -> `iso`).
  const parts = pkg.split('.');
  if (parts[0] === 'zombie') return parts.length > 1 ? parts[1] : 'zombie';
  return parts[0];
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

/**
 * Parse the whole tree and write the JSON bundle.
 *
 * @param {{src?: string, out?: string, pretty?: boolean}} [opts]
 * @returns {Promise<{files:number, types:number, out:string, src:string, mount:string}>}
 */
export async function runExtraction(opts = {}) {
  // No dual path: a command line that asks for the deleted scanner fails instead
  // of quietly building a bundle whose provenance differs from what was asked.
  if (parserArg && !/^(ast|tree-sitter)$/.test(parserArg)) {
    throw new Error(`the "${parserArg}" parser no longer exists — tree-sitter is the only parser`);
  }
  OUT_DIR = resolveDataOut(opts.out ?? cliOut);
  PRETTY = opts.pretty ?? argv.includes('--pretty');
  QUIET = opts.quiet ?? argv.includes('--quiet');
  SRC = resolveSourceDir(opts.src ?? cliSrc);
  const languages = selectLanguages(resolveLanguages(opts.languages ?? cliLanguages));
  let skipRefs = opts.noRefs ?? SKIP_REFS;
  const astOptions = { ...AST_OPTIONS, references: !skipRefs };
  t0 = Date.now();
  const srcDir = SRC_DIR();
  const mount = MOUNT();
  if (process.env.ATLAS_PARSE_ONLY) {
    const abs = path.resolve(process.env.ATLAS_PARSE_ONLY);
    const rel = `${mount}/${path.relative(srcDir, abs).split(path.sep).join('/')}`;
    const { parser } = await initJavaParser();
    const { types, file } = parseJavaFileWith(parser, abs, rel, AST_OPTIONS);
    console.log(JSON.stringify({ file, types: types.map((t) => ({ ...t, members: t.members.slice(0, 6), memberCount: t.members.length })) }, null, 1));
    process.exit(0);
  }

  const discovered = walk(srcDir);
  const selected = new Set(languages.map((language) => language.id));
  const hasCpp = discovered.some((file) => languageForPath(file)?.id === 'cpp' && path.extname(file).toLowerCase() !== '.h');
  const headerLanguage = selected.has('c') && (!selected.has('cpp') || !hasCpp) ? 'c' : 'cpp';
  const languageOf = (file) => languageForPath(file, headerLanguage);
  const files = discovered.filter((file) => selected.has(languageOf(file)?.id));
  if (!files.length) throw new Error(`No supported source files found under ${srcDir} (${languages.map((language) => language.id).join(', ')}).`);
  if (!QUIET) process.stderr.write(`[extract] ${files.length} source files under ${srcDir} (mount: ${mount})\n`);

  // One parser for the whole tree. `refsByPath` carries the inline `zombie.*`
  // runs the walk saw, so the reference graph below never re-reads a file.
  const engines = new Map();
  for (const file of files) {
    const language = languageOf(file);
    if (!engines.has(language.id)) engines.set(language.id, await loadAdapter(language));
  }
  if (!engines.has('java')) skipRefs = true;
  const versions = { grammar: [...engines.values()].map((engine) => engine.grammar), runtime: 'web-tree-sitter' };
  const refsByPath = new Map();
  const sitesByPath = new Map();
  const flowByPath = new Map();
  const parseErrorFiles = [];
  const allTypes = [];
  const fileRecords = [];
  for (const f of files) {
    try {
      const rel = `${MOUNT()}/${path.relative(SRC_DIR(), f).split(path.sep).join('/')}`;
      const language = languageOf(f);
      const { types, file, refs, sites, flow } = engines.get(language.id).parseFile(f, rel, astOptions);
      file.language = language.id;
      for (const type of types) type.language = language.id;
      refsByPath.set(file.path, refs);
      if (sites) {
        sitesByPath.set(file.path, sites);
        flowByPath.set(file.path, flow);
      }
      if (file.parseErrors) parseErrorFiles.push(file.path);
      fileRecords.push(file);
      for (const t of types) allTypes.push(t);
    } catch (err) {
      throw new Error(`Failed to extract ${f}: ${err.message}`, { cause: err });
    }
  }
  if (!QUIET) process.stderr.write(`[extract] parsed ${allTypes.length} types in ${Date.now() - t0}ms (tree-sitter)\n`);

  // ---- index classes ---------------------------------------------------------
  const classByFqn = new Map();
  const ownerByPath = new Map(allTypes.map((type) => [type.path, type]));
  allTypes.forEach((t, i) => {
    t.id = i;
    classByFqn.set(t.fqn, t);
  });
  // package-name -> class ids
  const byPackage = new Map();
  for (const t of allTypes) {
    if (!byPackage.has(t.package)) byPackage.set(t.package, []);
    byPackage.get(t.package).push(t.id);
  }

  // global simple-name index (name -> class ids)
  const bySimple = new Map();
  for (const t of allTypes) {
    if (t.language !== 'java') continue;
    if (!bySimple.has(t.name)) bySimple.set(t.name, []);
    bySimple.get(t.name).push(t.id);
  }

  /**
   * Resolve a type reference to an internal class id, or null when the reference
   * points outside the decompiled tree or is genuinely ambiguous.
   * @param {string} ref
   * @param {string} [pkg] owning package, used to break ties
   */
  const sourceTypesByName = new Map();
  for (const type of allTypes) {
    if (type.kind === 'module') continue;
    if (!sourceTypesByName.has(type.name)) sourceTypesByName.set(type.name, []);
    sourceTypesByName.get(type.name).push(type);
  }
  const fileByPath = new Map(fileRecords.map((file) => [file.path, file]));
  const resolveFile = fileDependencyResolver(fileRecords);
  const fileTargets = new Map(fileRecords.map((file) => [file.path, resolveFile(file)]));
  function resolveRef(ref, pkg, imports, ownerPath, ownerType) {
    const owner = ownerType ?? ownerByPath.get(ownerPath);
    if (owner && owner.language !== 'java') {
      let bare = ref.replace(/::/g, '.').replace(/<.*>/, '').replace(/\[.*\]/, '').replace(/^[\s'"]+|[\s'"]+$/g, '');
      let targetPaths = fileTargets.get(ownerPath) ?? [];
      if (owner.language === 'python') {
        const file = fileByPath.get(ownerPath);
        const binding = file?.bindings?.find((entry) => bare === entry.local || bare.startsWith(entry.local + '.'));
        if (binding) {
          const suffix = bare.slice(binding.local.length);
          bare = (binding.symbol ?? '') + suffix;
          bare = bare.replace(/^\./, '');
          targetPaths = resolveFile({ ...file, dependencies: [
            { kind: 'python', name: binding.module },
            ...(binding.symbol ? [{ kind: 'python', name: `${binding.module}${binding.module.endsWith('.') ? '' : '.'}${binding.symbol}` }] : []),
          ] });
        }
      }
      if (!bare) return null;
      const candidates = (sourceTypesByName.get(bare.split('.').pop()) ?? []).filter((type) => type.language === owner.language && (type.name === bare || type.fqn.endsWith('.' + bare)));
      const scoped = candidates.find((type) => type.fqn === owner.fqn.slice(0, owner.fqn.lastIndexOf('.') + 1) + bare);
      if (scoped) return scoped.id;
      const local = candidates.filter((type) => type.path === ownerPath);
      if (local.length === 1) return local[0].id;
      const imported = candidates.filter((type) => targetPaths.includes(type.path));
      return imported.length === 1 ? imported[0].id : null;
    }
    const bare = normalizeTypeRef(ref);
    if (!bare) return null;
    if (classByFqn.has(bare)) return classByFqn.get(bare).id;
    if (classByFqn.has('zombie.' + bare)) return classByFqn.get('zombie.' + bare).id;
    // A plain name is most reliably resolved through the file's own imports.
    if (!bare.includes('.') && imports) {
      for (const raw of imports) {
        const imp = typeof raw === 'string' ? raw : raw.name;
        if (imp.endsWith('.' + bare)) {
          const c = classByFqn.get(imp);
          if (c) return c.id;
        }
        if (imp.endsWith('.*')) {
          const c = classByFqn.get(imp.slice(0, -1) + bare);
          if (c) return c.id;
        }
      }
    }
    if (bare.includes('.')) {
      // `Outer.Inner` written from inside the same package: qualify it directly.
      const samePkg = classByFqn.get(`${pkg}.${bare}`);
      if (samePkg) return samePkg.id;
      // ...or relative to an imported outer type (`IsoGridSquare.GetSquare`).
      if (imports) {
        for (const raw of imports) {
          const imp = typeof raw === 'string' ? raw : raw.name;
          const outer = imp.split('.').pop();
          if (outer && bare.startsWith(outer + '.')) {
            const c = classByFqn.get(imp + bare.slice(outer.length));
            if (c) return c.id;
          }
        }
      }
      // `zombie.foo.Bar` style reference emitted without an import
      const cands = bySimple.get(simpleName(bare));
      if (cands && cands.length === 1) return cands[0];
      if (cands && pkg) {
        const same = cands.filter((id) => allTypes[id].package === pkg);
        if (same.length === 1) return same[0];
      }
      return null;
    }
    const cands = bySimple.get(bare);
    if (!cands) return null;
    if (cands.length === 1) return cands[0];
    if (ownerPath) {
      // a sibling nested type in the same compilation unit is the best candidate
      const sameFile = cands.filter((id) => allTypes[id].path === ownerPath);
      if (sameFile.length === 1) return sameFile[0];
    }
    if (pkg) {
      const same = cands.filter((id) => allTypes[id].package === pkg);
      if (same.length === 1) return same[0];
    }
    const root = cands.filter((id) => allTypes[id].package === 'zombie');
    if (root.length === 1) return root[0];
    const nested = cands.filter((id) => allTypes[id].parentType === null);
    if (nested.length === 1) return nested[0];
    return null;
  }

  /** Resolve a simple name using imports + same package, for member type refs. */
  function resolveSimple(name, pkg, imports, samePkgIndex) {
    if (!name) return null;
    const direct = classByFqn.get(name);
    if (direct) return direct.id;
    const same = samePkgIndex.get(name);
    if (same !== undefined) return same;
    for (const raw of imports) {
      const imp = typeof raw === 'string' ? raw : raw.name;
      if (imp.endsWith('.' + name)) {
        const c = classByFqn.get(imp);
        if (c) return c.id;
      }
      if (imp.endsWith('.*')) {
        const c = classByFqn.get(imp.slice(0, -1) + name);
        if (c) return c.id;
      }
    }
    return null;
  }

  // simple-name index per package (classes that are the only bearer of that name
  // in their package win; ambiguous names are dropped as unreliable).
  const pkgSimpleIndex = new Map();
  for (const [pkg, ids] of byPackage) {
    const m = new Map();
    const counts = new Map();
    for (const id of ids) {
      const s = allTypes[id].name;
      counts.set(s, (counts.get(s) || 0) + 1);
      m.set(s, id);
    }
    for (const [s, c] of counts) if (c > 1) m.delete(s);
    pkgSimpleIndex.set(pkg, m);
  }

  // ---- dependency graph ------------------------------------------------------
  const classEdges = new Map(); // "from>to" -> weight
  const addEdge = (from, to) => {
    if (from === to) return;
    const k = from * 100000 + to;
    classEdges.set(k, (classEdges.get(k) || 0) + 1);
  };

  for (const t of allTypes) {
    // Imports belong to the *file*: attributing the whole import list to every
    // nested type would give each inner class the fan-out of its outer class.
    // Nested types still get edges from the type references in their own members.
    if (t.parentType) continue;
    const imports = t.fileImports;
    for (const imp of imports) {
      if (imp.static) continue;
      if (imp.name.endsWith('.*')) {
        const ids = byPackage.get(imp.name.slice(0, -2));
        if (ids) for (const id of ids) addEdge(t.id, id);
        continue;
      }
      const c = classByFqn.get(imp.name);
      if (c) addEdge(t.id, c.id);
    }
  }

  // ---- fully-qualified references -------------------------------------------
  // The decompiler writes `zombie.foo.Bar` inline whenever a plain name would be
  // ambiguous, so those references are real coupling the import graph never sees.
  // Each hit is attributed to the innermost type whose body contains it.
  {
    const typesByPath = new Map();
    for (const t of allTypes) {
      if (!typesByPath.has(t.path)) typesByPath.set(t.path, []);
      typesByPath.get(t.path).push(t);
    }
    let fqnEdges = 0;
    for (const abs of files) {
      const rel = `${MOUNT()}/${path.relative(SRC_DIR(), abs).split(path.sep).join('/')}`;
      const owners = typesByPath.get(rel);
      if (!owners || !owners.length) continue;

      for (const run of refsByPath.get(rel) ?? []) {
        // resolve to the longest prefix that names a known type
        let name = run.text;
        let target = classByFqn.get(name);
        while (!target && name.includes('.')) {
          name = name.slice(0, name.lastIndexOf('.'));
          target = classByFqn.get(name);
        }
        if (!target) continue;
        let owner = null;
        for (const t of owners) {
          if (run.start > t.bodyStart && run.start < t.bodyEnd) {
            if (!owner || t.bodyEnd - t.bodyStart < owner.bodyEnd - owner.bodyStart) owner = t;
          }
        }
        if (!owner || owner.id === target.id) continue;
        addEdge(owner.id, target.id);
        fqnEdges++;
      }
    }
    if (!QUIET) process.stderr.write(`[extract] ${fqnEdges} fully-qualified references resolved\n`);
  }

  // Module edges represent literal Python imports and C++ includes.
  const moduleByPath = new Map(allTypes.filter((type) => type.kind === 'module').map((type) => [type.path, type]));
  for (const [fromPath, targets] of fileTargets) {
    const from = moduleByPath.get(fromPath);
    if (!from) continue;
    for (const target of targets) {
      const to = moduleByPath.get(target);
      if (to) addEdge(from.id, to.id);
    }
  }

  const incoming = new Map();
  const outgoing = new Map();
  for (const k of classEdges.keys()) {
    const from = Math.floor(k / 100000);
    const to = k % 100000;
    if (!outgoing.has(from)) outgoing.set(from, new Set());
    outgoing.get(from).add(to);
    if (!incoming.has(to)) incoming.set(to, new Set());
    incoming.get(to).add(from);
  }

  // ---- supertypes ------------------------------------------------------------
  for (const t of allTypes) {
    t.superIds = t.extends.map((r) => resolveRef(r, t.package, t.fileImports, t.path, t)).filter((x) => x !== null && x !== undefined);
    t.ifaceIds = t.implements.map((r) => resolveRef(r, t.package, t.fileImports, t.path, t)).filter((x) => x !== null && x !== undefined);
    t.subIds = [];
  }
  for (const t of allTypes) {
    for (const s of [...t.superIds, ...t.ifaceIds]) allTypes[s].subIds.push(t.id);
  }

  // ---- member refinements ----------------------------------------------------
  const LUA_ANNOT = 'UsedFromLua';
  const HIDDEN_ANNOT = 'HiddenFromLua';

  for (const t of allTypes) {
    t.methods = t.members.filter((m) => m.k === 'method' || m.k === 'ctor');
    t.fields = t.members.filter((m) => m.k === 'field');
    t.branch = t.methods.reduce((a, m) => a + (m.branch || 0), 0);
    t.complexity = t.methods.reduce((a, m) => a + (m.complexity || 0), 0);
    t.luaMethods = t.methods.filter((m) => m.annotations.includes(LUA_ANNOT)).length;
    t.luaFields = t.fields.filter((m) => m.annotations.includes(LUA_ANNOT)).length;
    t.luaExposed = t.annotations.includes(LUA_ANNOT) || t.luaMethods > 0 || t.luaFields > 0;
    t.hiddenFromLua = t.annotations.includes(HIDDEN_ANNOT);
    t.doc = t.doc || null;
    t.docSummary = t.doc ? t.doc.split('\n').find((l) => l.trim()) || null : null;
    t.stereotype = stereotype(t);
    // resolve member type references for the "uses types" panel
    const idx = pkgSimpleIndex.get(t.package) || new Map();
    const refs = new Set();
    for (const m of t.members) {
      const cand = [m.type, ...(m.params || []).map((p) => p.type)];
      for (const c of cand) {
        const id = t.language === 'java'
          ? resolveSimple(simpleName(normalizeTypeRef(c || '')), t.package, t.fileImports, idx)
          : resolveRef(c || '', t.package, t.fileImports, t.path, t);
        if (id !== null && id !== undefined && id !== t.id) refs.add(id);
      }
    }
    t.typeRefIds = [...refs];
    for (const id of t.typeRefIds) addEdge(t.id, id);
    t.fanOut = outgoing.get(t.id) ? outgoing.get(t.id).size : 0;
    t.fanIn = incoming.get(t.id) ? incoming.get(t.id).size : 0;
    t.memberCount = t.members.length;
    t.weight = codeWeight(t);
  }

  function codeWeight(t) {
    return t.code;
  }

  incoming.clear();
  outgoing.clear();
  for (const key of classEdges.keys()) {
    const from = Math.floor(key / 100000), to = key % 100000;
    if (!outgoing.has(from)) outgoing.set(from, new Set());
    if (!incoming.has(to)) incoming.set(to, new Set());
    outgoing.get(from).add(to);
    incoming.get(to).add(from);
  }
  for (const type of allTypes) {
    type.fanIn = incoming.get(type.id)?.size ?? 0;
    type.fanOut = outgoing.get(type.id)?.size ?? 0;
  }

  // ---- fine-grained references ------------------------------------------------
  // Sites were collected symbolically while each file was parsed; now that every
  // type has an id and its supertypes are resolved, they can be pinned down.
  const references = skipRefs
    ? { counts: null, byShape: null, perClass: new Map(), chains: null }
    : buildReferences({ allTypes, sitesByPath, flowByPath, resolveRef });
  const refSummary = skipRefs ? { classRows: [], rankings: {} } : summarise(allTypes, references.perClass, references.chains);
  if (!QUIET && !skipRefs) {
    const c = references.counts;
    process.stderr.write(
      `[extract] ${c.sites} sites (${c.call} calls, ${c.read} reads, ${c.write} writes, ${c.new} creations): ` +
        `${c.resolved} resolved to a member, ${c.classOnly} to a class only, ${c.unresolved} unresolved\n` +
        `[extract] flow: ${c.flow.paramStores} parameter stores, ${c.flow.returns} returns, ${c.flow.registers} callback registrations; ` +
        `${c.chains.sites} chains\n`
    );
  }

  // ---- package tree ----------------------------------------------------------
  const pkgMetrics = new Map(); // pkg -> aggregate
  function blankAgg(name) {
    return {
      name,
      classes: 0,
      interfaces: 0,
      enums: 0,
      records: 0,
      annotations: 0,
      modules: 0,
      loc: 0,
      code: 0,
      comment: 0,
      blank: 0,
      bytes: 0,
      methods: 0,
      fields: 0,
      complexity: 0,
      branch: 0,
      luaExposed: 0,
      fanIn: 0,
      fanOut: 0,
      ids: [],
    };
  }
  for (const t of allTypes) {
    const parts = t.package === '(default)' ? ['(default)'] : t.package.split('.');
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join('.');
      if (!pkgMetrics.has(p)) pkgMetrics.set(p, blankAgg(p));
      const a = pkgMetrics.get(p);
      a.ids.push(t.id);
      a.loc += t.loc;
      a.code += t.code;
      a.comment += t.commentOnly;
      a.blank += t.blank;
      a.bytes += t.bytes;
      a.methods += t.methods.length;
      a.fields += t.fields.length;
      a.complexity += t.complexity;
      a.branch += t.branch;
      if (t.luaExposed) a.luaExposed++;
      if (t.kind === 'class') a.classes++;
      else if (t.kind === 'interface') a.interfaces++;
      else if (t.kind === 'enum') a.enums++;
      else if (t.kind === 'record') a.records++;
      else if (t.kind === 'module') a.modules++;
      else a.annotations++;
    }
    // fan in/out are per class; package aggregates sum them (documented as such)
  }

  // package-level dependency edges
  const pkgEdge = new Map();
  for (const k of classEdges.keys()) {
    const from = Math.floor(k / 100000);
    const to = k % 100000;
    const fp = allTypes[from].package;
    const tp = allTypes[to].package;
    if (fp === tp) continue;
    const kk = fp + '\u0000' + tp;
    pkgEdge.set(kk, (pkgEdge.get(kk) || 0) + 1);
  }

  // roll fanIn/fanOut to packages
  const pkgFanIn = new Map();
  const pkgFanOut = new Map();
  for (const [kk, w] of pkgEdge) {
    const [fp, tp] = kk.split('\u0000');
    for (const anc of ancestorsOf(fp)) pkgFanOut.set(anc, (pkgFanOut.get(anc) || 0) + w);
    for (const anc of ancestorsOf(tp)) pkgFanIn.set(anc, (pkgFanIn.get(anc) || 0) + w);
  }
  function ancestorsOf(p) {
    const parts = p.split('.');
    const out = [];
    for (let i = 1; i <= parts.length; i++) out.push(parts.slice(0, i).join('.'));
    return out;
  }
  for (const [p, a] of pkgMetrics) {
    a.fanOut = pkgFanOut.get(p) || 0;
    a.fanIn = pkgFanIn.get(p) || 0;
  }

  // build nested tree
  const pkgTree = { name: '__root__', path: '', children: [] };
  const pkgNodeByPath = new Map([['', pkgTree]]);
  for (const p of [...pkgMetrics.keys()].sort()) {
    const parts = p.split('.');
    let parentPath = '';
    for (let i = 0; i < parts.length; i++) {
      const cur = parts.slice(0, i + 1).join('.');
      if (!pkgNodeByPath.has(cur)) {
        const node = { name: parts[i], path: cur, children: [] };
        pkgNodeByPath.set(cur, node);
        pkgNodeByPath.get(parentPath).children.push(node);
      }
      parentPath = cur;
    }
  }
  // attach aggregates (without ids) to nodes
  function attach(node) {
    const agg = pkgMetrics.get(node.path);
    node.metrics = agg
      ? {
          classes: agg.classes,
          interfaces: agg.interfaces,
          enums: agg.enums,
          records: agg.records,
          annotations: agg.annotations,
          modules: agg.modules,
          loc: agg.loc,
          code: agg.code,
          comment: agg.comment,
          blank: agg.blank,
          bytes: agg.bytes,
          methods: agg.methods,
          fields: agg.fields,
          complexity: agg.complexity,
          branch: agg.branch,
          luaExposed: agg.luaExposed,
          fanIn: agg.fanIn,
          fanOut: agg.fanOut,
          types: agg.ids.length,
        }
      : null;
    node.domain = node.path ? domainOf(node.path) : 'root';
    for (const c of node.children) attach(c);
  }
  attach(pkgTree);
  for (const n of pkgNodeByPath.values()) if (n !== pkgTree) n.children.sort((a, b) => a.name.localeCompare(b.name));

  // ---- emit ------------------------------------------------------------------
  // Refuse an output root that would overwrite source files or the project itself.
  if (OUT_DIR === srcDir || OUT_DIR === HERE || OUT_DIR === path.dirname(HERE)) {
    throw new Error('Data output must be a dedicated directory, separate from the source/project root.');
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const previousShards = ['members', 'refs'].flatMap((dir) => {
    const folder = path.join(OUT_DIR, dir);
    return fs.existsSync(folder) ? fs.readdirSync(folder).filter((name) => name.endsWith('.json')).map((name) => `${dir}/${name}`) : [];
  });
  const emitted = new Set();
  fs.mkdirSync(path.join(OUT_DIR, 'members'), { recursive: true });

  const write = (rel, obj) => {
    emitted.add(rel);
    const p = path.join(OUT_DIR, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, PRETTY ? JSON.stringify(obj, null, 2) : JSON.stringify(obj));
    const sz = fs.statSync(p).size;
    if (!QUIET) process.stderr.write(`[extract] wrote ${rel} (${(sz / 1024).toFixed(1)} KB)\n`);
    return sz;
  };

  // classes.json : compact columnar records
  const classRows = allTypes.map((t) => [
    t.id,
    t.name,
    t.package,
    { class: 0, interface: 1, enum: 2, record: 3, annotation: 4, module: 5 }[t.kind] ?? 0,
    t.code,
    t.loc,
    t.commentOnly,
    t.blank,
    t.bytes,
    t.methods.length,
    t.fields.length,
    t.complexity,
    t.memberCount,
    t.superIds,
    t.ifaceIds,
    t.subIds,
    t.modifiers.join(' '),
    t.luaExposed ? 1 : 0,
    t.hiddenFromLua ? 1 : 0,
    t.stereotype,
    t.declLine,
    t.path,
    t.parentType,
    t.docSummary,
    t.fanIn,
    t.fanOut,
    t.enumConstants.length,
    t.annotations,
    t.language,
    t.fqn,
  ]);
  const CLASS_COLS = [
    'id',
    'name',
    'package',
    'kind',
    'code',
    'loc',
    'comment',
    'blank',
    'bytes',
    'methods',
    'fields',
    'complexity',
    'members',
    'superIds',
    'ifaceIds',
    'subIds',
    'modifiers',
    'luaExposed',
    'hiddenFromLua',
    'stereotype',
    'declLine',
    'path',
    'parentType',
    'doc',
    'fanIn',
    'fanOut',
    'enumConstants',
    'annotations',
    'language',
    'fqn',
  ];

  // members/<slug>.json : { <classId>: [members...] }
  const slugOf = (p) => (p === '(default)' ? '_default' : p.replace(/\./g, '__'));
  const membersByPkg = new Map();
  const refsByPkg = new Map();
  for (const t of allTypes) {
    const slug = slugOf(t.package);
    if (!membersByPkg.has(slug)) membersByPkg.set(slug, {});
    membersByPkg.get(slug)[t.id] = {
      enumConstants: t.enumConstants,
      members: t.members.map((m) => [
        m.k,
        m.name,
        m.type || '',
        (m.params || []).map((p) => `${p.type} ${p.name}`.trim()),
        m.modifiers.join(' '),
        m.annotations,
        m.line,
        m.complexity || 0,
        m.bodyLines || 0,
        m.doc || null,
        m.throws || [],
        m.init || null,
      ]),
    };
  }
  const MEMBER_COLS = ['kind', 'name', 'type', 'params', 'modifiers', 'annotations', 'line', 'complexity', 'bodyLines', 'doc', 'throws', 'init'];
  for (const [slug, payload] of membersByPkg) write(`members/${slug}.json`, payload);

  // refs/<slug>.json : per member, the rows out of it and into it
  const REF_COLS = ['line', 'kind', 'name', 'out', 'in', 'flow'];
  const refCounts = { classes: 0, members: 0, rows: 0 };
  for (const t of allTypes) {
    const byLine = references.perClass.get(t.id);
    if (!byLine) continue;
    const slug = slugOf(t.package);
    let payload = refsByPkg.get(slug);
    if (!payload) refsByPkg.set(slug, (payload = {}));
    const members = [];
    for (const [line, entry] of [...byLine.entries()].sort((a, b) => a[0] - b[0])) {
      const member = t.members.find((m) => m.line === line);
      const f = entry.flow;
      const flow = f && (f.paramsToFields.size || f.returns.size || f.registers.size)
        ? {
            p: [...f.paramsToFields.values()],
            r: [...f.returns.values()],
            g: [...f.registers.values()],
          }
        : null;
      members.push([
        line,
        member ? (member.k === 'field' ? 'field' : 'method') : 'synthetic',
        member ? member.name : '?',
        entry.out.size ? [...entry.out.values()] : null,
        entry.in.size ? [...entry.in.values()] : null,
        flow,
      ]);
      refCounts.rows += entry.out.size + entry.in.size;
    }
    refCounts.classes++;
    refCounts.members += members.length;
    payload[t.id] = { members };
  }
  if (!skipRefs) for (const [slug, payload] of refsByPkg) write(`refs/${slug}.json`, payload);

  const meta = {
    generated: new Date().toISOString(),
    schemaVersion: 3,
    languages: [...engines.keys()],
    capabilities: { structure: true, fileDependencies: true, memberReferences: engines.has('java') && !skipRefs },
    languageCapabilities: Object.fromEntries([...engines].map(([id, adapter]) => [id, {
      ...adapter.capabilities, memberReferences: adapter.capabilities.memberReferences && !skipRefs,
    }])),
    parser: 'tree-sitter',
    extractor: { parser: versions.grammar, runtime: versions.runtime },
    parseErrors: { files: parseErrorFiles.length, names: parseErrorFiles.slice(0, 20) },
    sourceRoot: source().display,
    sourceMount: MOUNT(),
    sourceRootAbs: SRC_DIR(),
    sourceDirOrigin: source().origin,
    decompiler: (() => {
      const f = files[0];
      if (!f || !engines.has('java') || engines.size > 1) return null;
      const line = fs.readFileSync(f, 'utf8').split('\n', 1)[0];
      return line.replace(/^\/\/\s*/, '');
    })(),
    counts: {
      files: fileRecords.length,
      types: allTypes.length,
      packages: pkgMetrics.size,
      classEdges: classEdges.size,
      pkgEdges: pkgEdge.size,
      loc: allTypes.reduce((a, t) => a + t.loc, 0),
      code: allTypes.reduce((a, t) => a + t.code, 0),
      bytes: allTypes.reduce((a, t) => a + t.bytes, 0),
      methods: allTypes.reduce((a, t) => a + t.methods.length, 0),
      fields: allTypes.reduce((a, t) => a + t.fields.length, 0),
      luaExposed: allTypes.filter((t) => t.luaExposed).length,
      luaMembers: allTypes.reduce((a, t) => a + t.luaMethods + t.luaFields, 0),
    },
    domains: engines.size === 1 && engines.has('java') ? DOMAINS : {},
    classColumns: CLASS_COLS,
    memberColumns: MEMBER_COLS,
    refColumns: ['line', 'kind', 'name', 'out', 'in'],
    refKinds: skipRefs ? [] : REF_KINDS,
    refCounts: null,
    metrics: {
      code: 'Non-blank, non-comment source lines',
      loc: 'Total source lines',
      bytes: 'File size in bytes',
      methods: 'Declared methods + constructors',
      fields: 'Declared fields',
      complexity: 'Sum of 1 + branch points (if/for/while/case/catch/&&/||/?:)',
      members: 'Methods + fields + enum constants',
      fanIn: 'Distinct classes in the tree that reference this class',
      fanOut: 'Distinct classes in the tree this class references',
      luaExposed: 'Types carrying @UsedFromLua',
    },
  };

  meta.refCounts = skipRefs ? null : { ...references.counts, byShape: references.byShape, rows: refCounts.rows };
  if (!QUIET && !skipRefs) {
    process.stderr.write(
      `[extract] ${refCounts.rows} member reference rows in ${refsByPkg.size} shards ` +
        `(${refCounts.classes} classes with references)\n`
    );
  }
  if (!skipRefs) write('refs/meta.json', {
    version: 1,
    columns: {
      shard: REF_COLS,
      row: ['toClassId', 'toLine', 'kind', 'count', 'lines'],
      flow: {
        p: '[parameterIndex, fieldLine] — a parameter stored into a field',
        r: '[provenance, ref] — what a returned value is; 0 param (ref = index), 1 field (ref = line), 2 local, 3 call, 4 literal, 5 creation, 6 other',
        g: '[classId, line, argShape] — a callback registered with another member (1 = this, 2 = lambda/method reference)',
      },
    },
    kinds: REF_KINDS,
    counts: { ...references.counts, byShape: references.byShape, rows: refCounts.rows, shards: refsByPkg.size },
  });
  if (!skipRefs) {
    const chains = references.chains;
    write('refs/chains.json', {
      histogram: [...chains.depths.entries()].sort((a, b) => a[0] - b[0]),
      deepest: [...chains.deepest].sort((a, b) => b.path.length - a.path.length).slice(0, 120),
    });
    write('refs/summary.json', {
      columns: ['classId', 'outCalls', 'inCalls', 'outReads', 'inReads', 'outWrites', 'inWrites'],
      classRows: refSummary.classRows,
      rankings: refSummary.rankings,
    });
  }
  write('meta.json', meta);
  write('packages.json', pkgTree);
  write('classes.json', { columns: CLASS_COLS, rows: classRows });
  write('hierarchy.json', {
    roots: allTypes.filter((t) => t.kind !== 'module' && t.superIds.length === 0 && t.ifaceIds.length === 0).map((t) => t.id),
  });
  write(
    'deps-packages.json',
    [...pkgEdge.entries()]
      .map(([k, w]) => {
        const [from, to] = k.split('\u0000');
        return [from, to, w];
      })
      .sort((a, b) => b[2] - a[2])
  );
  write('deps-classes.json', [...classEdges.entries()].map(([k, w]) => [Math.floor(k / 100000), k % 100000, w]));

  // ---- insights.json: precomputed rankings the UI would otherwise have to scan
  // the whole member space for.
  const allMethods = [];
  for (const t of allTypes) {
    for (const m of t.methods) {
      if (m.k === 'ctor') continue;
      allMethods.push({
        classId: t.id,
        name: m.name,
        type: m.type,
        params: (m.params || []).map((p) => p.type),
        complexity: m.complexity,
        branch: m.branch,
        bodyLines: m.bodyLines,
        line: m.line,
        path: t.path,
        pkg: t.package,
        cls: t.name,
        annotations: m.annotations,
      });
    }
  }
  const topMethods = allMethods
    .filter((m) => m.bodyLines >= 12)
    .sort((a, b) => b.complexity - a.complexity)
    .slice(0, 120);

  const histogram = (values) => {
    const m = new Map();
    for (const v of values) m.set(v, (m.get(v) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };

  const rank = (fn, n = 40) =>
    [...allTypes].sort((a, b) => fn(b) - fn(a)).slice(0, n).map((t) => [t.id, Math.round(fn(t) * 100) / 100]);

  const pkgPairs = [...pkgEdge.entries()]
    .map(([k, w]) => {
      const [from, to] = k.split('\u0000');
      return [from, to, w];
    })
    .sort((a, b) => b[2] - a[2])
    .slice(0, 120);

  write('insights.json', {
    topMethods,
    top: {
      code: rank((t) => t.code),
      complexity: rank((t) => t.complexity),
      fanIn: rank((t) => t.fanIn, 30),
      fanOut: rank((t) => t.fanOut, 30),
      methods: rank((t) => t.methods.length, 30),
      fields: rank((t) => t.fields.length, 30),
      density: rank((t) => (t.code > 40 ? t.complexity / t.code : 0), 30),
      luaMembers: rank((t) => t.luaMethods + t.luaFields, 30),
    },
    histograms: {
      annotations: histogram(allTypes.flatMap((t) => t.annotations)).slice(0, 30),
      stereotypes: histogram(allTypes.map((t) => t.stereotype)),
      kinds: histogram(allTypes.map((t) => t.kind)),
      domains: histogram(allTypes.map((t) => t.package.split('.')[0])),
      packages: histogram(allTypes.map((t) => t.package)).slice(0, 40),
    },
    packageCoupling: pkgPairs,
  });

  if (!QUIET) {
    process.stderr.write(
      `[extract] ${files.length} files -> ${allTypes.length} types, ${allMethods.length} methods, ` +
        `${classEdges.size} class refs into ${path.relative(process.cwd(), OUT_DIR) || '.'} in ${Date.now() - t0}ms\n`
    );
  }

  for (const shard of previousShards) if (!emitted.has(shard)) fs.unlinkSync(path.join(OUT_DIR, shard));

  return { files: files.length, types: allTypes.length, out: OUT_DIR, src: srcDir, mount, parser: 'tree-sitter' };
}

// Run when invoked directly (`node tools/extract.mjs`), stay quiet when imported.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  runExtraction().catch((err) => {
    process.stderr.write(`[extract] ${err.message}\n`);
    process.exit(1);
  });
}
