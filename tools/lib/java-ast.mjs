/**
 * The Java extractor: `tree-sitter-java`, one parse per file, then a walk.
 *
 * It is the only parser in the project — `tools/parity.mjs` guards the output
 * against drift, and `docs/parser-parity.md` records what replacing the earlier
 * hand-made scanner changed. Each record keeps the shape `tools/extract.mjs`
 * consumes, so resolution, aggregation and emission are unaffected by how the
 * declarations were found.
 *
 * Three properties are deliberate and load-bearing:
 *
 *   - **Semantics are inherited from the old scanner, not reinvented.** Member
 *     kinds, parameter text (varargs keep the `Object...` form), field
 *     `bodyLines` (the declaration span, not a body), `init` (masked text after
 *     the first top-level `=`), "nested types are not members", "static and
 *     instance initialisers are skipped" and the outermost-type-owns-the-file
 *     span rule all match what the shipped bundle contains. `tools/parity.mjs`
 *     is the gate that keeps them matching.
 *   - **Comments and literals are never parsed as code** — they are grammar
 *     nodes, so no masking pass is needed; the line accounting reads their
 *     ranges directly instead of blanking text.
 *   - **Line accounting is the corrected definition**: a line is a comment line
 *     only when every non-whitespace character on it lies inside a comment.
 *     The old `maskSource` also blanked string literals, so a line holding just
 *     a string counted as a comment (173 lines tree-wide, recorded in the
 *     ledger).
 *
 * The parser is loaded once per process and reused for every file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Parser, Language } from 'web-tree-sitter';
import { MODIFIERS, normalizeTypeRef } from './java-names.mjs';
import { collectSites, typeTextOf } from './java-refs.mjs';
import { lineTable } from './line-table.mjs';

const require = createRequire(import.meta.url);

/** Declaration keyword node type -> record kind. */
const TYPE_NODES = {
  class_declaration: 'class',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
  record_declaration: 'record',
  annotation_type_declaration: 'annotation',
};

/** Nodes that each contribute one branch point to a method's complexity. */
const BRANCH_NODES = new Set([
  'if_statement',
  'for_statement',
  'enhanced_for_statement',
  'while_statement',
  'do_statement',
  'catch_clause',
  'ternary_expression',
]);

/** Subtrees that never contain a type declaration or a reference we record. */
const OPAQUE_NODES = new Set(['line_comment', 'block_comment', 'string_literal', 'character_literal']);

const FQN_RE = /^zombie(?:\.[A-Za-z_$][\w$]*)+$/;
const DOC_START = /^\/\*\*[^/]/;

let parserPromise = null;

/**
 * Locate a dependency's package root by walking up from its entry file —
 * `require.resolve('<pkg>/package.json')` is unavailable for packages that
 * declare an `exports` map (`web-tree-sitter` does).
 */
function packageOf(specifier) {
  let dir = path.dirname(require.resolve(specifier));
  for (;;) {
    const file = path.join(dir, 'package.json');
    if (fs.existsSync(file)) {
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (pkg.name === specifier || specifier.startsWith(`${pkg.name}/`)) return { dir, pkg };
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`cannot locate the package root of ${specifier}`);
    dir = parent;
  }
}

/** Load (once) and return the shared parser plus the versions to record. */
export function javaParser() {
  if (!parserPromise) {
    parserPromise = (async () => {
      await Parser.init();
      const grammar = packageOf('tree-sitter-java');
      const language = await Language.load(path.join(grammar.dir, 'tree-sitter-java.wasm'));
      const parser = new Parser();
      parser.setLanguage(language);
      const runtime = packageOf('web-tree-sitter');
      return {
        parser,
        versions: {
          grammar: `tree-sitter-java@${grammar.pkg.version}`,
          runtime: `web-tree-sitter@${runtime.pkg.version}`,
        },
      };
    })();
  }
  return parserPromise;
}

/** Await the parser; the extractor calls this once before walking the tree. */
export async function initJavaParser() {
  return javaParser();
}

// ---------------------------------------------------------------------------
// line accounting
// ---------------------------------------------------------------------------

