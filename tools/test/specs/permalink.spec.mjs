/**
 * Permalink: the URL hash encodes the whole view so a link reproduces it.
 *
 * Ported from the original smoke test. The old suite checked only that the
 * hash was unchanged across a reload; this also checks that the *state* it
 * encodes round-trips, that defaults are omitted to keep links short, and that
 * an externally supplied hash is applied on load.
 */

import { tab, theme } from '../locators.mjs';
import { distinctCanvasColors } from '../probes.mjs';
import { seam } from '../seam.mjs';
import { ZOOM_ISO } from '../fixtures.mjs';

/** The state that a permalink is expected to carry. */
const RICH_STATE = {
  view: 'dependencies',
  depMode: 'matrix',
  zoom: ZOOM_ISO,
  classIdByName: 'IsoPlayer',
  filters: { query: 'Iso', luaOnly: true, domains: ['iso'], minCode: 5 },
  settings: { colorMode: 'complexity', groupBy: 'stereotype', layout: 'binary' },
};

/** Everything the hash is supposed to preserve. */
const signature = async (page) => {
  const state = await seam.store.state(page);
  return JSON.stringify([
    state.view,
    state.depMode,
    state.selection.classId,
    state.selection.zoom,
    state.selection.packagePath,
    state.settings,
  ]);
};

export default {
  name: 'Permalink',

  async run(t) {
    const { page } = t;

    await t.test('non-default state is written to the URL', async () => {
      await seam.store.apply(page, RICH_STATE);
      await t.settle(900);
      const hash = await page.evaluate(() => location.hash);
      t.assert.ok(hash.length > 1, 'no hash was written');
      for (const key of ['v=', 'dm=', 'c=', 'g=', 'q=', 'z=']) {
        t.assert.ok(hash.includes(key), `${key} missing from ${hash}`);
      }
      return hash.slice(0, 90);
    });

    await t.test('a reload restores the same hash and the same state', async () => {
      const hashBefore = await page.evaluate(() => location.hash);
      const stateBefore = await signature(page);

      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForFunction(() => !!window.zombieAtlas, null, { timeout: 20000 });
      await t.settle(1200);

      const hashAfter = await page.evaluate(() => location.hash);
      t.assert.equal(hashAfter, hashBefore, 'hash changed across the reload');

      const stateAfter = await signature(page);
      t.assert.equal(stateAfter, stateBefore, 'state was not reproduced from the permalink');
      await t.shot('14-permalink-reload');
      return 'view, selection, filters and settings all round-trip';
    });

    await t.test('a shared permalink is applied on load', async () => {
      const app = await t.newApp({
        hash: '#v=hierarchy&c=complexity&g=stereotype&l=binary&q=IsoPlayer&t=light&min=12',
      });
      const state = await seam.store.state(app.page);
      t.assert.equal(state.view, 'hierarchy', 'view');
      t.assert.equal(state.settings.colorMode, 'complexity', 'colour mode');
      t.assert.equal(state.settings.groupBy, 'stereotype', 'grouping');
      t.assert.equal(state.settings.layout, 'binary', 'layout');
      t.assert.equal(state.settings.theme, 'light', 'theme');
      t.assert.equal(state.settings.filters.query, 'IsoPlayer', 'query');
      t.assert.equal(state.settings.filters.minCode, 12, 'minCode');

      const applied = await theme(app.page);
      t.assert.equal(applied, 'light', 'theme was not applied to the document');
      return 'view, colour, grouping, layout, theme and filters';
    });

    await t.test('a fresh default state produces a minimal hash', async () => {
      const app = await t.newApp();
      const hash = await app.page.evaluate(() => location.hash);
      // Defaults are omitted so a permalink only carries what differs.
      t.assert.ok(hash === '' || hash === '#v=treemap', `unexpected hash: ${hash}`);
      return hash === '' ? '(empty)' : hash;
    });

    await t.test('an unrecognised view in the hash is ignored', async () => {
      const app = await t.newApp({ hash: '#v=not-a-view&dm=sideways' });
      const state = await seam.store.state(app.page);
      t.assert.equal(state.view, 'treemap', 'view');
      t.assert.equal(state.depMode, 'graph', 'dependency mode');
      return 'falls back to defaults';
    });

    await t.test('a malformed permalink still renders the app', async () => {
      const app = await t.newApp({ hash: '#l=garbage&c=garbage&g=garbage&z=p:zombie' });
      await app.page.waitForTimeout(900);
      const colours = await distinctCanvasColors(app.page);
      t.assert.ok(colours > 5, `only ${colours} distinct samples`);
      t.assert.deepEqual(app.errors, [], app.errors.slice(0, 2).join(' | '));
      return `still paints (${colours} distinct samples), no errors`;
    });

    /**
     * Regression guard for a defect the restructured suite surfaced.
     *
     * `Store.applyUrl()` used to validate `view`, `depMode`, `sizeMetric` and
     * `theme`, then assign `colorMode`, `groupBy` and `layout` straight from the
     * query string with a bare cast — while the storage path validated those
     * same three fields against allow-lists. A malformed link produced a state
     * no control could reach: the treemap fell back to its default colouring
     * while the legend switched on `colorMode` and listed domains, so the two
     * disagreed, and the status bar echoed the raw string back at the user.
     * Nothing threw, which is why it survived this long.
     *
     * Both channels now run through one set of field specs, so this is fixed.
     */
    await t.test('unrecognised enum values in a permalink fall back to their defaults', async () => {
      const app = await t.newApp({ hash: '#c=garbage&g=garbage&l=garbage' });
      const settings = await seam.store.settings(app.page);
      t.assert.equal(settings.colorMode, 'domain', `colorMode=${settings.colorMode}`);
      t.assert.equal(settings.groupBy, 'package', `groupBy=${settings.groupBy}`);
      t.assert.equal(settings.layout, 'squarify', `layout=${settings.layout}`);
      return 'all three rejected and defaulted';
    });

    await t.test('no console errors', async () => {
      t.assert.deepEqual(t.errors, [], t.errors.slice(0, 3).join(' | '));
      return 'clean';
    });

    await tab(page, 'treemap').click();
    await t.settle(300);
  },
};
