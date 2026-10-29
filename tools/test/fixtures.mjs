/**
 * Constants shared by the specs.
 *
 * Everything here names something the application or the extracted dataset
 * guarantees. If a fixture stops resolving, the specs should fail loudly rather
 * than silently test nothing — see `seam.requireClass()`.
 */

/** localStorage key holding persisted settings. */
export const SETTINGS_KEY = 'zombie-atlas.settings.v1';

/** A type that is large, lua-exposed and present in every build of the tree. */
export const ISO_PLAYER = 'IsoPlayer';

/**
 * The functional domain key for the `zombie.iso` family — a *domain* label used
 * by the sidebar chips, not a package path. Pass it as `filters: { domains: [...] }`
 * or use it with `chip(page, ISO_DOMAIN)`.
 *
 * For the package itself use `ISO_PACKAGE` below with `packagePath`, which is
 * validated against `atlas.pkgByPath` (a miss silently falls back to the
 * project overview, so the distinction is easy to get wrong).
 */
export const ISO_DOMAIN = 'iso';

/** The `zombie.iso` package, for `packagePath` selections. */
export const ISO_PACKAGE = 'zombie.iso';

/** A zoom path that resolves: `zombie` > `zombie.iso`. */
export const ZOOM_ISO = ['p:zombie', 'p:zombie.iso'];

/** Settings defaults, mirrored from `src/state.ts` (the repair contract). */
export const DEFAULT_SETTINGS = {
  theme: 'dark',
  sizeMetric: 'code',
  colorMode: 'domain',
  groupBy: 'package',
  layout: 'squarify',
  depthLimit: 0,
  padding: 2,
  minShare: 0,
  sort: 'size',
  version: 1,
};

/** The four treemap tiling algorithms, as labelled in the stage toolbar. */
export const TILING_LABELS = ['Squarified', 'Slice', 'Binary'];

/** Dependency view sub-modes, as labelled by `trLabel()` in the toolbar. */
export const DEP_MODES = ['graph', 'matrix', 'classes'];