/**
 * Per-file line tables built from the grammar's comment nodes: which lines are
 * blank, comment-only or code, plus byte prefixes so any span can be measured.
 * @param {string} src
 * @param {import('web-tree-sitter').Node[]} comments
 */

// ---------------------------------------------------------------------------
// declaration heads
// ---------------------------------------------------------------------------

/**
 * Leading annotations then modifiers, in the order the old scanner read them:
 * annotations first, modifiers after, and anything that appears after a
 * non-modifier token is dropped (that is what the shipped bundle contains).
 */
function declHead(node) {
  const entries = [];
  for (const child of node.namedChildren) {
    if (child.type === 'annotation' || child.type === 'marker_annotation') {
      entries.push({ pos: child.startIndex, annotation: child });
    } else if (child.type === 'modifiers') {
      for (const m of child.children) {
        const isAnnotation = m.type === 'annotation' || m.type === 'marker_annotation';
        entries.push({ pos: m.startIndex, annotation: isAnnotation ? m : null, modifier: isAnnotation ? null : m.type });
      }
    }
  }
  entries.sort((a, b) => a.pos - b.pos);

  const annotations = [];
  const modifiers = [];
  let phase = 'annotations';
  for (const e of entries) {
    if (phase === 'annotations') {
      if (e.annotation) {
        annotations.push(e.annotation.childForFieldName('name')?.text ?? e.annotation.text.replace(/^@/, ''));
        continue;
      }
      phase = 'modifiers';
    }
    if (e.modifier && MODIFIERS.has(e.modifier)) {
      modifiers.push(e.modifier);
      continue;
    }
    break;
  }
  return { annotations, modifiers };
}

/** Heritage clauses in the same textual form the old parser produced. */
function heritage(node) {
  const extendsList = [];
  const implementsList = [];
  const permitsList = [];
  // `superclass` is the whole `extends X` clause: the keyword itself is a child,
  // so the type is its last named child. The old scanner recorded the type only.
  const superclass = node.childForFieldName('superclass');
  const superType = superclass?.namedChildren[superclass.namedChildren.length - 1];
  if (superType) extendsList.push(superType.text.trim());
  // interfaces extend their super-interfaces; the old scanner filed those under
  // `extends` as well, so the same references keep resolving the same way.
  const extendsInterfaces = node.namedChildren.find((c) => c.type === 'extends_interfaces');
  if (extendsInterfaces) {
    const list = extendsInterfaces.namedChildren.length === 1 && extendsInterfaces.namedChildren[0].type === 'type_list'
      ? extendsInterfaces.namedChildren[0].namedChildren
      : extendsInterfaces.namedChildren;
    for (const t of list) extendsList.push(t.text.trim());
  }
  const superInterfaces = node.childForFieldName('interfaces');
  if (superInterfaces) {
    const list = superInterfaces.namedChildren.length === 1 && superInterfaces.namedChildren[0].type === 'type_list'
      ? superInterfaces.namedChildren[0].namedChildren
      : superInterfaces.namedChildren;
    for (const t of list) implementsList.push(t.text.trim());
  }
  const permits = node.namedChildren.find((c) => c.type === 'permits');
  if (permits) for (const t of permits.namedChildren) permitsList.push(t.text.trim());
  return { extends: extendsList, implements: implementsList, permits: permitsList };
}

// ---------------------------------------------------------------------------
// complexity
// ---------------------------------------------------------------------------

/** 1 + branch points, over the canonical node set (documented in the ledger). */
function complexityOf(body, opts) {
  if (!body) return { branch: 0, complexity: 1 };
  let branch = 0;
  const stack = [body];
  while (stack.length) {
    const node = stack.pop();
    for (const child of node.namedChildren) {
      const type = child.type;
      if (BRANCH_NODES.has(type)) branch++;
      else if (type === 'binary_expression') {
        const op = child.childForFieldName('operator');
        if (op && (op.type === '&&' || op.type === '||')) branch++;
      } else if (type === 'switch_label') {
        // `default:` is not a branch point; `case` labels are (both `:` and `->`)
        const first = child.children[0];
        if (!(opts.excludeDefaultLabels && first && first.type === 'default')) branch++;
      }
      if (!OPAQUE_NODES.has(type)) stack.push(child);
    }
  }
  return { branch, complexity: 1 + branch };
}

