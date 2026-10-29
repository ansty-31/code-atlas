/**
 * Customisation: the sidebar controls, the filter chips and the view hotkeys.
 *
 * Ported from the original smoke test (metric / colour / group-by switching)
 * and extends it to the rest of the control surface, which the old suite only
 * touched through positional selectors (`select >> nth=0`). Every control here
 * is located by its visible label.
 */

import {
  activeChips,
  chip,
  controlButton,
  controlNumber,
  controlRanges,
  controlSelect,
  inspector,
  legendGradient,
  sidebar,
  statusbar,
  tab,
  workspace,
} from '../locators.mjs';
import { canvasSignature } from '../probes.mjs';
import { seam } from '../seam.mjs';
import { ISO_DOMAIN } from '../fixtures.mjs';

/** The status bar ends with "metric · colour · grouping". */
const statusSummary = async (page) => ((await statusbar(page).textContent()) ?? '').replace(/\s+/g, ' ');

export default {
  name: 'Customisation',

  async run(t) {
    const { page } = t;

    await t.test('the size metric drives the status bar and the map', async () => {
      const before = await canvasSignature(page);
      await controlSelect(page, 'Size metric').selectOption('complexity');
      await t.settle(700);
      const after = await canvasSignature(page);
      t.assert.notEqual(after, before, 'the treemap did not repaint');
      const summary = await statusSummary(page);
      t.assert.match(summary, /complexity/i, summary);
      await controlSelect(page, 'Size metric').selectOption('code');
      await t.settle(400);
      return 'code → complexity repaints';
    });

    await t.test('switching the colour mode repaints and updates the legend', async () => {
      const before = await canvasSignature(page);
      await controlSelect(page, 'Colour by').selectOption('complexity');
      await t.settle(700);
      const after = await canvasSignature(page);
      t.assert.notEqual(after, before, 'the treemap did not repaint');
      // Numeric colour modes swap the categorical legend for a gradient scale.
      const gradient = await legendGradient(page).count();
      t.assert.ok(gradient > 0, 'no gradient legend rendered for a heat map mode');
      await controlSelect(page, 'Colour by').selectOption('domain');
      await t.settle(400);
      return 'complexity shows a gradient legend';
    });

    await t.test('regrouping the tree repaints it', async () => {
      const before = await canvasSignature(page);
      await controlSelect(page, 'Group by').selectOption('stereotype');
      await t.settle(800);
      const after = await canvasSignature(page);
      t.assert.notEqual(after, before, 'the treemap did not repaint');
      const summary = await statusSummary(page);
      t.assert.match(summary, /stereotype/i, summary);
      await t.shot('11-groupby-stereotype');
      await controlSelect(page, 'Group by').selectOption('package');
      await t.settle(500);
      return 'stereotype grouping differs from package grouping';
    });

    await t.test('the composite metric reveals weight sliders that reshape the map', async () => {
      const before = (await controlRanges(page).count());
      await controlSelect(page, 'Size metric').selectOption('composite');
      await t.settle(600);
      const after = await controlRanges(page).count();
      t.assert.equal(after - before, 6, `${before} → ${after} range inputs`);

      // The default weights put everything on `code`, so rescaling that one
      // weight is a uniform rescale and legitimately does not change the
      // layout. Blend in a second metric instead.
      const signatureBefore = await canvasSignature(page);
      await controlRanges(page).nth(1).fill('0.6'); // complexity
      await t.settle(800);

      const weights = (await seam.store.settings(page)).weights;
      t.assert.equal(Number(weights.complexity), 0.6, `weight not applied: ${JSON.stringify(weights)}`);

      const signatureAfter = await canvasSignature(page);
      t.assert.notEqual(signatureAfter, signatureBefore, 'blending complexity did not repaint');

      await controlSelect(page, 'Size metric').selectOption('code');
      await t.settle(400);
      return `${before} → ${after} sliders, code+complexity blended`;
    });

    await t.test('a domain chip filters the atlas', async () => {
      const total = await seam.atlas.counts(page);
      await chip(page, ISO_DOMAIN).click();
      await t.settle(800);
      const active = await activeChips(page).count();
      t.assert.equal(active, 1, `${active} active chips`);

      const text = (await statusbar(page).textContent()) ?? '';
      const shown = Number(text.match(/([\d,]+)\s*\/\s*[\d,]+ types shown/)?.[1].replace(/,/g, '') ?? '0');
      t.assert.ok(shown > 0 && shown < total.types, `shown=${shown} of ${total.types}`);
      return `${ISO_DOMAIN}: ${shown}/${total.types} types`;
    });

    await t.test('the clear-filters button resets every chip', async () => {
      const clear = controlButton(page, /Clear .*filter/);
      t.assert.ok((await clear.count()) > 0, 'no clear-filters button appeared');
      await clear.click();
      await t.settle(700);
      const active = await activeChips(page).count();
      t.assert.equal(active, 0, `${active} chips still active`);
      return 'all chips cleared';
    });

    await t.test('a minimum code-lines filter narrows the tree', async () => {
      const before = await canvasSignature(page);
      await controlNumber(page, 'Minimum code lines').fill('500');
      await controlNumber(page, 'Minimum code lines').press('Enter');
      await t.settle(800);
      const after = await canvasSignature(page);
      t.assert.notEqual(after, before, 'the filter did not repaint the map');
      await controlNumber(page, 'Minimum code lines').fill('0');
      await controlNumber(page, 'Minimum code lines').press('Enter');
      await t.settle(600);
      return 'minCode=500 narrows the map';
    });

    await t.test('number keys switch views', async () => {
      for (const [key, view] of [['3', 'dependencies'], ['4', 'subsystems'], ['5', 'insights'], ['1', 'treemap']]) {
        await page.keyboard.press(key);
        await t.settle(400);
        const current = await seam.store.view(page);
        t.assert.equal(current, view, `key ${key} selected ${current}`);
      }
      return '1–5 map to the five views';
    });

    /**
     * Known defect: the sidebar and inspector collapse is dead code.
     *
     * `styles.css` defines `.workspace.no-sidebar` / `.workspace.no-inspector`
     * (lines 164-167), and `settings.sidebar` / `settings.inspector` are
     * persisted to localStorage and carried in the permalink — but nothing ever
     * adds those classes to `.workspace`. `S`, `I` and the ⚙ top-bar button flip
     * the setting and have no visible effect.
     */
    await t.todo('pressing S collapses the sidebar', async () => {
      await page.keyboard.press('s');
      await t.settle(400);
      const classes = (await workspace(page).getAttribute('class')) ?? '';
      const hidden = !(await sidebar(page).isVisible());
      t.assert.ok(hidden && /\bno-sidebar\b/.test(classes), `class="${classes}" visible=${!hidden}`);
      return 'no-sidebar applied';
    });

    await t.todo('pressing I collapses the inspector', async () => {
      await page.keyboard.press('i');
      await t.settle(400);
      const classes = (await workspace(page).getAttribute('class')) ?? '';
      const hidden = !(await inspector(page).isVisible());
      t.assert.ok(hidden && /\bno-inspector\b/.test(classes), `class="${classes}" visible=${!hidden}`);
      return 'no-inspector applied';
    });

    await t.test('no console errors', async () => {
      t.assert.deepEqual(t.errors, [], t.errors.slice(0, 3).join(' | '));
      return 'clean';
    });

    // Leave the app on a known view for any spec that follows in the same page.
    await tab(page, 'treemap').click();
    await t.settle(300);
  },
};
