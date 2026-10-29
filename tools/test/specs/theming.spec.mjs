/**
 * Theming: the light/dark switch and the fact that it sticks.
 *
 * Ported from the `--- theming ---` section of the old linear smoke test, which
 * only checked that the `t` shortcut flipped `html[data-theme]` and then took
 * the `10-treemap-light` screenshot. The suite also lived through a theme
 * toggle without ever asking whether the choice survived the next page load,
 * so that half is new here: a theme that resets on reload is a defect a user
 * notices immediately, and nothing else in the suite would catch it.
 *
 * The permalink is deliberately dropped before the reload: the app itself
 * writes `t=light` into the URL, and the URL-restore path would paper over a
 * broken settings load, making the check pass for the wrong reason.
 */

import { tab, theme } from '../locators.mjs';
import { canvasSignature } from '../probes.mjs';
import { seam } from '../seam.mjs';
import { SETTINGS_KEY } from '../fixtures.mjs';

export default {
  name: 'Theming',

  async run(t) {
    const { page } = t;

    await t.test('pressing t repaints the map in the light theme', async () => {
      // The map has to be the visible view for a canvas signature to describe it.
      await tab(page, 'treemap').click();
      await t.settle(500);
      const dark = await canvasSignature(page);

      await page.keyboard.press('t');
      await t.settle(500);

      const applied = await theme(page);
      t.assert.equal(applied, 'light', `the theme is ${applied} after pressing t`);

      const light = await canvasSignature(page);
      t.assert.notEqual(light, dark, 'the map was not repainted for the light theme');

      await t.shot('10-treemap-light');
      return `dark ${dark} → light ${light}`;
    });

    await t.test('pressing t again returns to the dark theme', async () => {
      await page.keyboard.press('t');
      await t.settle(400);
      const applied = await theme(page);
      t.assert.equal(applied, 'dark', `the theme is ${applied} after the second press`);
      return 'back to dark';
    });

    await t.test('the chosen theme is written to persisted settings', async () => {
      await page.keyboard.press('t');
      await t.settle(400);
      t.assert.equal(await theme(page), 'light', 'the page is not in the light theme');

      const stored = await seam.store.persisted(page, SETTINGS_KEY);
      t.assert.ok(stored, `nothing stored under ${SETTINGS_KEY}`);
      t.assert.equal(stored.theme, 'light', `stored theme is ${JSON.stringify(stored.theme)}`);
      return `${SETTINGS_KEY} · theme: light`;
    });

    await t.test('the theme survives a page reload', async () => {
      // Drop the permalink hash so only the persisted settings can bring the
      // theme back — the URL would otherwise carry `t=light` on its own.
      await page.evaluate(() => history.replaceState(null, '', location.pathname));
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForFunction(() => !!window.zombieAtlas, null, { timeout: 20000 });
      await t.settle(600);

      const applied = await theme(page);
      t.assert.equal(applied, 'light', `the theme is ${applied} after a reload`);
      return 'light after reload';
    });

    await t.test('no console errors', async () => {
      t.assert.deepEqual(t.errors, [], t.errors.slice(0, 3).join(' | '));
      return 'clean';
    });
  },
};
