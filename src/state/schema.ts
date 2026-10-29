/**
 * The settings schema — one declaration per setting, and the single source of
 * truth for the whole settings pipeline.
 *
 * Before this existed, adding one setting meant editing four separate places:
 * the `Settings` interface, `DEFAULT_SETTINGS`, a hand-written branch in
 * `coerceSettings()` (~125 lines of validate-per-field), and a matching pair of
 * lines in `syncUrl()` / `applyUrl()`. The URL pair was easy to forget, and the
 * result was that the storage path validated every field while the permalink
 * path cast blindly.
 *
 * Now a field is one entry in `SETTINGS_FIELDS`. From it the module derives:
 *
 *   - `DEFAULT_SETTINGS`, built by walking the specs (never hand-maintained, so
 *     it cannot drift out of step with the type)
 *   - storage decoding, with per-field repair messages
 *   - permalink encoding and decoding, for fields that carry a `key`
 *
 * This file is pure: no DOM, no i18n, no I/O. That keeps it importable from
 * plain Node for unit tests (`node --test` strips the types directly).
 */

import { METRIC_KEYS } from '../domain';
import { PALETTE_NAMES } from '../shared/color';

/* ------------------------------------------------------------------ types -- */

export type ColorMode =
  | 'language'
  | 'domain'
  | 'package'
  | 'kind'
  | 'stereotype'
  | 'fanIn'
  | 'fanOut'
  | 'complexity'
  | 'density'
  | 'lua'
  | 'depth';

export type GroupBy = 'package' | 'domain' | 'stereotype' | 'kind' | 'stereotype+package';
export type LayoutKind = 'squarify' | 'sliceDice' | 'binary' | 'strip';
export type SortKind = 'size' | 'name' | 'fanIn' | 'complexity';
export type LabelMode = 'auto' | 'always' | 'never';
export type Theme = 'dark' | 'light';
export type SizeMetric = (typeof METRIC_KEYS)[number] | 'composite';

export interface Settings {
  theme: Theme;
  sizeMetric: SizeMetric;
  weights: Record<string, number>;
  colorMode: ColorMode;
  palette: string;
  groupBy: GroupBy;
  layout: LayoutKind;
  depthLimit: number; // package nesting depth to expand (0 = unlimited)
  showMembers: boolean; // include a class's members as leaves
  labelMode: LabelMode;
  padding: number;
  minShare: number; // cull nodes smaller than this share of the whole
  sort: SortKind;
  filters: {
    query: string;
    kinds: number[];
    languages: string[];
    stereotypes: string[];
    domains: string[];
    luaOnly: boolean;
    minCode: number;
  };
  sidebar: boolean;
  inspector: boolean;
}

/* ------------------------------------------------------------- field specs -- */

interface FieldBase {
  /** Dotted path into `Settings`, e.g. `filters.query`. */
  readonly path: string;
  /**
   * Short permalink key. Fields without one are stored but never travel in the
   * URL — they are preferences, not part of a shareable view.
   */
  readonly key?: string;
}

interface EnumField extends FieldBase {
  readonly kind: 'enum';
  readonly values: readonly string[];
  readonly default: string;
}

interface BoolField extends FieldBase {
  readonly kind: 'bool';
  readonly default: boolean;
}

interface NumberField extends FieldBase {
  readonly kind: 'int' | 'float';
  readonly min: number;
  readonly max: number;
  readonly default: number;
}

interface StringField extends FieldBase {
  readonly kind: 'string';
  readonly maxLength: number;
  readonly default: string;
}

interface IntListField extends FieldBase {
  readonly kind: 'intList';
  readonly itemMin: number;
  readonly itemMax: number;
  readonly maxItems: number;
  readonly default: readonly number[];
}

interface StringListField extends FieldBase {
  readonly kind: 'stringList';
  readonly maxItems: number;
  readonly default: readonly string[];
}

interface WeightsField extends FieldBase {
  readonly kind: 'weights';
  readonly keys: readonly string[];
  readonly default: Readonly<Record<string, number>>;
}

export type FieldSpec =
  | EnumField
  | BoolField
  | NumberField
  | StringField
  | IntListField
  | StringListField
  | WeightsField;

const THEMES = ['dark', 'light'] as const;
const COLOR_MODES = [
  'domain', 'language', 'package', 'kind', 'stereotype', 'fanIn', 'fanOut', 'complexity', 'density', 'lua', 'depth',
] as const;
const GROUP_BY = ['package', 'domain', 'stereotype', 'kind', 'stereotype+package'] as const;
const LAYOUTS = ['squarify', 'sliceDice', 'binary', 'strip'] as const;
const LABEL_MODES = ['auto', 'always', 'never'] as const;
const SORTS = ['size', 'name', 'fanIn', 'complexity'] as const;
export const WEIGHT_KEYS = ['code', 'complexity', 'methods', 'fanIn', 'luaWeight', 'bytes'] as const;

