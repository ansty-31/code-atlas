/**
 * The fine-grained reference layer: member-to-member calls, field reads and
 * field writes, extracted from the source (`tools/lib/java-refs.mjs`).
 *
 * Sharded per package like the member lists — the rows are an order of
 * magnitude more numerous than the class graph — and loaded on demand, so a
 * bundle built with `--no-refs` simply reports "unavailable" and every caller
 * hides its surface instead of failing.
 */

import type { ClassRec } from './types';

/** Site categories, matching `REF_KINDS` in the extractor. */
export const REF_KINDS = ['call', 'read', 'write', 'new'] as const;
export type RefKind = 0 | 1 | 2 | 3;

/** `[toClassId, toLine, kind, count, lines]`; `toLine` is -1 when only the class is known. */
export type RefRow = [number, number, RefKind, number, number[]];

/** What a member stores, returns and hands to other code (`refs/meta.json` documents the codes). */
export interface MemberFlow {
  /** `[parameterIndex, fieldLine]` — a parameter stored into a field. */
  p?: [number, number][];
  /** `[provenance, ref]` — 0 param, 1 field, 2 local, 3 call, 4 literal, 5 creation, 6 other. */
  r?: [number, number][];
  /** `[classId, line, argShape]` — 1 hands over `this`, 2 a lambda/method reference. */
  g?: [number, number, number][];
}

export interface MemberRefs {
  line: number;
  kind: 'method' | 'field' | 'synthetic';
  name: string;
  out: RefRow[] | null;
  in: RefRow[] | null;
  flow: MemberFlow | null;
}

export interface RefCounts {
  sites: number;
  flow?: { paramStores: number; returns: number; registers: number };
  chains?: { sites: number; deepest: number };
  call: number;
  read: number;
  write: number;
  new: number;
  resolved: number;
  classOnly: number;
  unresolved: number;
  rows: number;
  shards: number;
  byShape: Record<string, number>;
}

/** A ranking row: class, member line, count, member name. */
export type MemberRankRow = [number, number, number, string];

/** One resolved call chain: `A.m → B.n → …`, each step `[classId, line, name]`. */
export interface RefChain {
  from: [number, number];
  line: number;
  path: [number, number, string][];
}

export interface RefChains {
  histogram: [number, number][];
  deepest: RefChain[];
}

export interface RefSummary {
  columns: string[];
  classRows: number[][];
  rankings: {
    /** `[classId, memberLine, count, memberName]` — the name rides along so a
     *  ranking row can be rendered without fetching that package's shard. */
    topCalled?: MemberRankRow[];
    topCallers?: MemberRankRow[];
    topWritten?: MemberRankRow[];
    topRead?: MemberRankRow[];
    topChains?: RefChain[];
  };
}

const cache = new Map<string, Promise<unknown>>();

function fetchJSON<T>(url: string): Promise<T> {
  if (!cache.has(url)) {
    const pr = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
      return r.json();
    });
    cache.set(url, pr);
    // a missing artifact is a supported state, not a failure to remember
    pr.catch(() => cache.delete(url));
  }
  return cache.get(url) as Promise<T>;
}

export function pkgSlugRefs(pkg: string): string {
  return pkg === '(default)' ? '_default' : pkg.replace(/\./g, '__');
}

let chainsPromise: Promise<RefChains | null> | null = null;
let metaPromise: Promise<RefCounts | null> | null = null;
let summaryPromise: Promise<RefSummary | null> | null = null;
let available: boolean | null = null;

/** Load `refs/meta.json` once; `null` means this bundle has no reference layer. */
export function loadRefMeta(base = 'data'): Promise<RefCounts | null> {
  if (!metaPromise) {
    metaPromise = fetchJSON<{ counts: RefCounts }>(`${base}/refs/meta.json`)
      .then((m) => {
        available = true;
        return m.counts;
      })
      .catch(() => {
        available = false;
        return null;
      });
  }
  return metaPromise;
}

export function loadRefChains(base = 'data'): Promise<RefChains | null> {
  if (!chainsPromise) chainsPromise = fetchJSON<RefChains>(`${base}/refs/chains.json`).catch(() => null);
  return chainsPromise;
}

export function loadRefSummary(base = 'data'): Promise<RefSummary | null> {
  if (!summaryPromise) {
    summaryPromise = fetchJSON<RefSummary>(`${base}/refs/summary.json`).catch(() => null);
  }
  return summaryPromise;
}

/** `true`/`false` once the index has been probed; `null` while unknown. */
export function refsAvailable(): boolean | null {
  return available;
}

const shardCache = new Map<string, Promise<Map<number, Map<number, MemberRefs>>>>();

/** Per-member reference rows for one package, keyed by class id and member line. */
export function loadRefShard(base: string, pkg: string): Promise<Map<number, Map<number, MemberRefs>>> {
  const slug = pkgSlugRefs(pkg);
  let pr = shardCache.get(slug);
  if (!pr) {
    pr = fetchJSON<Record<string, { members: unknown[][] }>>(`${base}/refs/${slug}.json`)
      .then((raw) => {
        const out = new Map<number, Map<number, MemberRefs>>();
        for (const [id, payload] of Object.entries(raw)) {
          const byLine = new Map<number, MemberRefs>();
          for (const m of payload.members ?? []) {
            const row = m as [number, MemberRefs['kind'], string, RefRow[] | null, RefRow[] | null, MemberFlow | null];
            byLine.set(row[0], { line: row[0], kind: row[1], name: row[2], out: row[3], in: row[4], flow: row[5] ?? null });
          }
          out.set(Number(id), byLine);
        }
        return out;
      })
      .catch((err) => {
        shardCache.delete(slug);
        throw err;
      });
    shardCache.set(slug, pr);
  }
  return pr;
}

/** The row's target as a class record, when the id is known. */
export function refTarget(byId: ClassRec[], row: RefRow): ClassRec | null {
  return byId[row[0]] ?? null;
}

export const REF_KIND_LABEL: Record<RefKind, string> = {
  0: 'call',
  1: 'read',
  2: 'write',
  3: 'new',
};
