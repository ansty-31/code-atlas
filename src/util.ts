import { msg, locale } from './i18n';
/**
 * Small shared helpers: formatting, DOM, events.
 *
 * The colour maths and `esc` live in `shared/` because the settings schema and
 * the Java highlighter need them without the i18n layer that this module pulls
 * in. They are re-exported here so existing imports keep working.
 */

export { esc } from './shared/text';
export {
  hexToRgb,
  mix,
  lighten,
  darken,
  rgba,
  hashCode,
  hashFor,
  RAMPS,
  PALETTE_NAMES,
  sampleRamp,
} from './shared/color';

const compactFormatter = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });

export const fmtInt = (n: number): string => n.toLocaleString(locale);

export function fmtCompact(n: number): string {
  if (!isFinite(n)) return '—';
  if (locale !== 'en') return compactFormatter.format(n);
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (a >= 1e4) return (n / 1e3).toFixed(0) + 'k';
  if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n));
}

export function fmtBytes(n: number): string {
  const a = Math.abs(n);
  if (a >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  if (a >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

export const pct = (x: number): string => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;

/** Elapsed-time style suffix for generated timestamps. */
export function timeAgo(iso: string): string {
  const d = Date.now() - new Date(iso).getTime();
  const min = Math.round(d / 60000);
  if (min < 1) return msg("just now");
  if (min < 60) return msg("{0}m ago", min);
  const h = Math.round(min / 60);
  if (h < 24) return msg("{0}h ago", h);
  return msg("{0}d ago", Math.round(h / 24));
}

/** Minimal hyperscript helper. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'html') el.innerHTML = String(v);
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'dataset' && typeof v === 'object') Object.assign(el.dataset, v as object);
    else el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el as T;
};

/**
 * One label/value row of a `<dl class="kv">` metrics table.
 *
 * The value column truncates instead of wrapping (see `.kv dd` in the
 * stylesheet), because file paths and modifier lists are wider than any side
 * panel: a clipped value stays a single line and `watchOverflowTitles` gives
 * the full text back as a tooltip.
 */
export function kv(k: string, v: string): DocumentFragment {
  const f = document.createDocumentFragment();
  f.append(h('dt', { text: k }), h('dd', { 'data-overflow': v, text: v }));
  return f;
}

/**
 * Give every clipped `[data-overflow]` cell its full text as a `title` — and
 * only the clipped ones, since a tooltip on a value that is already readable is
 * noise. Safe to call after every paint; it does not change any layout.
 */
export function syncOverflowTitles(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-overflow]')) {
    if (el.scrollWidth > el.clientWidth + 1) el.title = el.dataset.overflow ?? '';
    else el.removeAttribute('title');
  }
}

const overflowWatched = new WeakSet<HTMLElement>();
let overflowObserver: ResizeObserver | null = null;

/**
 * Keep the tooltips of a panel honest: sync them now, and again whenever the
 * panel's box changes — a narrower inspector clips values that used to fit, and
 * a wider one must drop the now-redundant tooltips.
 */
export function watchOverflowTitles(root: HTMLElement): void {
  syncOverflowTitles(root);
  if (overflowWatched.has(root)) return;
  overflowWatched.add(root);
  overflowObserver ??= new ResizeObserver((entries) => {
    for (const entry of entries) syncOverflowTitles(entry.target);
  });
  overflowObserver.observe(root);
}

/**
 * Repaint a subtree that contains a text input, putting focus and the caret
 * back where they were.
 *
 * Rebuilding an input detaches the live one, and the replacement starts with
 * the caret at position 0 — which both loses the user's place and makes the
 * next keystroke land at the start of the value instead of at the cursor. Only
 * the control named by `id` is restored, so a click elsewhere is not undone.
 */
export function preserveInputFocus(id: string, paint: () => void): void {
  const active = document.activeElement;
  const caret =
    active instanceof HTMLInputElement && active.id === id
      ? { start: active.selectionStart, end: active.selectionEnd, dir: active.selectionDirection }
      : null;
  paint();
  if (!caret) return;
  const next = document.getElementById(id);
  if (!(next instanceof HTMLInputElement)) return;
  next.focus();
  next.setSelectionRange(caret.start ?? next.value.length, caret.end ?? next.value.length, caret.dir ?? undefined);
}

/** Debounce for resize / input handlers. */
export function debounce<T extends (...a: never[]) => void>(fn: T, ms: number): T {
  let t: number | undefined;
  return ((...args: never[]) => {
    if (t) clearTimeout(t);
    t = window.setTimeout(() => fn(...args), ms);
  }) as T;
}

/** Truncate text to fit a pixel width using the canvas context metrics. */
export function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (maxW <= 0) return '';
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + '…').width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo > 1 ? text.slice(0, lo) + '…' : '';
}

export function download(filename: string, text: string, type = 'application/json') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
