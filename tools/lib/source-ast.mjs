/** Python and C++ adapters. Java keeps its existing, deeper reference analysis. */
import fs from 'node:fs';
import path from 'node:path';
import { lineTable } from './line-table.mjs';

const TYPES = { class_definition: 'class', class_specifier: 'class', struct_specifier: 'class', union_specifier: 'class', enum_specifier: 'enum' };
const FUNCTIONS = new Set(['function_definition']);
const BRANCHES = new Set([
  'if_statement', 'elif_clause', 'for_statement', 'for_in_clause', 'while_statement', 'do_statement',
  'except_clause', 'catch_clause', 'case_statement', 'conditional_expression',
]);
const field = (node, name) => node?.childForFieldName(name);
const first = (node, type) => node?.namedChildren.find((child) => child.type === type);
const cleanName = (text = '') => text.replace(/::/g, '.');

function complexity(node) {
  let branches = 0;
  const visit = (current) => {
    if (current !== node && (FUNCTIONS.has(current.type) || TYPES[current.type])) return;
    if (BRANCHES.has(current.type) && !current.text.startsWith('default')) branches++;
    if (current.type === 'boolean_operator' || current.type === 'binary_expression') {
      const op = field(current, 'operator')?.text;
      if (['and', 'or', '&&', '||'].includes(op)) branches++;
    }
    for (const child of current.namedChildren) visit(child);
  };
  visit(node);
  return { branch: branches, complexity: branches + 1 };
}

function cppDeclarator(node) {
  if (!node) return null;
  if (node.type === 'function_declarator') return node;
  for (const child of node.namedChildren) {
    if (child.type === 'parameter_list') continue;
    const found = cppDeclarator(child);
    if (found) return found;
  }
  return null;
}

function declaratorName(node) {
  if (!node) return '';
  if (['identifier', 'field_identifier', 'qualified_identifier', 'destructor_name', 'operator_name'].includes(node.type)) return cleanName(node.text);
  return declaratorName(field(node, 'declarator'));
}

