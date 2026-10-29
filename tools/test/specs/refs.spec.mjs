/**
 * Fine-grained references: member-to-member calls, field reads and writes.
 *
 * The layer is optional by design — a bundle built with `--no-refs` has no
 * `refs/**` at all — so this spec covers both halves: what the inspector shows
 * when the data is there (the section, its rows, the jump to a target type),
 * and that the app is unchanged when it is not. The degradation test routes the
 * artifact directory to a 404 and then asserts the ordinary panels still work,
 * which is the property that lets the layer ship without breaking anything.
 */

import {
  inspectorBody,
  inspectorTitle,
  insightCardNamed,
  memberEdgeCaret,
  memberEdgeRows,
  refsRows,
  refsSection,
} from '../locators.mjs';
import { seam } from '../seam.mjs';
import { ISO_PACKAGE, ISO_PLAYER } from '../fixtures.mjs';

export default {
  name: 'References',

  async run(t) {
    const { page } = t;

    const select = async (name) => {
      await seam.store.apply(page, { classIdByName: name });
      await inspectorTitle(page).filter({ hasText: name }).waitFor({ timeout: 10000 });
    };

    await t.test('the reference layer is in this bundle', async () => {
      const counts = await page.evaluate(() => window.zombieAtlas.atlas.meta.refCounts);
      t.assert.ok(counts, 'meta.json carries no refCounts — was the bundle built with --no-refs?');
      t.assert.ok(counts.sites > 100000, `only ${counts?.sites} sites extracted`);
      t.assert.ok(counts.resolved > 0, 'nothing resolved to a member');
      return `${counts.sites.toLocaleString()} sites · ${counts.resolved.toLocaleString()} resolved · ${counts.rows.toLocaleString()} rows`;
    });

    await t.test('the inspector lists what a type calls and what touches it', async () => {
      await select(ISO_PLAYER);
      await refsSection(page).waitFor({ timeout: 15000 });
      const rows = await refsRows(page).count();
      t.assert.ok(rows > 0, 'the references section rendered no rows');
      const text = await refsSection(page).innerText();
      // The resolution figure is tree-wide and says so; it is not this type's
      // score, which is what the old "37% resolved" badge implied.
      t.assert.match(
        text,
        /\d[\d,]* \/ \d[\d,]* sites resolved, tree-wide/i,
        `no tree-wide resolution figure in: ${text.slice(0, 120)}`
      );
      const counts = await page.evaluate(() => window.zombieAtlas.atlas.meta.refCounts);
      if (counts.unresolved > 0) {
        t.assert.match(text, /counted, never guessed/i, 'the panel does not explain what the unresolved sites are');
      }
      return `${rows} reference rows`;
    });

    await t.test('a reference row jumps to the type it points at', async () => {
      await select(ISO_PLAYER);
      await refsSection(page).waitFor({ timeout: 15000 });
      const row = refsRows(page).first();
      const targetId = await row.getAttribute('data-id');
      await row.click();
      await page.waitForTimeout(150);
      const selected = await page.evaluate(() => window.zombieAtlas.store.state.selection.classId);
      t.assert.equal(String(selected), String(targetId), 'clicking a row selected a different type');
      return `selected class ${selected}`;
    });

    await t.test('the inspector shows what a member stores, returns and registers', async () => {
      await select('IsoObject');
      await refsSection(page).waitFor({ timeout: 15000 });
      // The flow block is derived from the same shard: a setter that stores its
      // parameter into a field, a getter that returns one, and a member handing
      // itself to another as a callback.
      const flow = await page.locator('#inspector-body [data-refs="section"]').innerText();
      t.assert.match(flow, /data flow/i, `no data-flow block in: ${flow.slice(0, 160)}`);
      t.assert.match(flow, /(stores parameter \d+ into |returns |registers )/i, 'the flow block has no entries');
      return flow.split('\n').filter((l) => /stores|returns|registers/i.test(l))[0]?.slice(0, 80) ?? 'flow listed';
    });

    await t.test('the insight cards report the reference layer', async () => {
      await seam.store.apply(page, { view: 'insights' });
      const pane = page.locator('#insights-pane');
      await pane.waitFor({ timeout: 15000 });
      const titles = ['Most-called methods', 'Most-written fields', 'Deepest call chains', 'Reference coverage'];
      const found = [];
      for (const title of titles) {
        if ((await insightCardNamed(page, title).count()) > 0) found.push(title);
      }
      t.assert.deepEqual(found.length, titles.length, `only these cards rendered: ${found.join(', ')}`);
      // A ranking row names the member, not just its class.
      const first = await insightCardNamed(page, 'Most-called methods').locator('.rank-row').first().innerText();
      t.assert.match(first, /\w+\.\w+/, `ranking row shows no member name: ${first.slice(0, 60)}`);
      const chain = await insightCardNamed(page, 'Deepest call chains').locator('.rank-row').first().innerText();
      t.assert.match(chain, /→/, `a chain row has no steps: ${chain.slice(0, 60)}`);
      return `${found.length} cards · ${first.replace(/\s+/g, ' ').trim().slice(0, 40)}`;
    });

    await t.test('a class pair expands into member-level edges', async () => {
      await seam.store.apply(page, { view: 'dependencies', depMode: 'classes', packagePath: ISO_PACKAGE });
      const caret = memberEdgeCaret(page).first();
      await caret.waitFor({ timeout: 15000 });
      const pairs = await memberEdgeCaret(page).count();
      await caret.click();
      await memberEdgeRows(page).first().waitFor({ timeout: 15000 });
      const rows = await memberEdgeRows(page).count();
      const sample = await memberEdgeRows(page).first().innerText();
      t.assert.ok(rows > 0, 'expanding a class pair listed no member edges');
      t.assert.match(sample, /×\d+/, `a member edge shows no count: ${sample.slice(0, 60)}`);
      return `${pairs} pairs · first expansion: ${rows} member edges`;
    });

    await t.test('without the artifact the app is unchanged', async () => {
      // A bundle built with --no-refs has no refs/**; the app must simply not
      // render the section, and everything else must keep working.
      const context = await page.context().browser().newContext();
      try {
        const blocked = await context.newPage();
        const errors = [];
        blocked.on('console', (m) => {
          if (m.type() === 'error') errors.push(m.text());
        });
        await blocked.route('**/data/refs/**', (route) => route.fulfill({ status: 404, body: 'not found' }));
        // Navigate without the hash: earlier tests in this spec navigate the
        // shared page (view, package selection), and a permalink would apply
        // that state here and race the selection this test makes.
        await blocked.goto(page.url().split('#')[0], { waitUntil: 'domcontentloaded' });
        await blocked.waitForFunction(() => !!window.zombieAtlas?.atlas, null, { timeout: 20000 });
        await blocked.evaluate(() =>
          window.zombieAtlas.store.update((s) => {
            s.selection.packagePath = null;
            s.selection.classId = window.zombieAtlas.atlas.classes.find((c) => c.name === 'IsoPlayer')?.id ?? 0;
          })
        );
        const title = await blocked
          .locator('#inspector-body .insp-title h1')
          .filter({ hasText: 'IsoPlayer' })
          .innerText({ timeout: 10000 });
        t.assert.match(title, /IsoPlayer/, `panel showed ${title}`);
        t.assert.equal(await blocked.locator('#inspector-body [data-refs="section"]').count(), 0, 'the references section rendered without its artifact');
        const refsErrors = errors.filter((e) => !/404|Failed to load resource/i.test(e));
        t.assert.deepEqual(refsErrors, [], refsErrors.slice(0, 2).join(' | '));
        return 'section omitted, panel intact';
      } finally {
        await context.close();
      }
    });

    t.assert.deepEqual(t.errors, [], t.errors.slice(0, 3).join(' | '));
  },
};
