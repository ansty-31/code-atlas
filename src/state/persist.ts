/**
 * Settings persistence.
 *
 * Decoding walks `SETTINGS_FIELDS` and validates each field independently, so a
 * stale, truncated or hand-edited payload degrades to the documented defaults
 * one field at a time instead of wedging the UI. The caller writes the result
 * straight back, so storage repairs itself on the next pass.
 *
 * The codec itself is pure and takes a `StorageLike`, which keeps it testable
 * without a browser and lets the unavailable-storage path be exercised directly.
 */

import {
  SETTINGS_FIELDS,
  buildDefaults,
  coerceField,
  getPath,
  setPath,
  type Settings,
} from './schema';

export const SETTINGS_KEY = 'zombie-atlas.settings.v1';
export const SETTINGS_VERSION = 1;

export interface StorageReport {
  /**
   * `ok` = read and valid · `missing` = nothing stored
   * `repaired` = fixed on load · `unavailable` = no usable localStorage
   */
  status: 'ok' | 'missing' | 'repaired' | 'unavailable';
  /** human-readable list of fields that fell back to their default */
  repairs: string[];
  version: number;
}

/** The slice of the Storage API this module needs. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** `localStorage`, or `null` when the browser denies access to it at all. */
export function defaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Build a validated `Settings` from arbitrary stored data.
 *
 * A field that is simply absent keeps its default silently; a field that is
 * present but wrong is replaced and reported.
 */
export function decodeSettings(input: unknown, report: StorageReport): Settings {
  const out = buildDefaults();
  if (!isObject(input)) {
    if (input !== undefined) report.repairs.push('root: not an object, using defaults');
    return out;
  }
  for (const spec of SETTINGS_FIELDS) {
    const raw = getPath(input, spec.path);
    if (raw === undefined) continue;
    setPath(out, spec.path, coerceField(spec, raw, report.repairs));
  }
  return out;
}

/** The payload written to storage: the settings plus a schema version. */
export function encodeSettings(settings: Settings): Record<string, unknown> {
  return { ...settings, version: SETTINGS_VERSION };
}

export function loadSettings(storage: StorageLike | null = defaultStorage()): {
  settings: Settings;
  report: StorageReport;
} {
  if (!storage) {
    return {
      settings: buildDefaults(),
      report: { status: 'unavailable', repairs: ['localStorage is not readable'], version: SETTINGS_VERSION },
    };
  }
  try {
    const raw = storage.getItem(SETTINGS_KEY);
    if (!raw) {
      return { settings: buildDefaults(), report: { status: 'missing', repairs: [], version: SETTINGS_VERSION } };
    }
    const parsed: unknown = JSON.parse(raw);
    const report: StorageReport = {
      status: 'ok',
      repairs: [],
      version: isObject(parsed) && typeof parsed.version === 'number' ? parsed.version : SETTINGS_VERSION,
    };
    const settings = decodeSettings(parsed, report);
    if (report.version !== SETTINGS_VERSION) {
      report.repairs.push(`payload version ${report.version} != ${SETTINGS_VERSION}: validated field by field`);
    }
    report.status = report.repairs.length ? 'repaired' : 'ok';
    return { settings, report };
  } catch {
    return {
      settings: buildDefaults(),
      report: { status: 'unavailable', repairs: ['localStorage is not readable'], version: SETTINGS_VERSION },
    };
  }
}

/**
 * Write the settings back.
 *
 * A successful write means storage now holds a valid, current payload, so the
 * load-time report is promoted to `ok` — see the note in `README` and the
 * `persistence` spec for what that costs the "repaired on load" notice.
 */
export function saveSettings(
  settings: Settings,
  report: StorageReport,
  storage: StorageLike | null = defaultStorage()
): StorageReport {
  if (!storage) {
    return { status: 'unavailable', repairs: ['localStorage is not writable'], version: SETTINGS_VERSION };
  }
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(encodeSettings(settings)));
    if (report.status === 'unavailable') return report;
    return { ...report, status: 'ok', repairs: [], version: SETTINGS_VERSION };
  } catch {
    return { status: 'unavailable', repairs: ['localStorage is not writable'], version: SETTINGS_VERSION };
  }
}
