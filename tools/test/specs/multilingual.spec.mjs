/** Dataset-independent checks, run against real repos and the C++ fixture. */
import { seam } from '../seam.mjs';
import { controlSelect, inspectorAction, modalPrimary, sourceRows, inspectorBody, tab, sourceLanguageChips } from '../locators.mjs';

export default {
  name: 'Multilingual project',
  async run(t) {
    const { page } = t;
    const meta = await seam.atlas.meta(page);
    const entities = await seam.atlas.entities(page);

    await t.test('directory layout contains file containers', async () => {
      const records = await seam.treemap.records(page);
      if (entities.some((entity) => entity.kind === 5)) t.assert.ok(records.some((record) => record.groupType === 'file'));
      t.assert.ok(records.length > 0);
      return `${meta.counts.files} files · ${(meta.languages ?? ['java']).join(', ')}`;
    });

    for (const language of meta.languages ?? ['java']) {
      await t.test(`${language}: map filter and colour adapt`, async () => {
        await seam.store.apply(page, { resetFilters: true, filters: { languages: [language] }, settings: { colorMode: 'language' } });
        await t.settle(150);
        const ids = new Set(entities.filter((entity) => entity.language === language).map((entity) => entity.id));
        const leaves = (await seam.treemap.records(page)).filter((record) => record.kind === 'class' || record.kind === 'member');
        t.assert.ok(leaves.length > 0);
        t.assert.ok(leaves.every((record) => ids.has(record.classId)), 'a different language leaked into the map');
      });

      await t.test(`${language}: source viewer fetches the matching grammar`, async () => {
        const entity = entities.find((candidate) => candidate.language === language && candidate.methods > 0);
        t.assert.ok(entity, 'no callable source fixture');
        const requested = new Set();
        const listener = (request) => requested.add(request.url());
        page.on('request', listener);
        try {
          await seam.store.apply(page, { classId: entity.id });
          await inspectorAction(page, 'View source').click();
          await sourceRows(page).first().waitFor({ timeout: 15000 });
          t.assert.ok(requested.has(new URL(`ts/tree-sitter-${language}.wasm`, t.url).href), 'the language grammar was not requested');
          t.assert.ok(await sourceRows(page).locator('span[class^="tk-"]').count() > 0, 'source remained unhighlighted');
          const source = await page.request.get(new URL(`src/${entity.path.split('/').map(encodeURIComponent).join('/')}`, t.url).href);
          t.assert.equal(source.status(), 200);
          t.assert.match(source.headers()['content-type'], /text\/plain/);
          await modalPrimary(page).click();
        } finally { page.off('request', listener); }
      });
    }

    await t.test('language chips persist the map selection', async () => {
      await seam.store.apply(page, { resetFilters: true });
      await t.settle(100);
      await sourceLanguageChips(page).first().click();
      await t.settle(100);
      const chosen = (await seam.store.filters(page)).languages;
      t.assert.equal(chosen.length, 1);
      t.assert.equal(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('lng'), chosen[0]);
      await page.reload({ waitUntil: 'networkidle' });
      t.assert.deepEqual((await seam.store.filters(page)).languages, chosen);
    });

    await t.test('members load inside the file layout', async () => {
      const entity = entities.find((candidate) => candidate.methods > 0 && candidate.code > 0);
      await seam.store.apply(page, { resetFilters: true, classId: entity.id, settings: { showMembers: true }, zoom: [] });
      await seam.treemap.waitForMembers(page);
      const snapshot = await seam.treemap.snapshot(page);
      t.assert.equal(snapshot.aggregate.types, meta.counts.types, 'member leaves inflated the entity total');
      t.assert.equal(snapshot.aggregate.code, meta.counts.code, 'member leaves inflated source metrics');
      await seam.store.apply(page, { settings: { showMembers: false } });
    });

    await t.test('overview exposes analysis limits and diagnostics', async () => {
      await seam.store.apply(page, { resetFilters: true, clearSelection: true, settings: { colorMode: 'domain' } });
      await inspectorBody(page).getByRole('heading', { name: 'Analysis support', exact: true }).waitFor();
      if (meta.parseErrors?.files) t.assert.match(await inspectorBody(page).innerText(), /Syntax diagnostics/i);
    });

    await t.test('all views render on this project', async () => {
      for (const view of ['hierarchy', 'dependencies', 'subsystems', 'insights', 'treemap']) {
        await tab(page, view).click();
        await t.settle(120);
        t.assert.equal(await seam.store.view(page), view);
      }
      await controlSelect(page, 'Colour by').selectOption('language');
      await t.shot('multilingual-project');
    });
    await t.test('no console or request errors', async () => t.assert.deepEqual(t.errors, []));
  },
};
