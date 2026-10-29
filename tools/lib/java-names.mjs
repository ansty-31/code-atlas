/**
 * Java *name* helpers — the string-level half of parsing.
 *
 * These are deliberately not lexing: they normalise a type reference that some
 * other layer already extracted (an AST node's text, an import string, a
 * member's declared type) into the bare qualified name the resolver indexes by.
 * They used to live in `java-lexer.mjs`, which masked comments and scanned for
 * declarations; that job now belongs to `java-ast.mjs`, so the two survivors
 * moved here and the lexer re-exports them until it is deleted.
 */

/** Java modifiers this project records, in source order. */
export const MODIFIERS = new Set([
  'public',
  'protected',
  'private',
  'static',
  'final',
  'abstract',
  'native',
  'synchronized',
  'strictfp',
  'transient',
  'volatile',
  'default',
]);

/**
 * Normalise a type reference to a bare source name: strips generics, array
 * brackets, wildcards and annotations, keeping the raw qualified name.
 * @param {string} t
 */
export function normalizeTypeRef(t) {
  return t
    .replace(/@[\w$.]+(\([^)]*\))?/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[\s*\]/g, '')
    .replace(/\?(\s+extends\s+|\s+super\s+)?/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The simple (unqualified) name of a type reference.
 * @param {string} t
 */
export function simpleName(t) {
  const n = normalizeTypeRef(t);
  const i = n.lastIndexOf('.');
  return i >= 0 ? n.slice(i + 1) : n;
}