/** Declaration order is the order of the sidebar's persistence footer list. */
export const SETTINGS_FIELDS = [
  // ---- appearance
  { path: 'theme', kind: 'enum', values: THEMES, default: 'dark', key: 't' },
  { path: 'palette', kind: 'enum', values: PALETTE_NAMES, default: 'viridis' },
  { path: 'labelMode', kind: 'enum', values: LABEL_MODES, default: 'auto' },
  { path: 'sidebar', kind: 'bool', default: true },
  { path: 'inspector', kind: 'bool', default: true },

  // ---- what the map shows
  { path: 'sizeMetric', kind: 'enum', values: [...METRIC_KEYS, 'composite'], default: 'code', key: 'm' },
  { path: 'weights', kind: 'weights', keys: WEIGHT_KEYS, default: { code: 1, complexity: 0, methods: 0, fanIn: 0, luaWeight: 0, bytes: 0 } },
  { path: 'colorMode', kind: 'enum', values: COLOR_MODES, default: 'domain', key: 'c' },
  { path: 'groupBy', kind: 'enum', values: GROUP_BY, default: 'package', key: 'g' },
  { path: 'layout', kind: 'enum', values: LAYOUTS, default: 'squarify', key: 'l' },
  { path: 'sort', kind: 'enum', values: SORTS, default: 'size' },

  // ---- tiling
  { path: 'depthLimit', kind: 'int', min: 0, max: 6, default: 0, key: 'd' },
  { path: 'padding', kind: 'int', min: 0, max: 8, default: 2 },
  { path: 'minShare', kind: 'float', min: 0, max: 1, default: 0 },
  { path: 'showMembers', kind: 'bool', default: false, key: 'mm' },

  // ---- filters
  { path: 'filters.query', kind: 'string', maxLength: 200, default: '', key: 'q' },
  { path: 'filters.kinds', kind: 'intList', itemMin: 0, itemMax: 5, maxItems: 6, default: [], key: 'k' },
  { path: 'filters.languages', kind: 'stringList', maxItems: 100, default: [], key: 'lng' },
  { path: 'filters.stereotypes', kind: 'stringList', maxItems: 100, default: [], key: 'st' },
  { path: 'filters.domains', kind: 'stringList', maxItems: 200, default: [], key: 'dom' },
  { path: 'filters.luaOnly', kind: 'bool', default: false, key: 'lua' },
  { path: 'filters.minCode', kind: 'int', min: 0, max: Number.MAX_SAFE_INTEGER, default: 0, key: 'min' },
] satisfies readonly FieldSpec[];

/** The fields that travel in a permalink, in declaration order. */
export const PERMALINK_FIELDS = SETTINGS_FIELDS.filter((f) => f.key !== undefined);

/* ---------------------------------------------------------- path accessors -- */

type Bag = Record<string, unknown>;

