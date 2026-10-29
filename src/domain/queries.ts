/**
 * Derived queries over a loaded atlas: ancestry, descendants and package paths.
 *
 * All pure functions of `(atlas, record)`, so they are cheap to unit test with
 * a synthetic fixture.
 */

import type { Atlas, ClassRec } from './types';

/** Direct supertypes (class + interfaces) as records. */
export function supersOf(atlas: Atlas, c: ClassRec): ClassRec[] {
  return [...c.superIds, ...c.ifaceIds].map((id) => atlas.byId[id]).filter(Boolean);
}

/** Full ancestry chain, nearest first. */
export function ancestryOf(atlas: Atlas, c: ClassRec): ClassRec[] {
  const out: ClassRec[] = [];
  const seen = new Set<number>([c.id]);
  let cur = c;
  while (cur.superIds.length) {
    const p = atlas.byId[cur.superIds[0]];
    if (!p || seen.has(p.id)) break;
    seen.add(p.id);
    out.push(p);
    cur = p;
  }
  return out;
}

/** All transitive subtypes, breadth first. */
export function descendantsOf(atlas: Atlas, c: ClassRec, limit = 4000): ClassRec[] {
  const out: ClassRec[] = [];
  const seen = new Set<number>([c.id]);
  const queue = [...c.subIds];
  while (queue.length && out.length < limit) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const t = atlas.byId[id];
    if (!t) continue;
    out.push(t);
    queue.push(...t.subIds);
  }
  return out;
}

/** `a.b.c` → `['a', 'a.b', 'a.b.c']` — every ancestor package path. */
export function ancestorsOfPkg(path: string): string[] {
  const parts = path.split('.');
  const out: string[] = [];
  for (let i = 1; i <= parts.length; i++) out.push(parts.slice(0, i).join('.'));
  return out;
}
