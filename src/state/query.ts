/**
 * Filtering and search: turning the settings into the set of types on screen,
 * and the search box into ranked hits.
 */

import type { Atlas } from '../domain';
import { msg, locale } from '../i18n';
import type { Settings } from './schema';

export interface FilterResult {
  /** ids passing every filter */
  ids: Set<number>;
  total: number;
}

/**
 * Apply the active filters to the class list.
 * The text query is matched against class name, package, member names (when
 * loaded) and stereotypes.
 */
export function applyFilters(
  atlas: Atlas,
  s: Settings,
  memberNames?: Map<number, string[]>
): FilterResult {
  const f = s.filters;
  const q = f.query.trim().toLowerCase();
  const ids = new Set<number>();

  const domainSet = f.domains.length ? new Set(f.domains) : null;
  const languageSet = f.languages?.length ? new Set(f.languages) : null;
  const kindSet = f.kinds.length ? new Set(f.kinds) : null;
  const stereoSet = f.stereotypes.length ? new Set(f.stereotypes) : null;

  for (const c of atlas.classes) {
    if (languageSet && !languageSet.has(c.language ?? 'java')) continue;
    if (f.luaOnly && !c.luaExposed) continue;
    if (domainSet && !domainSet.has(c.domain)) continue;
    if (kindSet && !kindSet.has(c.kind)) continue;
    if (stereoSet && !stereoSet.has(c.stereotype)) continue;
    if (f.minCode && c.code < f.minCode) continue;

    if (q) {
      const hay = `${c.name} ${c.fqn} ${c.pkg} ${c.stereotype} ${c.annotations.join(' ')}`.toLowerCase();
      let hit = hay.includes(q);
      if (!hit && memberNames) {
        const names = memberNames.get(c.id);
        if (names) hit = names.some((n) => n.includes(q));
      }
      if (!hit) continue;
    }
    ids.add(c.id);
  }
  return { ids, total: atlas.classes.length };
}

/** Text used by the search box: classes + packages + member index. */
export interface SearchHit {
  type: 'class' | 'package' | 'member';
  id?: number;
  name: string;
  sub: string;
  meta: string;
  score: number;
}

export function searchAtlas(atlas: Atlas, q: string, limit = 40): SearchHit[] {
  const query = q.trim().toLowerCase();
  if (query.length < 1) return [];
  const hits: SearchHit[] = [];

  for (const c of atlas.classes) {
    const name = c.name.toLowerCase();
    const fqn = c.fqn.toLowerCase();
    let score = 0;
    if (name === query) score = 100;
    else if (name.startsWith(query)) score = 80 - name.length * 0.01;
    else if (name.includes(query)) score = 60;
    else if (fqn.includes(query)) score = 40;
    if (score > 0) {
      hits.push({
        type: 'class',
        id: c.id,
        name: c.name,
        sub: c.fqn,
        meta: msg("{0} ln", c.code.toLocaleString(locale)),
        score: score + Math.min(10, c.fanIn / 100),
      });
    }
  }

  for (const [path, node] of atlas.pkgByPath) {
    if (!path) continue;
    const name = node.name.toLowerCase();
    if (name === query || path.toLowerCase().includes(query)) {
      hits.push({
        type: 'package',
        name: node.name,
        sub: path,
        meta: msg("{0} types", node.ownIds.length),
        score: name === query ? 95 : 35,
      });
    }
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
