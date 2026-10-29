/**
 * Declaration kinds and the metric accessors.
 *
 * `METRIC_KEYS` is the vocabulary the settings schema validates `sizeMetric`
 * against, so this module must stay free of DOM and i18n imports.
 */

import type { ClassRec, Metrics } from './types';

export const KIND_NAMES = ['class', 'interface', 'enum', 'record', 'annotation', 'module'] as const;
export const KIND_COLORS = {
  dark: ['#4e9de0', '#59b39a', '#c9a227', '#b07fd6', '#8d8d8d', '#d1785b'],
  light: ['#2f6fdb', '#0f8f78', '#a97208', '#8b3f9c', '#6a7488', '#b85e3f'],
};

export const METRIC_KEYS = [
  'code', 'loc', 'bytes', 'methods', 'fields', 'complexity', 'members',
  'fanIn', 'fanOut', 'luaWeight', 'density',
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export function metricValue(c: ClassRec, k: MetricKey | string): number {
  switch (k) {
    case 'code': return c.code;
    case 'loc': return c.loc;
    case 'bytes': return Math.round(c.bytes / 32); // scaled so it shares a range with lines
    case 'methods': return c.methods;
    case 'fields': return c.fields;
    case 'complexity': return c.complexity;
    case 'members': return c.members;
    case 'fanIn': return c.fanIn;
    case 'fanOut': return c.fanOut;
    case 'luaWeight': return (c.luaExposed ? 40 : 0) + c.annotations.length * 4;
    case 'density': return c.code > 0 ? Math.round((c.complexity / c.code) * 1000) : 0;
    default: return c.code;
  }
}

export function pkgMetricValue(m: Metrics | null, k: MetricKey | string): number {
  if (!m) return 0;
  switch (k) {
    case 'code': return m.code;
    case 'loc': return m.loc;
    case 'bytes': return Math.round(m.bytes / 32);
    case 'methods': return m.methods;
    case 'fields': return m.fields;
    case 'complexity': return m.complexity;
    case 'members': return m.methods + m.fields;
    case 'fanIn': return m.fanIn;
    case 'fanOut': return m.fanOut;
    case 'luaWeight': return m.luaExposed * 40;
    case 'density': return m.code > 0 ? Math.round((m.complexity / m.code) * 1000) : 0;
    default: return m.code;
  }
}

export function emptyMetrics(): Metrics {
  return {
    types: 0, classes: 0, interfaces: 0, enums: 0, records: 0, annotations: 0, modules: 0,
    loc: 0, code: 0, comment: 0, blank: 0, bytes: 0, methods: 0, fields: 0,
    complexity: 0, branch: 0, luaExposed: 0, fanIn: 0, fanOut: 0,
  };
}

/** Fold one type's numbers into a package or domain total. */
export function addMetrics(m: Metrics, c: ClassRec): void {
  m.types++;
  if (c.kind === 0) m.classes++;
  else if (c.kind === 1) m.interfaces++;
  else if (c.kind === 2) m.enums++;
  else if (c.kind === 3) m.records++;
  else if (c.kind === 5) m.modules++;
  else m.annotations++;
  m.loc += c.loc;
  m.code += c.code;
  m.comment += c.comment;
  m.blank += c.blank;
  m.bytes += c.bytes;
  m.methods += c.methods;
  m.fields += c.fields;
  m.complexity += c.complexity;
  m.luaExposed += c.luaExposed ? 1 : 0;
  m.fanIn += c.fanIn;
  m.fanOut += c.fanOut;
}
