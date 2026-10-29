/**
 * Exports: the PNG and JSON downloads offered by the treemap toolbar.
 *
 * Ported from the `--- exports ---` section of the old linear smoke test, which
 * only asserted that clicking JSON produced a download event, and then grew the
 * real content checks on the localization pass (see the localization spec):
 * the serialized payload is the interchange format for other tools, so its
 * field names and its declaration kinds must not follow the UI language.
 *
 * Two things the old check never did are covered here as well:
 *
 *   - the PNG branch, whose file name advertises the current size metric and
 *     colour mode and whose bytes have to be a real image;
 *   - the fact that the export follows the *active filters* rather than the
 *     whole dataset — an export that ignores the filters silently ships 4,700
 *     types when the user asked for 557.
 */

import fs from 'node:fs';
import { controlSelect, stageAction, statusbar, tab, uiLanguage } from '../locators.mjs';
import { seam } from '../seam.mjs';
import { ISO_DOMAIN } from '../fixtures.mjs';

/** Declaration kinds the exporter may report — canonical ids, never translated. */
const KINDS = ['class', 'interface', 'enum', 'record', 'annotation'];

/** PNG file signature, bytes 0-7 (RFC 2083 §4.3). */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Click one of the stage buttons and return the download it starts.
 *
 * The listener is installed before the click: a blob download can land in the
 * same tick, and `null` (the catch) turns "no download" into a readable
 * assertion failure instead of a timeout.
 */
async function clickForDownload(page, action) {
  const pending = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  await action();
  return pending;
}

/** A download's suggested name and its full bytes. */
async function readDownload(download) {
  const file = await download.path();
  if (!file) throw new Error('the download produced no local file');
  return { name: download.suggestedFilename(), bytes: fs.readFileSync(file) };
}

