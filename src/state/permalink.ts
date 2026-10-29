/**
 * Permalinks: a compact, shareable encoding of the current view.
 *
 * Split deliberately into a pure pair — `encodeParams` / `decodeParams` — and a
 * thin wrapper that touches `location` / `history`. The pure pair is what makes
 * the round-trip property testable: for any state built from the permalinked
 * fields, `decodeParams(encodeParams(state))` must reproduce it exactly. Before
 * this split the encoder and decoder were two hand-mirrored lists of 17 and 18
 * branches, and nothing checked that they agreed.
 *
 * Decoding validates through the same `coerceField` used for storage, so a
 * malformed or stale link falls back to the current value instead of assigning
 * an unvalidated string into the settings.
 */

import {
  PERMALINK_FIELDS,
  coerceField,
  encodeUrlValue,
  getPath,
  parseUrlValue,
  setPath,
} from './schema';
import type { AppState, DepMode, Selection, ViewId } from './types';

export const VIEW_IDS = ['treemap', 'hierarchy', 'dependencies', 'subsystems', 'insights'] as const;
export const DEP_MODES = ['graph', 'matrix', 'classes'] as const;

/** Query keys for state that is not a setting. */
export const STATE_PARAM = {
  view: 'v',
  depMode: 'dm',
  zoom: 'z',
  classId: 'sel',
  packagePath: 'pkg',
} as const;

export interface PermalinkState {
  view: ViewId;
  depMode: DepMode;
  selection: Selection;
  settings: AppState['settings'];
}

/** How decoding checks `sel` / `pkg` against the loaded atlas. */
export interface AtlasLookup {
  hasClass(id: number): boolean;
  hasPackage(path: string): boolean;
}

/**
 * Encode the shareable part of the state. Defaults are omitted, which is what
 * keeps a link to an unmodified view empty.
 */
export function encodeParams(state: PermalinkState): URLSearchParams {
  const params = new URLSearchParams();
  params.set(STATE_PARAM.view, state.view);

  for (const spec of PERMALINK_FIELDS) {
    const text = encodeUrlValue(spec, getPath(state.settings, spec.path));
    if (text !== null) params.set(spec.key!, text);
  }

  if (state.depMode !== 'graph') params.set(STATE_PARAM.depMode, state.depMode);
  if (state.selection.zoom.length) params.set(STATE_PARAM.zoom, state.selection.zoom.join('|'));
  if (state.selection.classId != null) params.set(STATE_PARAM.classId, String(state.selection.classId));
  if (state.selection.packagePath) params.set(STATE_PARAM.packagePath, state.selection.packagePath);

  return params;
}

/**
 * Apply a permalink on top of `base` (normally the state just restored from
 * storage), returning a new state. Values that fail validation keep the value
 * they already had, which is the same fallback the storage path uses.
 */
export function decodeParams(
  params: URLSearchParams,
  base: PermalinkState,
  lookup?: AtlasLookup
): PermalinkState {
  const out: PermalinkState = {
    view: base.view,
    depMode: base.depMode,
    selection: { ...base.selection, zoom: [...base.selection.zoom] },
    settings: structuredClone(base.settings),
  };

  const view = params.get(STATE_PARAM.view);
  if (view && (VIEW_IDS as readonly string[]).includes(view)) out.view = view as ViewId;

  const depMode = params.get(STATE_PARAM.depMode);
  if (depMode && (DEP_MODES as readonly string[]).includes(depMode)) out.depMode = depMode as DepMode;

  for (const spec of PERMALINK_FIELDS) {
    const text = params.get(spec.key!);
    if (text === null) continue;
    // Reuse the storage validator: a URL value gets the same scrutiny.
    setPath(out.settings, spec.path, coerceField(spec, parseUrlValue(spec, text), []));
  }

  const zoom = params.get(STATE_PARAM.zoom);
  if (zoom) out.selection.zoom = zoom.split('|').filter(Boolean);

  const sel = params.get(STATE_PARAM.classId);
  if (sel !== null) {
    const id = Number(sel);
    if (Number.isInteger(id) && (!lookup || lookup.hasClass(id))) out.selection.classId = id;
  }

  const pkg = params.get(STATE_PARAM.packagePath);
  if (pkg && (!lookup || lookup.hasPackage(pkg))) out.selection.packagePath = pkg;

  return out;
}

/* ------------------------------------------------------------- DOM wrapper -- */

/** Write the permalink into the address bar without adding a history entry. */
export function writeUrl(state: PermalinkState): void {
  const hash = encodeParams(state).toString();
  const url = `${location.pathname}${location.search}${hash ? `#${hash}` : ''}`;
  history.replaceState(null, '', url);
}

/** The permalink currently in the address bar, or `null` when there is none. */
export function readUrl(): URLSearchParams | null {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  return [...params.keys()].length ? params : null;
}
