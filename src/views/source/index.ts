import { msg } from '../../i18n';
/**
 * Source viewer — renders the actual decompiled file for a class.
 *
 * The raw `.java` tree is served by `tools/serve.mjs` at `/src/<package path>`,
 * so the atlas always shows the exact source the dataset was extracted from
 * instead of a copy that could drift.
 */

import type { ClassRec } from '../../domain';
import { h } from '../../util';
import { highlightSource } from './grammar-highlight';

let modalRoot: HTMLElement | null = null;

export async function openSource(c: ClassRec) {
  if (!modalRoot) modalRoot = document.getElementById('modal-root')!;
  const backdrop = h('div', { class: 'modal-backdrop' });
  const modal = h('div', { class: 'modal' });
  modal.append(
    h('h2', { text: `${c.name}  ·  ${c.path}` }),
    h('div', { class: 'insp-path', text: msg("declared at line {0} · {1} lines · {2} methods · {3} fields", c.declLine, c.loc, c.methods, c.fields) })
  );
  const body = h('div', { class: 'src-wrap' }, h('div', { class: 'empty', style: { padding: '12px' }, text: msg("loading source…") }));
  modal.append(body);
  modal.append(
    h(
      'div',
      { class: 'close-row' },
      h('button', {
        text: msg("Copy path"),
        onclick: () => navigator.clipboard?.writeText(c.path),
      }),
      h('button', { class: 'primary', text: msg("Close"), onclick: () => backdrop.remove() })
    )
  );
  backdrop.append(modal);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) backdrop.remove();
  });
  modalRoot.replaceChildren(backdrop);

  try {
    const res = await fetch(`src/${c.path.split('/').map(encodeURIComponent).join('/')}`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const text = await res.text();
    const lines = text.split('\n');
    // The grammar colours the whole file in one pass, so the window the viewer
    // shows always agrees with how the extractor read the file.
    const coloured = await highlightSource(text, c.path, c.language);
    const rows: string[] = [];
    const from = Math.max(1, c.declLine - 40);
    const to = Math.min(lines.length, c.declLine + 260);
    for (let i = from; i <= to; i++) {
      const hl = Math.abs(i - c.declLine) < 1 ? ' class="hl"' : '';
      rows.push(`<tr${hl}><td class="ln">${i}</td><td>${coloured[i - 1] ?? ''}</td></tr>`);
    }
    body.replaceChildren(
      h('table', {
        class: 'src-code',
        html: `<tbody>${rows.join('')}</tbody>`,
      })
    );
    const hlRow = body.querySelector('tr.hl');
    hlRow?.scrollIntoView({ block: 'center' });
  } catch (err) {
    body.replaceChildren(
      h('div', {
        class: 'empty',
        style: { padding: '12px' },
        text: msg("Could not load source ({0}). Run the atlas through \"npm run serve\" so /src is mapped to the decompiled tree.", (err as Error).message),
      })
    );
  }
}
