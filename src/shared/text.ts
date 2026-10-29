/**
 * Text helpers with no dependencies.
 *
 * Separate from `util.ts` because that module pulls in the i18n layer, and the
 * Java highlighter (which needs `esc`) must stay importable from plain Node.
 */

/** Escape text for safe innerHTML interpolation. */
export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
