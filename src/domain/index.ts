/**
 * The domain layer: the extracted dataset, and nothing else.
 *
 * Pure — no DOM, no i18n, no store — so it can be imported by views, by the
 * state layer, and by unit tests without dragging in a browser.
 *
 * Imports elsewhere reach it as `../domain`.
 */

export * from './types';
export * from './metrics';
export * from './atlas';
export * from './members';
export * from './queries';

export {
  REF_KINDS,
  REF_KIND_LABEL,
  loadRefChains,
  loadRefMeta,
  loadRefShard,
  loadRefSummary,
  refsAvailable,
  pkgSlugRefs,
} from './refs';
export type { MemberFlow, MemberRankRow, MemberRefs, RefChain, RefChains, RefCounts, RefKind, RefRow, RefSummary } from './refs';
