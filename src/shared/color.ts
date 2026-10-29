/**
 * Colour maths and the sequential ramps used by the treemap and the legend.
 *
 * Deliberately dependency-free: the settings schema needs the palette names, and
 * the schema must stay importable from plain Node (unit tests) without pulling
 * in the i18n layer or anything that touches the DOM.
 */

/** Simple string hash → stable pseudo-random colour index. */
export function hashCode(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Alias used by the UI for palette assignment. */
export const hashFor = (s: string): number => hashCode(s);

export function hexToRgb(hex: string): [number, number, number] {
  const s = hex.replace('#', '');
  const v = parseInt(s.length === 3 ? s.split('').map((c) => c + c).join('') : s, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function mix(a: string, b: string, t: number): string {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  const c = A.map((v, i) => Math.round(v + (B[i] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export const lighten = (hex: string, t: number): string => mix(hex, '#ffffff', t);
export const darken = (hex: string, t: number): string => mix(hex, '#000000', t);

export function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/** Perceptually reasonable sequential ramps as hex stop lists. */
export const RAMPS: Record<string, string[]> = {
  viridis: ['#440154', '#414487', '#2a788e', '#22a884', '#7ad151', '#fde725'],
  magma: ['#000004', '#3b0f70', '#8c2981', '#de4968', '#fe9f6d', '#fcfdbf'],
  turbo: ['#30123b', '#4662d8', '#24c4b3', '#a4fc3c', '#f9ba38', '#e84a1c', '#7a0403'],
  ice: ['#0b1a3a', '#12467b', '#1f7fb5', '#43b5cc', '#8fdcdf', '#e8fbfa'],
  ember: ['#1a0b0b', '#5c1a10', '#a63a1a', '#d97a2b', '#f0c060', '#fff3cf'],
  mono: ['#1c1f26', '#3a4250', '#5b6675', '#8592a3', '#b8c2cf', '#f0f4f8'],
};

export const PALETTE_NAMES = Object.keys(RAMPS);

export function sampleRamp(name: string, t: number): string {
  const ramp = RAMPS[name] ?? RAMPS.viridis;
  const x = Math.max(0, Math.min(1, t)) * (ramp.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  if (i >= ramp.length - 1) return ramp[ramp.length - 1];
  return mix(ramp[i], ramp[i + 1], f);
}
