/**
 * Persistence: localStorage is validated and repaired, never trusted.
 *
 * Ported from the original smoke test. The contract being tested is stated in
 * the in-app help text: "On load every field is validated and anything missing
 * or malformed falls back to its default, then the repaired payload is written
 * back — so clearing storage, hand-editing it or upgrading the app can never
 * wedge the UI."
 *
 * Note on ordering: the sidebar's storage note is rendered from
 * `store.storage`, and the first state change resets that report to `ok`. Each
 * assertion on the note therefore runs immediately after a reload, before
 * anything else touches the app.
 */

import { activeChips, chip, controlButton, storageNote } from '../locators.mjs';
import { seam } from '../seam.mjs';
import { DEFAULT_SETTINGS, ISO_DOMAIN, SETTINGS_KEY } from '../fixtures.mjs';

/** Reload and wait for the app to publish its debug handle again. */
async function reload(t) {
  await t.page.reload({ waitUntil: 'networkidle' });
  await t.page.waitForFunction(() => !!window.zombieAtlas, null, { timeout: 20000 });
  await t.settle(1400);
}

/**
 * Boot from a hash-free URL with a known localStorage payload.
 *
 * The hash matters: it is a permalink, and `Store.applyUrl()` re-applies it on
 * every load, *after* settings have been read from storage. Reloading a URL that
 * still carries `#c=complexity` therefore resurrects that setting even over a
 * wiped or hand-written payload. Storage tests have to start hash-free or they
 * silently measure the permalink instead.
 */
async function bootWith(t, storage) {
  await t.page.goto(t.url, { waitUntil: 'networkidle' });
  await t.page.evaluate(
    ({ key, payload }) => {
      localStorage.clear();
      if (payload !== null) localStorage.setItem(key, JSON.stringify(payload));
    },
    { key: SETTINGS_KEY, payload: storage ?? null }
  );
  await reload(t);
}

/** Drop the permalink so only localStorage can restore state. */
async function stripHash(page) {
  await page.evaluate(() => history.replaceState(null, '', location.pathname + location.search));
}

/** A payload with the wrong type for every important field. */
const MALFORMED = {
  version: 99,
  theme: 42,
  sizeMetric: 'not-a-metric',
  colorMode: { nope: true },
  groupBy: 'nonsense',
  layout: 7,
  depthLimit: 'deep',
  padding: 'lots',
  minShare: -3,
  sort: 'sideways',
  sidebar: 'yes',
  weights: { code: 'a', complexity: null },
  filters: { query: 123, kinds: 'all', stereotypes: 'x', domains: 'iso', luaOnly: 'yes', minCode: -5 },
};