// ---------------------------------------------------------------------------
// members
// ---------------------------------------------------------------------------

/** Comment and literal nodes inside a declaration, in source order. */
function opaqueNodes(node) {
  const out = [];
  const collect = (n) => {
    for (const child of n.namedChildren) {
      if (OPAQUE_NODES.has(child.type)) out.push(child);
      else collect(child);
    }
  };
  collect(node);
  return out.sort((a, b) => a.startIndex - b.startIndex);
}

/**
 * `src.slice(from, to)` with the interiors of every comment and literal blanked
 * and every offset preserved — the equivalent of what `maskSource()` produced
 * for the old scanner, computed for one span instead of the whole file.
 */
function maskRange(src, from, to, opaque) {
  let text = src.slice(from, to);
  for (const o of opaque) {
    const a = Math.max(o.startIndex, from);
    const b = Math.min(o.endIndex, to);
    if (b <= a) continue;
    const s = a - from;
    const e = b - from;
    text = text.slice(0, s) + text.slice(s, e).replace(/[^\n\r]/g, ' ') + text.slice(e);
  }
  return text;
}

function parameterOf(node) {
  const typeNode = node.childForFieldName('type');
  const nameNode = node.childForFieldName('name');
  const rawType = typeNode ? typeNode.text : '';
  // `Object... args` keeps the old textual form so the emitted signature is identical
  const type = node.type === 'spread_parameter' ? normalizeTypeRef(`${rawType}...`) : typeTextOf(typeNode);
  const name = node.type === 'receiver_parameter' ? 'this' : (nameNode?.text ?? '').replace(/\[.*$/, '');
  return { name, type };
}

function methodMember(node, rec, opts) {
  const { annotations, modifiers } = declHead(node);
  const isCtor = node.type === 'constructor_declaration' || node.type === 'compact_constructor_declaration';
  const name = isCtor ? rec.name : (node.childForFieldName('name')?.text ?? '');
  const typeNode = node.childForFieldName('type');
  const rawType = typeNode ? typeNode.text : '';
  const paramsNode = node.childForFieldName('parameters');
  const params = paramsNode ? paramsNode.namedChildren.map(parameterOf) : [];
  const throwsNode = node.namedChildren.find((c) => c.type === 'throws');
  const throws = throwsNode ? throwsNode.namedChildren.map((t) => typeTextOf(t)) : [];
  const body = node.childForFieldName('body');
  const { branch, complexity } = complexityOf(body, opts);
  return {
    k: isCtor ? 'ctor' : 'method',
    name,
    type: isCtor ? null : typeTextOf(typeNode),
    rawType: isCtor ? null : rawType,
    params,
    paramCount: params.length,
    throws,
    modifiers,
    annotations,
    line: node.startPosition.row + 1,
    branch,
    complexity,
    bodyLines: body ? body.text.split('\n').length - 1 : 0,
    abstract: modifiers.includes('abstract') || !body,
    enumConst: false,
  };
}

function fieldMember(node, src) {
  const { annotations, modifiers } = declHead(node);
  const typeNode = node.childForFieldName('type');
  const rawType = typeNode ? typeNode.text : '';
  const declarators = node.namedChildren.filter((c) => c.type === 'variable_declarator');
  const opaque = opaqueNodes(node);

  // The old scanner stopped the declaration head at the first top-level `{` —
  // an anonymous class body or a lambda block — and treated everything before it
  // as the field, so `x = new Foo() { … };` has `init: "new Foo()"`.
  let braceIndex = -1;
  {
    let parens = 0;
    let angles = 0;
    for (let i = node.startIndex; i < node.endIndex; i++) {
      const ch = src[i];
      if (ch === '(' || ch === '[') parens++;
      else if (ch === ')' || ch === ']') parens = Math.max(0, parens - 1);
      else if (ch === '<') angles++;
      else if (ch === '>') angles = Math.max(0, angles - 1);
      else if (ch === '{' && parens === 0 && angles === 0) {
        braceIndex = i;
        break;
      }
    }
  }
  const declEnd = braceIndex >= 0 ? braceIndex : src[node.endIndex - 1] === ';' ? node.endIndex - 1 : node.endIndex;

  // The declaration text was split at the first top-level `=`: names before it
  // are the field (plus `extraNames`), everything after it is `init`.
  const firstValue = declarators.find((d) => d.childForFieldName('value'))?.childForFieldName('value');
  let eqIndex = -1;
  if (firstValue) {
    for (let i = firstValue.startIndex - 1; i >= node.startIndex; i--) {
      if (src[i] === '=') {
        eqIndex = i;
        break;
      }
      if (!/\s/.test(src[i])) break;
    }
  }
  const nameOf = (d) => (d.childForFieldName('name')?.text ?? '?').replace(/\[.*$/, '');
  const inHead = eqIndex < 0 ? declarators : declarators.filter((d) => d.startIndex < eqIndex);
  const names = inHead.map(nameOf);
  const initText = eqIndex < 0 ? '' : maskRange(src, eqIndex + 1, declEnd, opaque).trim();

  // `bodyLines` for a field is the whole declaration span — including an
  // anonymous class or lambda block, which is where the old scanner stopped
  // (`memberEnd`), not the `init` cut point above.
  const spanEnd = src[node.endIndex - 1] === ';' ? node.endIndex - 1 : node.endIndex;
  return {
    k: 'field',
    name: names[0] ?? '?',
    bodyLines: maskRange(src, node.startIndex, spanEnd, opaque).split('\n').length - 1,
    extraNames: names.slice(1),
    type: typeTextOf(typeNode),
    rawType,
    modifiers,
    annotations,
    line: node.startPosition.row + 1,
    init: initText ? initText.slice(0, 160) : null,
    enumConst: false,
  };
}

function enumConstantOf(node) {
  const args = node.childForFieldName('arguments');
  return {
    name: node.childForFieldName('name')?.text ?? '?',
    argCount: args ? args.namedChildCount : 0,
    hasBody: !!node.childForFieldName('body'),
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    doc: null,
  };
}

/** Members declared directly in a type body — nested types and blocks are not members. */
function collectMembers(body, rec, src, opts) {
  const visit = (container) => {
    for (const child of container.namedChildren) {
      switch (child.type) {
        case 'enum_body_declarations':
          visit(child);
          break;
        case 'method_declaration':
        case 'annotation_type_element_declaration':
        case 'constructor_declaration':
        case 'compact_constructor_declaration':
          rec.members.push(methodMember(child, rec, opts));
          break;
        case 'field_declaration':
        case 'constant_declaration': // interface and annotation constants
          rec.members.push(fieldMember(child, src));
          break;
        case 'enum_constant':
          rec.enumConstants.push(enumConstantOf(child));
          break;
        default:
          break; // nested type (recorded as its own type), initialiser block, stray `;`
      }
    }
  };
  visit(body);
}

// ---------------------------------------------------------------------------
// the file
// ---------------------------------------------------------------------------

/**
 * Parse one `.java` file into the same shape `parseFile()` returned.
 *
 * @param {string} absPath
 * @param {{parser: import('web-tree-sitter').Parser, path: string, opts?: {excludeDefaultLabels?: boolean}}} ctx
 */
export function parseJavaFileWith(parser, absPath, relPath, opts = {}) {
  const src = fs.readFileSync(absPath, 'utf8');
  const tree = parser.parse(src);
  try {
    return extractFile(tree, src, relPath, opts);
  } finally {
    tree.delete();
  }
}

function extractFile(tree, src, rel, opts) {
  const collected = opts.references ? collectSites(tree.rootNode) : { sites: null, flow: null };
  const root = tree.rootNode;
  const comments = root.descendantsOfType(['line_comment', 'block_comment']);
  const table = lineTable(src, comments);

  const pkgNode = root.namedChildren.find((c) => c.type === 'package_declaration');
  const pkg = pkgNode ? pkgNode.namedChildren.map((c) => c.text).join('') : '(default)';

  const imports = [];
  for (const imp of root.namedChildren) {
    if (imp.type !== 'import_declaration') continue;
    const isStatic = imp.namedChildren.some((c) => c.type === 'static');
    const name = imp.namedChildren.filter((c) => c.type !== 'static').map((c) => c.text).join('');
    imports.push({ static: isStatic, name });
  }

  const types = [];
  const fqnRefs = new Map(); // startIndex -> text (longest wins)

  const considerRef = (node) => {
    const text = node.text;
    if (FQN_RE.test(text)) {
      const prev = fqnRefs.get(node.startIndex);
      if (!prev || prev.length < text.length) fqnRefs.set(node.startIndex, text);
    }
  };

  const makeType = (node, parent) => {
    const kind = TYPE_NODES[node.type];
    const name = node.childForFieldName('name')?.text ?? '?';
    const body = node.childForFieldName('body');
    const { annotations, modifiers } = declHead(node);
    const sup = heritage(node);
    const declLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;
    const rec = {
      kind,
      name,
      fqn: parent ? `${parent.fqn}.${name}` : pkg === '(default)' ? name : `${pkg}.${name}`,
      package: pkg,
      parentType: parent ? parent.fqn : null,
      path: rel,
      declLine,
      bodyStart: body ? body.startIndex : -1,
      // the old record stored the `}` offset, not the one past it
      bodyEnd: body ? body.endIndex - 1 : -1,
      endLine,
      modifiers,
      annotations,
      rawAnnotations: annotations.map((a) => `@${a}`),
      extends: sup.extends,
      implements: sup.implements,
      permits: sup.permits,
      members: [],
      enumConstants: [],
      doc: findDoc(comments, src, node),
      fileImports: imports,
      parseError: node.hasError,
    };
    const span = parent ? table.range(declLine, endLine) : table.range(1, table.loc);
    rec.loc = span.loc;
    rec.code = span.code;
    rec.commentOnly = span.commentOnly;
    rec.blank = span.blank;
    rec.bytes = parent ? table.bytesOfRange(declLine, endLine) : Buffer.byteLength(src, 'utf8');
    return rec;
  };

  const walk = (node, owner) => {
    for (const child of node.namedChildren) {
      const type = child.type;
      if (OPAQUE_NODES.has(type)) continue;
      if (TYPE_NODES[type]) {
        const rec = makeType(child, owner);
        types.push(rec);
        const body = child.childForFieldName('body');
        if (body) collectMembers(body, rec, src, opts);
        walk(child, rec);
        continue;
      }
      considerRef(child);
      walk(child, owner);
    }
  };
  walk(root, null);

  // References are attributed to the innermost type *body* containing them, and
  // references outside every body (imports, headers) are dropped — the rule the
  // shipped bundle was built with.
  const refs = [];
  for (const [start, text] of fqnRefs) refs.push({ start, text });
  refs.sort((a, b) => a.start - b.start);

  const parseErrors = root.hasError ? root.descendantsOfType(['ERROR', 'MISSING']).length : 0;

  return {
    types,
    refs,
    sites: opts.references ? collected.sites : null,
    flow: opts.references ? collected.flow : null,
    file: {
      path: rel,
      pkg,
      loc: table.loc,
      code: table.code,
      commentOnly: table.commentOnly,
      blank: table.blank,
      bytes: Buffer.byteLength(src, 'utf8'),
      imports,
      typeCount: types.length,
      parseErrors,
    },
  };
}

/** Nearest preceding javadoc with only whitespace and annotations in between. */
function findDoc(comments, src, node) {
  let best = null;
  for (const c of comments) {
    if (c.endIndex <= node.startIndex && /^[\s@\w$.,()\[\]"'\-]*$/.test(src.slice(c.endIndex, node.startIndex))) best = c;
    if (c.startIndex > node.startIndex) break;
  }
  if (!best || !DOC_START.test(best.text)) return null;
  return cleanDoc(best.text);
}

function cleanDoc(text) {
  return text
    .replace(/^\/\*\*?/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, '').trimEnd())
    .join('\n')
    .trim();
}