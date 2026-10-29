/**
 * Fine-grained references: what the coarse extractor deliberately does not see.
 *
 * `java-ast.mjs` records declarations and the class-level graph. This module
 * adds the layer below: every call site, field read and field write, attributed
 * to the member that contains it and resolved to the member it touches, so the
 * atlas can answer "who calls this", "who writes that field" and "which chain
 * does this expression walk" instead of only "these two types are coupled".
 *
 * Two deliberate properties:
 *
 *   - **Symbolic first, resolved later.** Sites are collected during the same
 *     walk that builds the coarse records, while the file is in hand, but they
 *     are recorded as *names and declared type texts*, never as ids: a file
 *     change renumbers everything downstream, so ids may only be assigned after
 *     every file has been read. Resolution runs once, globally, afterwards.
 *   - **Honest about failure.** A receiver the analysis cannot type is counted
 *     as unresolved instead of being guessed at. The summary reports how many
 *     sites resolved, resolved only to a class, or did not resolve at all, and
 *     the UI shows that confidence rather than hiding it.
 *
 * What this is not: there is no interprocedural dataflow, no aliasing or pointer
 * analysis, no generics inference beyond declared type arguments, and no
 * reflection or Lua call sites. Those are documented as limitations, not
 * approximated silently.
 */

import { normalizeTypeRef } from './java-names.mjs';

/** Site categories, in the order the artifacts encode them. */
export const REF_KINDS = ['call', 'read', 'write', 'new'];

/** Receiver shapes, for the resolution report. */
export const RECV_SHAPES = ['none', 'this', 'super', 'local', 'field', 'type', 'chain', 'other'];

/**
 * A declared type as text: generics and annotations stripped, dots closed up
 * (`GameProfiler.@Nullable ProfileArea` is one qualified name).
 */
export function typeTextOf(node) {
  if (!node) return '';
  return normalizeTypeRef(node.text).replace(/\s*\.\s*/g, '.');
}

/** Local name -> declared type text, for the identifiers a site can use. */
function declaredLocals(node) {
  const out = [];
  const type = typeTextOf(node.childForFieldName('type'));
  for (const d of node.namedChildren) {
    if (d.type !== 'variable_declarator') continue;
    const name = d.childForFieldName('name')?.text;
    if (name) out.push([name, type]);
  }
  return out;
}