export default {
  name: 'Persistence',

  async run(t) {
    const { page } = t;

    await t.test('settings persist in localStorage across a reload', async () => {
      await bootWith(t, null);
      await seam.store.apply(page, { settings: { colorMode: 'complexity', groupBy: 'stereotype', depthLimit: 3 } });
      await t.settle(700);
      const written = await seam.store.persisted(page, SETTINGS_KEY);
      t.assert.equal(written.colorMode, 'complexity', 'not written before the reload');

      // Remove the permalink so only storage can bring the settings back.
      await stripHash(page);
      await reload(t);

      const settings = await seam.store.settings(page);
      t.assert.equal(settings.colorMode, 'complexity', 'colour mode');
      t.assert.equal(settings.groupBy, 'stereotype', 'grouping');
      t.assert.equal(settings.depthLimit, 3, 'depth limit');
      return 'colour, grouping and depth limit restored from storage alone';
    });

    await t.test('a permalink outranks stored settings', async () => {
      // Storage says light/complexity, the hash says dark/kind: the hash wins.
      await bootWith(t, { version: 1, theme: 'light', colorMode: 'complexity' });
      const app = await t.newApp({ hash: '#t=dark&c=kind' });
      const settings = await seam.store.settings(app.page);
      t.assert.equal(settings.theme, 'dark', `theme=${settings.theme}`);
      t.assert.equal(settings.colorMode, 'kind', `colorMode=${settings.colorMode}`);
      return 'hash overrides storage for settings it carries';
    });

    await t.test('a wiped storage is rewritten with defaults and reported', async () => {
      await bootWith(t, null);

      const stored = await seam.store.persisted(page, SETTINGS_KEY);
      const keys = await page.evaluate(() => Object.keys(localStorage).length);
      t.assert.ok(stored, 'nothing was written back');
      t.assert.equal(keys, 1, `${keys} localStorage keys, expected only the settings key`);
      t.assert.equal(stored.theme, DEFAULT_SETTINGS.theme, 'theme');
      t.assert.equal(stored.sizeMetric, DEFAULT_SETTINGS.sizeMetric, 'size metric');
      t.assert.equal(stored.version, DEFAULT_SETTINGS.version, 'payload version');
      t.assert.ok(Array.isArray(stored.filters.domains), 'filters.domains is not an array');

      // Read the note before any interaction resets the storage report.
      const note = (await storageNote(page).textContent()) ?? '';
      t.assert.match(note, /no saved settings/i, note.trim());
      return `defaults rewritten, note: ${note.trim()}`;
    });

    await t.test('a malformed payload is repaired field by field', async () => {
      const mark = t.errors.length;
      await bootWith(t, MALFORMED);

      const repaired = await seam.store.persisted(page, SETTINGS_KEY);
      t.assert.equal(repaired.theme, DEFAULT_SETTINGS.theme, `theme=${repaired.theme}`);
      t.assert.equal(repaired.sizeMetric, DEFAULT_SETTINGS.sizeMetric, `sizeMetric=${repaired.sizeMetric}`);
      t.assert.equal(repaired.colorMode, DEFAULT_SETTINGS.colorMode, `colorMode=${repaired.colorMode}`);
      t.assert.equal(repaired.groupBy, DEFAULT_SETTINGS.groupBy, `groupBy=${repaired.groupBy}`);
      t.assert.equal(repaired.depthLimit, DEFAULT_SETTINGS.depthLimit, `depthLimit=${repaired.depthLimit}`);
      t.assert.equal(repaired.padding, DEFAULT_SETTINGS.padding, `padding=${repaired.padding}`);
      t.assert.equal(repaired.minShare, DEFAULT_SETTINGS.minShare, `minShare=${repaired.minShare}`);
      t.assert.equal(repaired.sort, DEFAULT_SETTINGS.sort, `sort=${repaired.sort}`);
      t.assert.equal(repaired.filters.query, '', `query=${repaired.filters.query}`);
      t.assert.ok(Array.isArray(repaired.filters.kinds), 'kinds is not an array');
      t.assert.ok(Array.isArray(repaired.filters.stereotypes), 'stereotypes is not an array');
      t.assert.ok(Array.isArray(repaired.filters.domains), 'domains is not an array');
      t.assert.equal(typeof repaired.filters.luaOnly, 'boolean', 'luaOnly is not a boolean');
      t.assert.equal(typeof repaired.filters.minCode, 'number', 'minCode is not a number');

      const note = (await storageNote(page).textContent()) ?? '';
      t.assert.match(note, /repaired on load/i, note.trim());
      t.assert.deepEqual(t.errorsSince(mark), [], t.errorsSince(mark).slice(0, 2).join(' | '));
      return `every field defaulted, note: ${note.trim()}`;
    });

    await t.test('the app still renders after a malformed payload', async () => {
      const snapshot = await seam.treemap.snapshot(page);
      t.assert.ok(snapshot.nodes > 1000, `only ${snapshot.nodes} nodes drawn`);
      return `${snapshot.nodes} nodes drawn`;
    });

    // The repaired payload must be usable, not merely defaulted: clicking a
    // domain chip used to throw when `filters.domains` had arrived as a string.
    await t.test('filters stay interactive after a repair', async () => {
      const mark = t.errors.length;
      await chip(page, ISO_DOMAIN).click();
      await t.settle(800);
      const filters = await seam.store.filters(page);
      const snapshot = await seam.treemap.snapshot(page);
      t.assert.deepEqual(filters.domains, [ISO_DOMAIN], JSON.stringify(filters.domains));
      t.assert.ok(snapshot.nodes > 0, 'nothing left to draw');
      t.assert.deepEqual(t.errorsSince(mark), [], t.errorsSince(mark).slice(0, 2).join(' | '));
      return `domain=${ISO_DOMAIN}, ${snapshot.nodes} nodes`;
    });

    await t.test('Restore defaults resets the settings and the stored payload', async () => {
      await controlButton(page, 'Restore defaults').click();
      await t.settle(900);

      const stored = await seam.store.persisted(page, SETTINGS_KEY);
      const snapshot = await seam.treemap.snapshot(page);
      t.assert.equal(stored.filters.domains.length, 0, 'filters were not cleared');
      t.assert.equal(stored.theme, DEFAULT_SETTINGS.theme, 'theme');
      t.assert.equal(stored.sizeMetric, DEFAULT_SETTINGS.sizeMetric, 'size metric');
      t.assert.ok(snapshot.nodes > 4000, `only ${snapshot.nodes} nodes drawn`);
      await t.shot('19-restore-defaults');
      return `stored payload reset, ${snapshot.nodes} nodes`;
    });

    /**
     * Known defect: the storage report is overwritten by the first state change.
     *
     * `Store.saveSettings()` unconditionally promotes the load report to `ok`
     * once a write succeeds, and `onStateChange()` calls `saveSettings()` on
     * every render. The sidebar note is derived from that report, so a repair is
     * announced on load and then silently un-announced as soon as the user
     * touches any control — the one moment the information is useful.
     */
    await t.todo('the repair note survives a later interaction', async () => {
      await bootWith(t, MALFORMED);
      await chip(page, ISO_DOMAIN).click();
      await t.settle(700);
      const note = (await storageNote(page).textContent()) ?? '';
      t.assert.match(note, /repaired on load/i, `after interaction: ${note.trim()}`);
      return 'note still reports the repair';
    });

    await t.test('no console errors', async () => {
      t.assert.deepEqual(t.errors, [], t.errors.slice(0, 3).join(' | '));
      return 'clean';
    });

    // Leave storage in a clean, default state for anything that follows.
    await page.evaluate((key) => localStorage.removeItem(key), SETTINGS_KEY);
  },
};