/** How many types the app itself says are shown (the first number in the status bar). */
async function shownCount(page) {
  const text = (await statusbar(page).textContent()) ?? '';
  const match = text.match(/^\s*([\d,]+)\s*\/\s*([\d,]+)/);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

export default {
  name: 'Exports',

  async run(t) {
    const { page } = t;

    /** The unfiltered payload, to compare the Chinese export against. */
    const baseline = { fqns: [], kinds: [] };

    await t.test('the JSON export lists every visible type with its source metadata', async () => {
      // The export buttons live on the map's stage toolbar.
      await tab(page, 'treemap').click();
      await t.settle(400);

      const download = await clickForDownload(page, () => stageAction(page, 'JSON').click());
      t.assert.ok(download, 'clicking JSON started no download');
      const { name, bytes } = await readDownload(download);
      const payload = JSON.parse(bytes.toString('utf8'));

      t.assert.ok(Array.isArray(payload.types) && payload.types.length > 0, 'the export carries no types');

      // Every entry is a self-describing record: without fqn/kind/package/code
      // the payload is not usable by whatever consumes it.
      const incomplete = payload.types.filter(
        (c) =>
          typeof c['fqn'] !== 'string' ||
          c['fqn'].length === 0 ||
          typeof c['kind'] !== 'string' ||
          typeof c['package'] !== 'string' ||
          typeof c['code'] !== 'number'
      );
      t.assert.deepEqual(incomplete.slice(0, 3), [], `${incomplete.length} entries without fqn/kind/package/code`);

      const shown = await shownCount(page);
      t.assert.equal(payload.types.length, shown, `exported ${payload.types.length} types but the status bar shows ${shown}`);
      t.assert.match(name, /\.json$/, `the file was named ${name}`);

      baseline.fqns = payload.types.map((c) => c['fqn']).sort();
      baseline.kinds = [...new Set(payload.types.map((c) => c['kind']))].sort();
      return `${name} · ${payload.types.length} types`;
    });

    await t.test('the PNG export is a real image named after the current settings', async () => {
      await controlSelect(page, 'Size metric').selectOption('complexity');
      await controlSelect(page, 'Colour by').selectOption('kind');
      await t.settle(600);

      const download = await clickForDownload(page, () => stageAction(page, 'PNG').click());
      t.assert.ok(download, 'clicking PNG started no download');
      const { name, bytes } = await readDownload(download);

      t.assert.equal(name, 'zombie-atlas-complexity-kind.png', `the file was named ${name}`);
      t.assert.ok(bytes.length > PNG_MAGIC.length, `the download is only ${bytes.length} bytes`);
      t.assert.deepEqual([...bytes.subarray(0, 8)], PNG_MAGIC, `not a PNG: ${[...bytes.subarray(0, 8)]}`);

      // Put the controls back where they were found.
      await controlSelect(page, 'Size metric').selectOption('code');
      await controlSelect(page, 'Colour by').selectOption('domain');
      await t.settle(500);
      return `${name} · ${bytes.length} bytes, valid signature`;
    });

    await t.test('the JSON export follows the active filters', async () => {
      const all = JSON.parse(
        (await readDownload(await clickForDownload(page, () => stageAction(page, 'JSON').click()))).bytes.toString('utf8')
      );

      await seam.store.apply(page, { filters: { domains: [ISO_DOMAIN] } });
      await t.settle(700);

      const filtered = JSON.parse(
        (await readDownload(await clickForDownload(page, () => stageAction(page, 'JSON').click()))).bytes.toString('utf8')
      );

      t.assert.ok(filtered.types.length > 0, `the ${ISO_DOMAIN} domain filter exported nothing`);
      t.assert.ok(
        filtered.types.length < all.types.length,
        `${filtered.types.length} types after the filter, ${all.types.length} before`
      );
      t.assert.equal(
        filtered.types.length,
        await shownCount(page),
        'the export disagrees with the count the status bar reports'
      );

      // `iso` is the first package component below the source root, so a domain
      // filter may only leave `zombie.iso…` packages behind.
      const stray = filtered.types.filter((c) => !/^zombie\.iso(\.|$)/.test(c['package']));
      t.assert.deepEqual(stray.slice(0, 3).map((c) => c['package']), [], `${stray.length} types from outside the iso domain`);

      return `${all.types.length} → ${filtered.types.length} types with the ${ISO_DOMAIN} filter`;
    });

    /**
     * The i18n guarantee the old suite established: the payload is an
     * interchange format, so `kind` stays a canonical id and `fqn` stays a
     * source identifier while the UI itself is Chinese.
     */
    await t.test('declaration kinds and type names stay language-neutral in a Chinese UI', async () => {
      await t.switchLanguage('zh-CN');
      await seam.store.apply(page, { resetFilters: true });
      await t.settle(700);

      const language = await uiLanguage(page);
      t.assert.match(language ?? '', /^zh/, `the UI language is ${language}, so this check would prove nothing`);

      const download = await clickForDownload(page, () => stageAction(page, 'JSON').click());
      t.assert.ok(download, 'clicking JSON started no download in the Chinese UI');
      const payload = JSON.parse((await readDownload(download)).bytes.toString('utf8'));

      t.assert.ok(payload.types.length > 0, 'the Chinese export carries no types');

      const kinds = [...new Set(payload.types.map((c) => c['kind']))].sort();
      const translated = kinds.filter((k) => !KINDS.includes(k));
      t.assert.deepEqual(translated, [], `translated kind labels leaked into the export: ${translated.join(', ')}`);
      t.assert.deepEqual(kinds, baseline.kinds, 'the exported kinds changed with the UI language');

      const canonical = new Set(baseline.fqns);
      const renamed = payload.types.map((c) => c['fqn']).filter((f) => !canonical.has(f));
      t.assert.deepEqual(renamed.slice(0, 3), [], `${renamed.length} type names differ from the English export`);
      t.assert.equal(
        payload.types.length,
        baseline.fqns.length,
        `the Chinese export has ${payload.types.length} types, the English one ${baseline.fqns.length}`
      );

      return `${payload.types.length} types · kinds ${kinds.join('/')} · html[lang]=${language}`;
    });

    await t.test('no console errors', async () => {
      t.assert.deepEqual(t.errors, [], t.errors.slice(0, 3).join(' | '));
      return 'clean';
    });
  },
};
