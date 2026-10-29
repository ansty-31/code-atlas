/**
 * Boot: the app loads the dataset and lays out its shell.
 *
 * Also proves the locator strategy works — every labelled control in the
 * sidebar must resolve by its visible label, which is what the other specs rely
 * on to avoid positional selectors like `select >> nth=3`.
 */

import {
  brandSub,
  controlField,
  controlSelect,
  inspectorBody,
  legendItems,
  statusbar,
  tabs,
} from '../locators.mjs';

/** Controls that are `<select>`s with a stable visible label. */
const LABELLED_SELECTS = ['Size metric', 'Colour by', 'Group by', 'Layout', 'Sort'];

export default {
  name: 'Boot',

  async run(t) {
    const { page } = t;

    await t.test('dataset loads and reports its scale', async () => {
      const text = (await brandSub(page).textContent()) ?? '';
      t.assert.match(text, /types/, `brand subtitle was ${JSON.stringify(text)}`);
      return text.trim();
    });

    await t.test('the five views are offered as tabs', async () => {
      const count = await tabs(page).count();
      t.assert.equal(count, 5, `found ${count} tabs`);
      return 'treemap · hierarchy · dependencies · subsystems · insights';
    });

    await t.test('every labelled control resolves', async () => {
      const missing = [];
      for (const label of LABELLED_SELECTS) {
        if ((await controlField(page, label).count()) === 0) missing.push(label);
      }
      t.assert.deepEqual(missing, [], `no field matched: ${missing.join(', ')}`);
      return LABELLED_SELECTS.join(', ');
    });

    await t.test('every control select is populated', async () => {
      const empty = [];
      for (const label of LABELLED_SELECTS) {
        const n = await controlSelect(page, label).locator('option').count();
        if (n < 2) empty.push(`${label}:${n}`);
      }
      t.assert.deepEqual(empty, [], `selects without options: ${empty.join(', ')}`);
      return `${LABELLED_SELECTS.length} selects`;
    });

    await t.test('legend renders entries', async () => {
      const count = await legendItems(page).count();
      t.assert.ok(count > 3, `only ${count} legend entries`);
      return `${count} entries`;
    });

    await t.test('inspector opens on the project overview', async () => {
      const text = (await inspectorBody(page).textContent()) ?? '';
      t.assert.match(text, /Project overview/, text.slice(0, 80));
      return 'no selection';
    });

    await t.test('status bar reports the visible type count', async () => {
      const text = (await statusbar(page).textContent()) ?? '';
      t.assert.match(text, /types shown/, text.slice(0, 80));
      return text.trim().replace(/\s+/g, ' ').slice(0, 70);
    });

    await t.test('no console errors during boot', async () => {
      t.assert.deepEqual(t.errors, [], t.errors.slice(0, 3).join(' | '));
      return 'clean';
    });
  },
};
