/**
 * The application store: a small observable holding `AppState`.
 *
 * Three persistence channels, each with its own module:
 *
 *   - `settings`  → localStorage via `persist.ts` (validated field by field)
 *   - `selection` → transient (what is highlighted / inspected)
 *   - URL hash    → a shareable permalink via `permalink.ts`
 *
 * `update(fn)` batches notifications into one animation frame, so a burst of
 * mutations costs one re-render.
 */

import type { Atlas } from '../domain';
import { buildDefaults } from './schema';
import { loadSettings, saveSettings, type StorageReport } from './persist';
import { decodeParams, readUrl, writeUrl, type AtlasLookup } from './permalink';
import type { AppState } from './types';

type Listener = (s: AppState) => void;

/** Adapts the atlas to the small surface the permalink decoder needs. */
const lookupFor = (atlas: Atlas): AtlasLookup => ({
  hasClass: (id) => atlas.byId[id] != null,
  hasPackage: (path) => atlas.pkgByPath.has(path),
});

export class Store {
  state: AppState;

  private report: StorageReport;
  private listeners = new Set<Listener>();
  private pending = false;

  constructor() {
    const { settings, report } = loadSettings();
    this.report = report;
    this.state = {
      view: 'treemap',
      depMode: 'graph',
      settings,
      selection: { classId: null, packagePath: null, hoverId: null, zoom: [] },
      highlightIds: null,
      ready: false,
      atlas: null,
      status: '',
    };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Batch multiple mutations into one notification. */
  update(fn: (s: AppState) => void, opts: { silent?: boolean; url?: boolean } = {}) {
    fn(this.state);
    if (opts.url !== false) this.syncUrl();
    if (!opts.silent) this.emit();
  }

  private emit() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      for (const l of this.listeners) l(this.state);
    });
  }

  /** What happened the last time persisted settings were read. */
  get storage(): StorageReport {
    return this.report;
  }

  saveSettings() {
    this.report = saveSettings(this.state.settings, this.report);
  }

  /**
   * Discard stored settings and write the documented defaults back.
   * Reachable from the sidebar ("Restore defaults") and from the console via
   * `zombieAtlas.store.resetSettings()`.
   */
  resetSettings() {
    this.state.settings = buildDefaults();
    this.saveSettings();
    this.syncUrl();
    this.emit();
  }

  /** ------------------------------------------------------------- URL ---- */

  syncUrl() {
    writeUrl(this.state);
  }

  /** Apply a permalink (called once on boot and on hashchange). */
  applyUrl(atlas: Atlas) {
    const params = readUrl();
    if (!params) return;
    const next = decodeParams(params, this.state, lookupFor(atlas));
    this.state.view = next.view;
    this.state.depMode = next.depMode;
    this.state.selection = next.selection;
    this.state.settings = next.settings;
  }
}

export const store = new Store();