const isObject = (v: unknown): v is Bag => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Read a dotted path, or `undefined` when any segment is missing. */
export function getPath(source: unknown, path: string): unknown {
  let cur: unknown = source;
  for (const part of path.split('.')) {
    if (!isObject(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Write a dotted path, creating intermediate objects as needed. */
export function setPath(target: object, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = target as Bag;
  for (const part of parts.slice(0, -1)) {
    const next = cur[part];
    if (!isObject(next)) {
      const created: Bag = {};
      cur[part] = created;
      cur = created;
    } else {
      cur = next;
    }
  }
  cur[parts[parts.length - 1]] = value;
}

/* --------------------------------------------------------------- coercion -- */

const show = (v: unknown): string => (typeof v === 'string' ? JSON.stringify(v) : String(v));

const clone = <T>(value: T): T => structuredClone(value);

/** The field's default, freshly cloned so callers can never mutate the spec. */
const fallback = (spec: FieldSpec): unknown => clone(spec.default);

/**
 * Validate one raw value against its spec, pushing a human-readable note into
 * `repairs` when it had to fall back.
 *
 * Both input channels funnel through here — localStorage and the URL — which is
 * what stops them drifting apart. The URL path used to cast instead of validate.
 */
export function coerceField(spec: FieldSpec, raw: unknown, repairs: string[]): unknown {
  switch (spec.kind) {
    case 'enum':
      if (typeof raw === 'string' && spec.values.includes(raw)) return raw;
      repairs.push(`${spec.path}: expected one of ${spec.values.join('|')}, got ${show(raw)}`);
      return fallback(spec);

    case 'bool':
      if (typeof raw === 'boolean') return raw;
      repairs.push(`${spec.path}: expected a boolean, got ${typeof raw}`);
      return fallback(spec);

    case 'int':
    case 'float':
      if (typeof raw === 'number' && Number.isFinite(raw) && raw >= spec.min && raw <= spec.max) {
        return spec.kind === 'int' ? Math.round(raw) : raw;
      }
      repairs.push(`${spec.path}: expected a number in [${spec.min}, ${spec.max}], got ${show(raw)}`);
      return fallback(spec);

    case 'string':
      if (typeof raw === 'string') return raw.slice(0, spec.maxLength);
      repairs.push(`${spec.path}: expected a string, got ${typeof raw}`);
      return fallback(spec);

    case 'intList': {
      if (!Array.isArray(raw)) {
        repairs.push(`${spec.path}: expected an array, got ${typeof raw}`);
        return fallback(spec);
      }
      const valid = [
        ...new Set(raw.filter((v): v is number => Number.isInteger(v) && v >= spec.itemMin && v <= spec.itemMax)),
      ];
      if (valid.length !== raw.length) {
        repairs.push(`${spec.path}: dropped ${raw.length - valid.length} invalid entr(ies)`);
      }
      if (valid.length > spec.maxItems) {
        repairs.push(`${spec.path}: kept the first ${spec.maxItems} of ${valid.length}`);
        valid.length = spec.maxItems;
      }
      return valid;
    }

    case 'stringList': {
      if (!Array.isArray(raw)) {
        repairs.push(`${spec.path}: expected an array, got ${typeof raw}`);
        return fallback(spec);
      }
      const valid = [...new Set(raw.filter((v): v is string => typeof v === 'string' && v.length > 0))];
      if (valid.length !== raw.length) {
        repairs.push(`${spec.path}: dropped ${raw.length - valid.length} invalid entr(ies)`);
      }
      if (valid.length > spec.maxItems) {
        repairs.push(`${spec.path}: kept the first ${spec.maxItems} of ${valid.length}`);
        valid.length = spec.maxItems;
      }
      return valid;
    }

    case 'weights': {
      if (!isObject(raw)) {
        repairs.push(`${spec.path}: expected an object, got ${raw === null ? 'null' : typeof raw}`);
        return fallback(spec);
      }
      const out: Record<string, number> = { ...spec.default };
      for (const key of spec.keys) {
        const v = raw[key];
        if (v === undefined) continue;
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1) out[key] = v;
        else repairs.push(`${spec.path}.${key}: expected a number in [0, 1], got ${show(v)}`);
      }
      return out;
    }
  }
}

/* ---------------------------------------------------------------- defaults -- */

/** The documented defaults, derived from the specs rather than restated. */
export function buildDefaults(): Settings {
  const out = {} as Settings;
  for (const spec of SETTINGS_FIELDS) setPath(out, spec.path, fallback(spec));
  return out;
}

export const DEFAULT_SETTINGS: Settings = buildDefaults();

/** True when a value is exactly the documented default (arrays included). */
export const isDefault = (spec: FieldSpec, value: unknown): boolean =>
  JSON.stringify(value) === JSON.stringify(spec.default);

/* ----------------------------------------------------------------- URL I/O -- */

/**
 * Encode a field for the permalink, or `null` to leave it out.
 *
 * Everything is omitted when it equals its default, which is what keeps a link
 * to a plain view short — and reproduces the previous hand-written behaviour,
 * where the numeric and list fields were written only when truthy.
 */
export function encodeUrlValue(spec: FieldSpec, value: unknown): string | null {
  if (spec.key === undefined || isDefault(spec, value)) return null;
  switch (spec.kind) {
    case 'bool':
      return value ? '1' : '0';
    case 'int':
    case 'float':
    case 'enum':
    case 'string':
      return String(value);
    case 'intList':
      return (value as number[]).join(',');
    case 'stringList':
      return (value as string[]).join(',');
    case 'weights':
      return null; // never permalinked
  }
}

/**
 * Turn permalink text back into the shape `coerceField` expects, so a URL value
 * is validated by exactly the same code as a stored one.
 */
export function parseUrlValue(spec: FieldSpec, text: string): unknown {
  switch (spec.kind) {
    case 'bool':
      return text === '1';
    case 'int':
    case 'float':
      return Number(text);
    case 'enum':
    case 'string':
      return text;
    case 'intList':
      return text.split(',').map((v) => Number(v));
    case 'stringList':
      return text.split(',').filter(Boolean);
    case 'weights':
      return undefined;
  }
}
