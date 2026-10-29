/** Grammar-based line accounting shared by language adapters. */
export function lineTable(src, comments) {
  const lines = src.split('\n');
  const n = lines.length;
  const starts = new Int32Array(n + 1);
  let off = 0;
  for (let i = 0; i < n; i++) {
    starts[i] = off;
    off += lines[i].length + 1;
  }
  starts[n] = src.length;

  const inComment = new Uint8Array(src.length);
  for (const c of comments) for (let i = c.startIndex; i < c.endIndex; i++) inComment[i] = 1;

  const blank = new Uint8Array(n); // 1-based lines are indexed here as line - 1
  const commentOnly = new Uint8Array(n);
  for (let ln = 1; ln <= n; ln++) {
    const from = starts[ln - 1];
    const to = ln < n ? starts[ln] - 1 : src.length;
    let hasText = false;
    let hasCode = false;
    for (let i = from; i < to; i++) {
      const ch = src.charCodeAt(i);
      // space, tab, CR, LF and the form feed / vertical tab Java allows
      if (ch === 32 || ch === 9 || ch === 13 || ch === 10 || ch === 12 || ch === 11) continue;
      hasText = true;
      if (!inComment[i]) {
        hasCode = true;
        break;
      }
    }
    if (!hasText) blank[ln - 1] = 1;
    else if (!hasCode) commentOnly[ln - 1] = 1;
  }

  const cumBlank = new Int32Array(n + 1);
  const cumComment = new Int32Array(n + 1);
  const cumBytes = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    cumBlank[i + 1] = cumBlank[i] + blank[i];
    cumComment[i + 1] = cumComment[i] + commentOnly[i];
    cumBytes[i + 1] = cumBytes[i] + Buffer.byteLength(lines[i], 'utf8') + 1;
  }

  /** Line stats for an inclusive 1-based range — same contract as before. */
  const range = (from, to) => {
    const lo = Math.max(1, Math.min(from, n));
    const hi = Math.max(lo, Math.min(to, n));
    const loc = hi - lo + 1;
    const bl = cumBlank[hi] - cumBlank[lo - 1];
    const cm = cumComment[hi] - cumComment[lo - 1];
    return { loc, blank: bl, commentOnly: cm, code: loc - bl - cm };
  };
  const bytesOfRange = (from, to) => {
    const lo = Math.max(1, Math.min(from, n));
    const hi = Math.max(lo, Math.min(to, n));
    return cumBytes[hi] - cumBytes[lo - 1] - 1; // the last line carries no trailing newline
  };
  return { range, bytesOfRange, lines: n, blank: cumBlank[n], commentOnly: cumComment[n], loc: n, code: n - cumBlank[n] - cumComment[n] };
}
