/**
 * The lazily-fetched shards: per-package member lists and the class-level
 * reference graph.
 *
 * Members are sharded per package because the full member space is far too
 * large to load eagerly (see the data bundle notes in the README). Both loaders
 * memoise their requests, so a repeated call for a package already in flight
 * shares one fetch.
 */

import type { DepEdge, MemberRec } from './types';

const memberCache = new Map<string, Promise<Record<string, { enumConstants: unknown[]; members: unknown[][] }>>>();

export function pkgSlug(pkg: string): string {
  return pkg === '(default)' ? '_default' : pkg.replace(/\./g, '__');
}

export async function loadMembers(base: string, pkg: string): Promise<Map<number, MemberRec[]>> {
  const slug = pkgSlug(pkg);
  let pr = memberCache.get(slug);
  if (!pr) {
    pr = fetchJSON(`${base}/members/${slug}.json`) as never;
    memberCache.set(slug, pr);
  }
  const raw = await pr;
  const out = new Map<number, MemberRec[]>();
  for (const [id, payload] of Object.entries(raw)) {
    out.set(
      Number(id),
      (payload.members as unknown[][]).map((m) => ({
        kind: m[0] as MemberRec['kind'],
        name: m[1] as string,
        type: (m[2] as string) || '',
        params: (m[3] as string[]) || [],
        modifiers: (m[4] as string) || '',
        annotations: (m[5] as string[]) || [],
        line: (m[6] as number) || 0,
        complexity: (m[7] as number) || 0,
        bodyLines: (m[8] as number) || 0,
        doc: (m[9] as string) ?? null,
        throws: (m[10] as string[]) || [],
        init: (m[11] as string) ?? null,
      }))
    );
  }
  return out;
}

export async function loadClassDeps(base: string): Promise<DepEdge[]> {
  const rows = await fetchJSON<[number, number, number][]>(`${base}/deps-classes.json`);
  return rows.map(([from, to, w]) => ({ from, to, w }));
}

/**
 * Shard loader shared with `atlas.ts`. Kept local rather than imported so this
 * module stays independent of the main bundle loader (it is the only part of
 * the domain layer that fetches separately from `loadAtlas`).
 */
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
