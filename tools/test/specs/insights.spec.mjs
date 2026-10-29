/**
 * Insights: the ranking cards computed at extraction time.
 *
 * Largest and most complex types, hubs, the Lua surface, histograms and the
 * package-coupling table. The two interactions that matter are the metric
 * button on the "most complex methods" card, which reorders that list, and
 * clicking a row, which selects the type (or opens the Dependencies view, for
 * the coupling table).
 *
 * Ported from the original smoke test (>= 8 cards, > 30 ranking rows,
 * screenshot 09-insights) plus the interactions the view offers.
 */

import {
  cardRankRows,
  couplingRows,
  insightCard,
  insightCards,
  insightSortButton,
  inspectorBody,
  inspectorTitle,
  rankRowName,
  rankRowValue,
  rankRows,
  statusbar,
  tab,
} from '../locators.mjs';
import { litCanvasSamples } from '../probes.mjs';
import { seam } from '../seam.mjs';

/** `Class.method | cx 457` → `Class.method|cx 457`, one per row. */
const ranking = (rows) =>
  rows.evaluateAll((els) => els.map((el) => el.textContent.replace(/\s+/g, ' ').trim()));

const text = async (locator) => ((await locator.textContent()) ?? '').trim();

export default {
  name: 'Insights',

  async run(t) {
    const { page } = t;

    await t.test('the Insights tab renders the rankings', async () => {
      await tab(page, 'insights').click();
      await t.settle(1000);

      const cards = await insightCards(page).count();
      const rows = await rankRows(page).count();
      t.assert.ok(cards >= 8, `only ${cards} cards`);
      t.assert.ok(rows > 30, `only ${rows} ranking rows`);

      await t.shot('09-insights');
      return `${cards} cards · ${rows} ranking rows`;
    });

    await t.test('the metric buttons reorder the most-complex-methods ranking', async () => {
      const rows = cardRankRows(insightCard(page, 0));
      const first = rows.first();
      const byComplexity = await ranking(rows);
      const topByComplexity = await text(rankRowName(first));
      const cxValue = await text(rankRowValue(first));

      await insightSortButton(page, 'lines').click();
      await t.settle(500);
      const byLines = await ranking(rows);
      const topByLines = await text(rankRowName(first));
      const lineValue = await text(rankRowValue(first));

      await insightSortButton(page, 'complexity').click();
      await t.settle(500);
      const restored = await ranking(rows);

      t.assert.notEqual(lineValue, cxValue, `the first row still reads ${lineValue}`);
      t.assert.notEqual(topByLines, topByComplexity, `the top method stayed ${topByLines}`);
      t.assert.match(lineValue, / ln$/, `the lines metric prints ${JSON.stringify(lineValue)}`);
      t.assert.notDeepEqual(byLines, byComplexity, 'the ranking did not change');
      t.assert.deepEqual(restored, byComplexity, 'switching back did not restore the ranking');
      return `${topByComplexity} ${cxValue} → ${topByLines} ${lineValue}`;
    });

    /**
     * Known defect, found while porting.
     *
     * The `branch` button is indistinguishable from `complexity`: the dataset's
     * complexity is *defined* as branch points + 1 (the card's own subtitle,
     * src/views/insights.ts:85), so `y.branch - x.branch` (line 91) orders the
     * list exactly as `y.complexity - x.complexity` does, and the value column
     * prints `cx {complexity}` for both (line 96). Switching the metric changes
     * nothing on screen.
     *
     * Evidence: all 14 rows — names and values — are identical under the two
     * metrics (`Item.DoParam cx 457` first in both), while the `lines` metric
     * produces a genuinely different ranking.
     */
    await t.todo('the branch metric ranks differently from complexity', async () => {
      const rows = cardRankRows(insightCard(page, 0));
      const first = rows.first();

      await insightSortButton(page, 'complexity').click();
      await t.settle(500);
      const byComplexity = await ranking(rows);

      await insightSortButton(page, 'branch').click();
      await t.settle(500);
      const byBranch = await ranking(rows);
      const branchTop = await text(rankRowName(first));
      const branchValue = await text(rankRowValue(first));

      await insightSortButton(page, 'complexity').click();
      await t.settle(500);

      t.assert.notDeepEqual(byBranch, byComplexity, `both metrics rank ${branchTop} first (${branchValue})`);
      return `${byBranch.length} rows compared`;
    });

    await t.test('clicking a ranking row selects that type in the inspector', async () => {
      const overview = (await inspectorBody(page).textContent()) ?? '';
      t.assert.match(overview, /Project overview/, 'the inspector was not on the overview');

      const row = cardRankRows(insightCard(page, 1)).first();
      const label = (await text(rankRowName(row))).split('.').pop() ?? '';
      await row.click();
      await t.settle(800);

      const title = await text(inspectorTitle(page));
      t.assert.equal(title, label, `the inspector shows ${JSON.stringify(title)} for ${JSON.stringify(label)}`);
      const selected = (await inspectorBody(page).textContent()) ?? '';
      t.assert.ok(!/Project overview/.test(selected), 'the inspector still shows the overview');
      t.assert.ok((await seam.store.selection(page)).classId != null, 'nothing was selected');
      return `${label} in the inspector`;
    });

    await t.test('the coupling table opens the Dependencies view', async () => {
      const rows = await couplingRows(page).count();
      t.assert.ok(rows > 3, `only ${rows} coupling rows`);

      const row = couplingRows(page).first();
      const from = ((await text(row)).match(/^[^\s→]+/) ?? [''])[0];
      await row.click();
      await t.settle(2400);

      t.assert.equal(await seam.store.view(page), 'dependencies', 'the view did not switch');
      t.assert.equal(
        (await seam.store.selection(page)).packagePath,
        from,
        `the row names ${from} but a different package was selected`
      );

      // The view is now the force-directed graph: the canvas paints it and the
      // status bar gains the package-edge line.
      const status = (await statusbar(page).textContent()) ?? '';
      const edges = status.match(/([\d,]+) package edges · ([\d,]+) class refs/);
      t.assert.ok(edges, `status bar was ${JSON.stringify(status.slice(0, 100))}`);
      const lit = await litCanvasSamples(page);
      t.assert.ok(lit > 100, `the graph painted ${lit} lit samples`);
      return `${rows} coupling rows · ${from} · ${edges[0]} · ${lit} lit`;
    });

    await t.test('no console errors', async () => {
      t.assert.deepEqual(t.errors, [], t.errors.slice(0, 3).join(' | '));
      return 'clean';
    });
  },
};