/** Parameters of a method/lambda, as name -> type text. */
function declaredParams(node) {
  const out = [];
  const params = node.childForFieldName('parameters');
  if (!params) return out;
  for (const p of params.namedChildren) {
    const name = p.type === 'receiver_parameter' ? 'this' : p.childForFieldName('name')?.text;
    if (!name) continue;
    const raw = p.childForFieldName('type')?.text ?? '';
    out.push([name.replace(/\[.*$/, ''), normalizeTypeRef(p.type === 'spread_parameter' ? `${raw}...` : raw)]);
  }
  return out;
}

/** How a receiver expression can be typed, before the global index exists. */
function receiverOf(expr, scope) {
  if (!expr) return { shape: 'none' };
  switch (expr.type) {
    case 'this':
      return { shape: 'this' };
    case 'super':
      return { shape: 'super' };
    case 'identifier': {
      const known = scope.get(expr.text);
      return known ? { shape: 'local', typeText: known, name: expr.text } : { shape: 'type', name: expr.text };
    }
    case 'field_access': {
      const inner = receiverOf(expr.childForFieldName('object'), scope);
      const field = expr.childForFieldName('field')?.text ?? '';
      if (inner.shape === 'this') return { shape: 'field', onThis: true, name: field };
      return { shape: 'field', onThis: false, name: field, inner };
    }
    case 'method_invocation': {
      // `a.b().c()` — the steps *and* the receiver they hang off, so resolution
      // has somewhere to start: without the base, `b` would be looked up on the
      // enclosing type and almost every chain would come back unresolved.
      const chain = [];
      let cur = expr;
      while (cur && cur.type === 'method_invocation') {
        chain.unshift({ name: cur.childForFieldName('name')?.text ?? '' });
        cur = cur.childForFieldName('object');
      }
      return { shape: 'chain', chain, base: receiverOf(cur, scope) };
    }
    case 'object_creation_expression':
      return { shape: 'type', name: typeTextOf(expr.childForFieldName('type')) };
    case 'cast_expression':
      return { shape: 'type', name: typeTextOf(expr.childForFieldName('type')) };
    case 'parenthesized_expression':
      return receiverOf(expr.namedChildren[0], scope);
    case 'array_access':
      return receiverOf(expr.childForFieldName('array'), scope);
    default:
      return { shape: 'other' };
  }
}

/** Argument shapes, kept only where they say something (`this` and lambdas). */
function argumentShape(node) {
  if (node.type === 'this') return 1;
  if (node.type === 'lambda_expression' || node.type === 'method_reference') return 2;
  if (node.type === 'identifier') return 3;
  return 0;
}

/**
 * The field a store writes to, when it is one of *this* type's own fields:
 * `this.f = …`, or a bare `f = …` whose name is not a local or a parameter.
 */
function storedFieldOf(left, scope, params) {
  if (!left) return null;
  if (left.type === 'field_access') {
    const object = left.childForFieldName('object');
    return object && object.type === 'this' ? left.childForFieldName('field')?.text ?? null : null;
  }
  if (left.type === 'identifier') {
    const name = left.text;
    if (scope.has(name) || (params && params.includes(name))) return null;
    return name;
  }
  return null;
}

/** Where a `return` expression's value comes from. */
function provenanceOf(expr, scope, params) {
  if (!expr) return { prov: 6, param: -1, field: null };
  switch (expr.type) {
    case 'identifier': {
      const idx = params ? params.indexOf(expr.text) : -1;
      if (idx >= 0) return { prov: 0, param: idx, field: null };
      if (scope.has(expr.text)) return { prov: 2, param: -1, field: null };
      return { prov: 1, param: -1, field: expr.text }; // implicit this field
    }
    case 'field_access': {
      const object = expr.childForFieldName('object');
      if (object && object.type === 'this') return { prov: 1, param: -1, field: expr.childForFieldName('field')?.text ?? null };
      return { prov: 6, param: -1, field: null };
    }
    case 'method_invocation':
      return { prov: 3, param: -1, field: null };
    case 'object_creation_expression':
      return { prov: 5, param: -1, field: null };
    case 'string_literal':
    case 'character_literal':
    case 'decimal_integer_literal':
    case 'hex_integer_literal':
    case 'decimal_floating_point_literal':
    case 'true':
    case 'false':
    case 'null':
      return { prov: 4, param: -1, field: null };
    default:
      return { prov: 6, param: -1, field: null };
  }
}

/**
 * Collect every site in a parsed file, symbolically.
 *
 * `sites` are the reads/writes/calls/creations the reference graph is built
 * from; `flow` adds the three facts that make a call graph readable as data
 * flow — a parameter stored into a field, where a returned value comes from,
 * and (derived later, from the argument shapes) a callback being registered.
 *
 * @param {import('web-tree-sitter').Node} root
 * @returns {{sites: Array<object>, flow: Array<object>}} in source order
 */
export function collectSites(root) {
  const sites = [];
  const flow = [];

  const walk = (node, scope, params) => {
    for (const child of node.namedChildren) {
      const type = child.type;

      if (type === 'method_declaration' || type === 'constructor_declaration' || type === 'compact_constructor_declaration' || type === 'lambda_expression') {
        const inner = new Map(scope);
        const paramList = declaredParams(child);
        for (const [name, text] of paramList) inner.set(name, text);
        const body = child.childForFieldName('body');
        if (body) walk(body, inner, paramList.map(([name]) => name));
        continue;
      }

      if (type === 'local_variable_declaration') {
        // the initialiser sees the outer scope, the name is visible after it
        walk(child, scope);
        for (const [name, text] of declaredLocals(child)) scope.set(name, text);
        continue;
      }

      if (type === 'enhanced_for_statement') {
        const element = typeTextOf(child.childForFieldName('type')).replace(/\[\s*\]$/, '');
        walk(child, scope);
        const name = child.childForFieldName('name')?.text;
        if (name) scope.set(name, element);
        continue;
      }

      if (type === 'assignment_expression') {
        const field = storedFieldOf(child.childForFieldName('left'), scope, params);
        const right = child.childForFieldName('right');
        const idx = field && right?.type === 'identifier' && params ? params.indexOf(right.text) : -1;
        if (field && idx >= 0) flow.push({ k: 0, line: child.startPosition.row + 1, field, param: idx });
      } else if (type === 'return_statement') {
        const p = provenanceOf(child.namedChildren[0] ?? null, scope, params);
        flow.push({ k: 1, line: child.startPosition.row + 1, ...p });
      }

      if (type === 'method_invocation') {
        sites.push({
          k: 0,
          line: child.startPosition.row + 1,
          name: child.childForFieldName('name')?.text ?? '',
          recv: receiverOf(child.childForFieldName('object'), scope),
          args: (childForArguments(child) ?? []).map(argumentShape),
        });
      } else if (type === 'field_access') {
        const parent = child.parent;
        const isWrite =
          (parent?.type === 'assignment_expression' && parent.childForFieldName('left')?.id === child.id) ||
          parent?.type === 'update_expression';
        sites.push({
          k: isWrite ? 2 : 1,
          line: child.startPosition.row + 1,
          name: child.childForFieldName('field')?.text ?? '',
          recv: receiverOf(child.childForFieldName('object'), scope),
          args: [],
        });
      } else if (type === 'object_creation_expression') {
        sites.push({
          k: 3,
          line: child.startPosition.row + 1,
          name: typeTextOf(child.childForFieldName('type')),
          recv: { shape: 'type', name: typeTextOf(child.childForFieldName('type')) },
          args: [],
        });
      }

      if (type !== 'line_comment' && type !== 'block_comment' && type !== 'string_literal' && type !== 'character_literal') {
        walk(child, scope, params);
      }
    }
  };

  walk(root, new Map(), null);
  return { sites, flow };
}

function childForArguments(node) {
  const args = node.childForFieldName('arguments');
  return args ? args.namedChildren : null;
}

// ---------------------------------------------------------------------------
// resolution
// ---------------------------------------------------------------------------

/**
 * Turn symbolic sites into member-to-member rows.
 *
 * @param {object} ctx
 * @param {Array} ctx.allTypes            every type record, ids already assigned
 * @param {Map<string, Array>} ctx.sitesByPath  sites per file path
 * @param {(ref: string, pkg: string, imports: Array, ownerPath: string) => number|null} ctx.resolveRef
 * @param {Map<string, number>} ctx.importsByPath  file path -> import list (as `fileImports`)
 */
export function buildReferences({ allTypes, sitesByPath, flowByPath, resolveRef }) {
  // name -> members, per class; plus the ancestry walk that makes inherited
  // members resolvable (a subclass calling an inherited method is normal code).
  const membersOf = new Map();
  for (const t of allTypes) {
    const byName = new Map();
    for (const m of t.members) {
      if (!byName.has(m.name)) byName.set(m.name, []);
      byName.get(m.name).push(m);
    }
    membersOf.set(t.id, byName);
  }
  const ancestors = (id) => {
    const out = [];
    const seen = new Set();
    const stack = [...allTypes[id].superIds, ...allTypes[id].ifaceIds];
    while (stack.length) {
      const next = stack.pop();
      if (seen.has(next)) continue;
      seen.add(next);
      out.push(next);
      stack.push(...allTypes[next].superIds, ...allTypes[next].ifaceIds);
    }
    return out;
  };
  /** Find a member by name in a class or anything it inherits from. */
  const findMember = (classId, name) => {
    const direct = membersOf.get(classId)?.get(name);
    if (direct?.length) return { classId, member: direct[0] };
    for (const anc of ancestors(classId)) {
      const hit = membersOf.get(anc)?.get(name);
      if (hit?.length) return { classId: anc, member: hit[0] };
    }
    return null;
  };

  /** `Text` -> class id, through the extractor's own resolution rules. */
  const asClass = (text, owner) => {
    if (!text) return null;
    const id = resolveRef(text, owner.package, owner.fileImports, owner.path);
    return id === null || id === undefined ? null : id;
  };

  const counts = { sites: 0, call: 0, read: 0, write: 0, new: 0, resolved: 0, classOnly: 0, unresolved: 0 };
  const byShape = Object.fromEntries(RECV_SHAPES.map((s) => [s, 0]));
  const flowCounts = { paramStores: 0, returns: 0, registers: 0 };
  /** classId -> Map(memberLine -> { out: Map, in: Map, flow: object }) */
  const perClass = new Map();
  /** call chains, by resolved depth */
  const chainDepths = new Map();
  const deepest = [];

  const bucket = (classId, line) => {
    let byLine = perClass.get(classId);
    if (!byLine) perClass.set(classId, (byLine = new Map()));
    let entry = byLine.get(line);
    if (!entry) byLine.set(line, (entry = { out: new Map(), in: new Map(), flow: { paramsToFields: new Map(), returns: new Map(), registers: new Map() } }));
    return entry;
  };

  /** The innermost member of `t` whose span contains a line. */
  const ownerLineOf = (t, line) => {
    let ownerLine = -1;
    for (const m of t.members) {
      if (line >= m.line && line <= m.line + Math.max(m.bodyLines ?? 0, 0)) {
        if (ownerLine < 0 || m.line > ownerLine) ownerLine = m.line;
      }
    }
    return ownerLine;
  };

  /** The class a chain's base receiver is typed as, or null. */
  const baseClassOf = (base, ownerId, owner) => {
    if (!base) return null;
    switch (base.shape) {
      case 'this':
        return ownerId;
      case 'local':
        return asClass(base.typeText, owner);
      case 'type':
        return asClass(base.name, owner);
      case 'field': {
        if (!base.onThis) return null;
        const hit = findMember(ownerId, base.name);
        return hit ? asClass(hit.member.type || '', owner) : null;
      }
      case 'none':
        return ownerId;
      default:
        return null;
    }
  };

  /**
   * The resolved steps of a receiver chain (`a.b().c()`), each with the name it
   * was written as, so a chain can be shown without loading member shards.
   */
  const chainPathOf = (recv, ownerId, owner) => {
    const path = [];
    let current = baseClassOf(recv.base, ownerId, owner);
    if (current === null) return path;
    for (const step of recv.chain) {
      const hit = findMember(current, step.name);
      if (!hit) break;
      path.push([hit.classId, hit.member.line, hit.member.name]);
      current = asClass(hit.member.type || '', owner) ?? hit.classId;
    }
    return path;
  };
  /** The same walk, for `resolveSite`, returning the last resolved step. */
  const chainTargetOf = (recv, owner) => {
    const path = chainPathOf(recv, owner.id, owner);
    if (!path.length) return null;
    const last = path[path.length - 1];
    return { classId: last[0], memberLine: last[1] };
  };

  const addRow = (map, toClass, toLine, kind, line) => {
    const key = `${toClass}:${toLine}:${kind}`;
    let row = map.get(key);
    if (!row) map.set(key, (row = [toClass, toLine, kind, 0, []]));
    row[3]++;
    if (row[4].length < 4 && !row[4].includes(line)) row[4].push(line);
  };

  for (const t of allTypes) {
    const sites = sitesByPath.get(t.path);
    if (!sites) continue;
    // sites are file-ordered; member spans come from the coarse records
    for (const site of sites) {
      counts.sites++;
      counts[REF_KINDS[site.k]]++;
      byShape[site.recv.shape] = (byShape[site.recv.shape] ?? 0) + 1;

      const ownerLine = ownerLineOf(t, site.line);

      // A receiver chain is also a chain: resolve its steps and remember how
      // deep the resolved part goes.
      if (site.recv.shape === 'chain') {
        const path = chainPathOf(site.recv, t.id, t);
        chainDepths.set(path.length, (chainDepths.get(path.length) ?? 0) + 1);
        if (path.length >= 2 && ownerLine >= 0 && deepest.length < 400) {
          deepest.push({ from: [t.id, ownerLine], line: site.line, path });
        }
      }

      const target = resolveSite(site, t, { allTypes, resolveRef, findMember, ancestors, asClass, chainTargetOf });
      if (!target) {
        counts.unresolved++;
        continue;
      }
      if (ownerLine >= 0) {
        const own = bucket(t.id, ownerLine);
        addRow(own.out, target.classId, target.memberLine, site.k, site.line);
        // the mirror row, so a member can list who touches it
        const other = bucket(target.classId, target.memberLine);
        addRow(other.in, t.id, ownerLine, site.k, site.line);
        // a `this` or lambda handed to another member is a callback being
        // registered: the callee will run it later, off this call stack.
        for (const arg of site.args ?? []) {
          if (arg !== 1 && arg !== 2) continue;
          own.flow.registers.set(`${target.classId}:${target.memberLine}:${arg}`, [target.classId, target.memberLine, arg]);
          flowCounts.registers++;
        }
      }
      if (target.memberLine >= 0) counts.resolved++;
      else counts.classOnly++;
    }
  }

  // ---- data flow: a parameter stored into a field, and what a method returns
  for (const t of allTypes) {
    const records = flowByPath?.get(t.path);
    if (!records) continue;
    for (const rec of records) {
      const ownerLine = ownerLineOf(t, rec.line);
      if (ownerLine < 0) continue;
      const own = bucket(t.id, ownerLine);
      if (rec.k === 0) {
        const hit = findMember(t.id, rec.field);
        const fieldLine = hit ? hit.member.line : -1;
        own.flow.paramsToFields.set(`${rec.param}:${fieldLine}`, [rec.param, fieldLine]);
        flowCounts.paramStores++;
      } else {
        let ref = -1;
        if (rec.prov === 0) ref = rec.param;
        else if (rec.prov === 1 && rec.field) {
          const hit = findMember(t.id, rec.field);
          ref = hit ? hit.member.line : -1;
        }
        own.flow.returns.set(`${rec.prov}:${ref}`, [rec.prov, ref]);
        flowCounts.returns++;
      }
    }
  }

  counts.flow = flowCounts;
  counts.chains = { sites: [...chainDepths.values()].reduce((a, b) => a + b, 0), deepest: deepest.length };
  return { counts, byShape, perClass, chains: { depths: chainDepths, deepest } };
}

/** Resolve one site to `{ classId, memberLine }`, or null when it cannot be typed. */
function resolveSite(site, owner, ctx) {
  const { allTypes, findMember, chainTargetOf } = ctx;
  const recv = site.recv;

  const asClass = (text) => ctx.asClass(text, owner);

  let classId = null;
  switch (recv.shape) {
    case 'none':
    case 'this':
      classId = owner.id;
      break;
    case 'super':
      classId = owner.superIds[0] ?? null;
      break;
    case 'local':
      classId = asClass(recv.typeText);
      break;
    case 'field': {
      // `foo.bar` where `foo` is a field of this type or of an ancestor
      if (recv.onThis) break;
      const inner = recv.inner;
      if (inner?.shape === 'local') classId = asClass(inner.typeText);
      else if (inner?.shape === 'this') classId = owner.id;
      else if (inner?.shape === 'type') classId = asClass(inner.name);
      if (classId === null) break;
      const field = findMember(classId, recv.innerName ?? inner?.name ?? '');
      classId = field ? asClass(field.member.type || '') : null;
      break;
    }
    case 'type':
      classId = asClass(recv.name);
      break;
    case 'chain': {
      // walk the chain: each step's declared return type types the next receiver
      return chainTargetOf(recv, owner);
    }
    default:
      return null;
  }

  // An implicit or `this` receiver may also be a static import on the file.
  if (classId === null && (recv.shape === 'none' || recv.shape === 'this')) {
    for (const imp of owner.fileImports) {
      if (!imp.static) continue;
      const ownerName = imp.name.slice(0, imp.name.lastIndexOf('.'));
      const id = resolveRef(ownerName, owner.package, owner.fileImports, owner.path);
      if (id !== null && id !== undefined) {
        classId = id;
        break;
      }
    }
  }
  if (classId === null) return null;

  // `new X()` targets the constructor; everything else looks for a member.
  if (site.k === 3) {
    const ctor = allTypes[classId].members.find((m) => m.k === 'ctor');
    return { classId, memberLine: ctor ? ctor.line : -1 };
  }
  const hit = findMember(classId, site.name);
  if (hit) return { classId: hit.classId, memberLine: hit.member.line };
  return { classId, memberLine: -1 };
}

/**
 * Per-class aggregates and the rankings the insights cards read. Kept small so
 * it can be loaded eagerly; the member rows stay in the per-package shards.
 */
export function summarise(allTypes, perClass, chains) {
  const classRows = [];
  const memberTotal = new Map();
  const rankings = { topCalled: [], topCallers: [], topWritten: [], topRead: [] };
  const called = [];
  const written = [];
  const read = [];

  for (const t of allTypes) {
    let out = 0;
    let inc = 0;
    let outReads = 0;
    let inReads = 0;
    let outWrites = 0;
    let inWrites = 0;
    const byLine = perClass.get(t.id);
    if (byLine) {
      for (const [line, entry] of byLine) {
        const outCalls = [...entry.out.values()].filter((r) => r[2] === 0).reduce((a, r) => a + r[3], 0);
        const outR = [...entry.out.values()].filter((r) => r[2] === 1).reduce((a, r) => a + r[3], 0);
        const outW = [...entry.out.values()].filter((r) => r[2] === 2).reduce((a, r) => a + r[3], 0);
        const inCalls = [...entry.in.values()].filter((r) => r[2] === 0).reduce((a, r) => a + r[3], 0);
        const inR = [...entry.in.values()].filter((r) => r[2] === 1).reduce((a, r) => a + r[3], 0);
        const inW = [...entry.in.values()].filter((r) => r[2] === 2).reduce((a, r) => a + r[3], 0);
        out += outCalls;
        inc += inCalls;
        outReads += outR;
        inReads += inR;
        outWrites += outW;
        inWrites += inW;
        // the member's name rides along, so a ranking row can be rendered
        // without fetching that package's member shard
        const member = t.members.find((m) => m.line === line);
        const name = member?.name ?? '?';
        memberTotal.set(`${t.id}:${line}`, { classId: t.id, line, name, inCalls, outCalls, inWrites, inReads });
        if (inCalls) called.push([t.id, line, inCalls, name]);
        if (inWrites) written.push([t.id, line, inWrites, name]);
        if (inReads) read.push([t.id, line, inReads, name]);
      }
    }
    classRows.push([t.id, out, inc, outReads, inReads, outWrites, inWrites]);
  }

  const top = (rows, n = 40) => rows.sort((a, b) => b[2] - a[2]).slice(0, n);
  const byOutCalls = [...memberTotal.values()].filter((v) => v.outCalls).map((v) => [v.classId, v.line, v.outCalls, v.name]);
  rankings.topCalled = top(called);
  rankings.topCallers = top(byOutCalls);
  rankings.topWritten = top(written);
  rankings.topRead = top(read);

  if (chains) {
    rankings.topChains = [...chains.deepest]
      .sort((a, b) => b.path.length - a.path.length || a.line - b.line)
      .slice(0, 40);
  }
  return { classRows, rankings };
}