function docOf(node, language) {
  if (language === 'python') {
    const statement = field(node, 'body')?.namedChildren[0];
    const string = statement?.type === 'expression_statement' ? statement.namedChildren[0] : null;
    if (string?.type === 'string') return string.text.replace(/^[uUrR]*(?:"""|'''|"|')/, '').replace(/(?:"""|'''|"|')$/, '').trim();
  }
  const comment = node.previousNamedSibling;
  if (comment?.type === 'comment' && node.startPosition.row - comment.endPosition.row <= 1) {
    return comment.text.replace(/^\/\*\*?|\*\/$/g, '').replace(/^\s*(?:\/\/\/?|\*)\s?/gm, '').trim();
  }
  return null;
}

function methodOf(node, owner, language) {
  const decl = language !== 'python' ? cppDeclarator(field(node, 'declarator')) : node;
  const name = language !== 'python' ? declaratorName(field(decl, 'declarator')) : field(node, 'name')?.text;
  const parameters = field(decl, 'parameters');
  const params = (parameters?.namedChildren ?? []).map((param) => ({
    name: language !== 'python' ? declaratorName(field(param, 'declarator')) : (field(param, 'name') ?? param.namedChildren.find((c) => c.type === 'identifier'))?.text ?? param.text,
    type: field(param, 'type')?.text ?? '',
  }));
  const body = field(node, 'body');
  const ctor = owner.kind !== 'module' && (name === owner.name || name === '__init__');
  return {
    k: ctor ? 'ctor' : 'method', name: name ?? '?',
    type: (field(node, language === 'python' ? 'return_type' : 'type'))?.text ?? '',
    params, modifiers: [], annotations: [], line: node.startPosition.row + 1,
    bodyLines: body ? body.endPosition.row - body.startPosition.row + 1 : 0,
    ...complexity(body ?? node), doc: docOf(node, language), throws: [], init: null,
  };
}

/** Resolve literal module dependencies only; expressions remain unresolved. */
function dependenciesOf(root, language) {
  const dependencies = [];
  if (language === 'python') {
    for (const node of root.descendantsOfType(['import_statement', 'import_from_statement'])) {
      if (node.type === 'import_from_statement') {
        const module = field(node, 'module_name')?.text ?? '';
        // The base module is a dependency too (from package import symbol).
        dependencies.push({ kind: 'python', name: module });
        for (const name of node.childrenForFieldName('name')) {
          const imported = field(name, 'name')?.text ?? name.text;
          dependencies.push({ kind: 'python', name: `${module}${module.endsWith('.') ? '' : '.'}${imported}` });
        }
      } else {
        for (const name of node.childrenForFieldName('name')) {
          dependencies.push({ kind: 'python', name: field(name, 'name')?.text ?? name.text });
        }
      }
    }
  } else {
    for (const node of root.descendantsOfType('preproc_include')) {
      const target = field(node, 'path');
      if (['string_literal', 'system_lib_string'].includes(target?.type)) dependencies.push({ kind: 'include', name: target.text.slice(1, -1) });
    }
  }
  return dependencies;
}

function pythonBindings(root) {
  const bindings = [];
  for (const node of root.descendantsOfType(['import_statement', 'import_from_statement'])) {
    for (const entry of node.childrenForFieldName('name')) {
      const name = field(entry, 'name')?.text ?? entry.text;
      const alias = field(entry, 'alias')?.text;
      bindings.push(node.type === 'import_from_statement'
        ? { local: alias ?? name, module: field(node, 'module_name')?.text ?? '', symbol: name }
        : { local: alias ?? name, module: name, symbol: null });
    }
  }
  return bindings;
}

export function parseSourceFileWith(parser, absPath, relPath, language) {
  const src = fs.readFileSync(absPath, 'utf8');
  const tree = parser.parse(src);
  try {
    const root = tree.rootNode;
    const table = lineTable(src, root.descendantsOfType('comment'));
    const relative = relPath.slice(relPath.indexOf('/') + 1);
    const parts = relative.split('/');
    const filename = parts.pop();
    const pkg = parts.join('.') || '(default)';
    const moduleName = filename;
    const moduleFqn = `${language}:${relative}`;
    const record = (node, name, kind, parent, namespace = '') => {
      const start = node.startPosition.row + 1;
      const end = node.endPosition.row + 1;
      return {
        kind, name, fqn: parent ? `${parent.fqn}.${namespace}${name}` : moduleFqn,
        package: pkg, parentType: parent?.kind !== 'module' ? parent?.fqn ?? null : null,
        path: relPath, language, declLine: start, endLine: end,
        bodyStart: node.startIndex, bodyEnd: node.endIndex,
        modifiers: [], annotations: [], extends: [], implements: [], permits: [],
        members: [], enumConstants: [], doc: docOf(node, language), fileImports: [],
        ...table.range(start, end), bytes: Buffer.byteLength(node.text, 'utf8'),
      };
    };
    const module = record(root, moduleName, 'module', null);
    Object.assign(module, table.range(1, table.loc), { bytes: Buffer.byteLength(src, 'utf8'), declLine: 1 });
    const types = [module];
    const spans = new Map([[module, { start: 1, end: table.loc, excluded: [] }]]);

    const walk = (node, owner, namespace = '') => {
      for (const child of node.namedChildren) {
        if (child.type === 'comment' || child.type === 'string') continue;
        if (child.type === 'namespace_definition') {
          const name = cleanName(field(child, 'name')?.text ?? '');
          const body = field(child, 'body');
          if (body) walk(body, owner, namespace + (name ? `${name}.` : ''));
          continue;
        }
        if (TYPES[child.type]) {
          const name = field(child, 'name')?.text ?? (node.type === 'type_definition' ? declaratorName(field(node, 'declarator')) : '');
          if (!name) continue;
          const rec = record(child, name, TYPES[child.type], owner, namespace);
          const bases = field(child, 'superclasses') ?? first(child, 'base_class_clause');
          rec.extends = (bases?.namedChildren ?? []).filter((n) => !['access_specifier', 'keyword_argument', 'argument_list'].includes(n.type)).map((n) => cleanName(n.text));
          if (rec.kind === 'enum') rec.enumConstants = (field(child, 'body')?.namedChildren ?? []).filter((n) => n.type === 'enumerator').map((n) => ({ name: field(n, 'name')?.text, line: n.startPosition.row + 1 }));
          types.push(rec);
          spans.set(rec, { start: rec.declLine, end: rec.endLine, excluded: [] });
          spans.get(owner).excluded.push(rec);
          const body = field(child, 'body');
          if (body) walk(body, rec);
          continue;
        }
        const functionDecl = language !== 'python' && ['declaration', 'field_declaration'].includes(child.type) && cppDeclarator(field(child, 'declarator'));
        if (FUNCTIONS.has(child.type) || functionDecl) {
          const member = methodOf(child, owner, language);
          if (namespace) member.name = namespace + member.name;
          // Declarations and definitions share a name but retain distinct source locations.
          owner.members.push(member);
          continue;
        }
        if (language === 'python' && child.type === 'assignment') {
          const left = field(child, 'left');
          if (left?.type === 'identifier') owner.members.push({
            k: 'field', name: left.text, type: field(child, 'type')?.text ?? '', params: [],
            line: child.startPosition.row + 1, modifiers: [], annotations: [],
            init: field(child, 'right')?.text.slice(0, 160) ?? null, doc: null,
          });
          continue;
        }
        if (language !== 'python' && ['declaration', 'field_declaration'].includes(child.type)) {
          for (const decl of child.childrenForFieldName('declarator')) {
            const name = declaratorName(decl);
            if (name) owner.members.push({
              k: 'field', name: namespace + name, type: field(child, 'type')?.text ?? '', params: [],
              line: child.startPosition.row + 1, modifiers: [], annotations: [], doc: null,
              init: field(decl, 'value')?.text.slice(0, 160) ?? null,
            });
          }
        }
        walk(child, owner, namespace);
      }
    };
    walk(root, module);

    // One owner per line, including sibling declarations on the same line.
    const lineOwners = new Int32Array(table.loc);
    types.forEach((rec, index) => {
      if (index) lineOwners.fill(index, rec.declLine - 1, rec.endLine);
      Object.assign(rec, { loc: 0, code: 0, blank: 0, commentOnly: 0 });
    });
    for (let line = 1; line <= table.loc; line++) {
      const rec = types[lineOwners[line - 1]];
      const stats = table.range(line, line);
      for (const key of ['loc', 'code', 'blank', 'commentOnly']) rec[key] += stats[key];
    }
    for (const rec of types) {
      const span = spans.get(rec);
      // Byte metrics are exclusive spans as well; subtract each direct child.
      for (const child of span.excluded) rec.bytes -= Buffer.byteLength(src.slice(child.bodyStart, child.bodyEnd), 'utf8');
    }
    return {
      types, refs: [], sites: null, flow: null,
      file: {
        path: relPath, pkg, language, ...table.range(1, table.loc), bytes: Buffer.byteLength(src, 'utf8'),
        imports: [], dependencies: dependenciesOf(root, language), bindings: language === 'python' ? pythonBindings(root) : [], typeCount: types.length,
        parseErrors: root.hasError ? Math.max(1, root.descendantsOfType('ERROR').length) : 0,
      },
    };
  } finally {
    tree.delete();
  }
}

/** File edges are deliberately separate from symbol resolution. */
export function fileDependencyResolver(files) {
  const indexes = new Map();
  for (const file of files) {
    const group = ['c', 'cpp'].includes(file.language) ? 'c-family' : file.language;
    if (!indexes.has(group)) indexes.set(group, new Map());
    indexes.get(group).set(file.path.slice(file.path.indexOf('/') + 1), file.path);
  }
  return (file) => {
    const byRelative = indexes.get(['c', 'cpp'].includes(file.language) ? 'c-family' : file.language);
    const relative = file.path.slice(file.path.indexOf('/') + 1);
    const targets = new Set();
    for (const dependency of file.dependencies ?? []) {
      let candidates;
      if (dependency.kind === 'python') {
        const dots = dependency.name.match(/^\.+/)?.[0].length ?? 0;
        const name = dependency.name.slice(dots).replaceAll('.', '/');
        const base = dots ? path.posix.join(path.posix.dirname(relative), '../'.repeat(dots - 1), name) : name;
        const bases = [base];
        if (!dots) {
          // Conventional src layout, or a source root that is itself a package.
          bases.push(`src/${base}`);
          const rootPackage = file.path.split('/')[0];
          if (base.startsWith(rootPackage + '/') && byRelative.has('__init__.py')) bases.push(base.slice(rootPackage.length + 1));
        }
        candidates = bases.flatMap((value) => [`${value}.py`, `${value}.pyi`, `${value}/__init__.py`, `${value}/__init__.pyi`]);
      } else {
        candidates = [path.posix.normalize(path.posix.join(path.posix.dirname(relative), dependency.name)), dependency.name];
      }
      let target = candidates.map((candidate) => byRelative.get(candidate)).find(Boolean);
      if (!target && dependency.kind === 'include') {
        const matches = [...byRelative].filter(([name]) => name.endsWith(`/${dependency.name}`));
        if (matches.length === 1) target = matches[0][1];
      }
      if (target && target !== file.path) targets.add(target);
    }
    return [...targets];
  };
}
