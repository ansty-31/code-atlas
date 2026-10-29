/**
 * Subsystems: the functional-domain overview.
 *
 * One card per top-level package, ranked by the chosen metric, above a stacked
 * bar of every domain's share of the code. Cards are also entry points: clicking
 * one filters the whole atlas to that domain and drops the reader into the
 * treemap.
 *
 * Ported from the original smoke test (`> 20` domain cards, the
 * screenshot, and "one active chip + a reduced type count" after clicking a
 * card), plus the proportional bar and the sort buttons the view offers.
 */

import {
  activeChips,
  domainBarSegments,
  domainCardTitle,
  domainCards,
  domainCardTitles,
  domainLegendItems,
  domainOverviewBar,
  domainOverviewTitle,
  domainSortButton,
  statusbar,
  tab,
} from '../locators.mjs';
import { seam } from '../seam.mjs';

/** `112 / 4,749 types shown` → [112, 4749]. */
const typeCounts = (text) =>
  (text.match(/([\d,]+)\s*\/\s*([\d,]+)/) ?? []).slice(1).map((v) => Number(v.replace(/,/g, '')));

/**
 * A legend share and how far it may honestly sit from the segment width.
 *
 * `pct()` (src/util.ts:26) prints whole percents at 10% and above, one decimal
 * below, so a printed share carries half of its last digit of rounding error.
 */
const legendShare = (text) => {
  const m = text.match(/(\d+(?:\.(\d+))?)%/);
  const decimals = m?.[2]?.length ?? 0;
  return { value: Number(m?.[1] ?? NaN), tolerance: 0.5 * 10 ** -decimals + 0.1 };
};

export default {
  name: 'Subsystems',

  async run(t) {
    const { page } = t;

    await t.test('the Subsystems tab renders a card per functional domain', async () => {
      await tab(page, 'subsystems').click();
      await t.settle(900);

      const cards = await domainCards(page).count();
      t.assert.ok(cards > 20, `only ${cards} domain cards`);
      await t.shot('08-subsystems');
      return `${cards} domain cards`;
    });

    await t.test('the overview bar is proportional and its legend agrees', async () => {
      const title = (await domainOverviewTitle(page).textContent()) ?? '';
      const domains = Number((title.match(/[\d,]+/)?.[0] ?? '0').replace(/,/g, ''));
      t.assert.ok(domains > 20, `overview reports ${domains} domains`);

      const segments = await domainBarSegments(page).count();
      const legend = await domainLegendItems(page).count();
      t.assert.equal(segments, domains, `${segments} bar segments for ${domains} domains`);
      t.assert.equal(legend, domains, `${legend} legend entries for ${domains} domains`);

      const barWidth = await domainOverviewBar(page).evaluate((el) => el.clientWidth);
      const widths = await domainBarSegments(page).evaluateAll((els) =>
        els.map((el) => el.getBoundingClientRect().width)
      );
      const filled = widths.reduce((a, b) => a + b, 0);
      t.assert.ok(Math.abs(filled - barWidth) <= 2, `segments fill ${filled.toFixed(1)}px of ${barWidth}px`);

      // Each legend entry states the same share its bar segment occupies.
      const shares = (await domainLegendItems(page).allTextContents()).map(legendShare);
      t.assert.ok(shares.every((s) => Number.isFinite(s.value)), 'a legend entry is not a percentage');
      t.assert.ok(
        Math.abs(shares.reduce((a, b) => a + b.value, 0) - 100) <= 3,
        `shares add up to ${shares.reduce((a, b) => a + b.value, 0).toFixed(2)}%`
      );

      let worst = { over: -Infinity, share: 0, exact: 0 };
      shares.forEach((s, i) => {
        const exact = (widths[i] / filled) * 100;
        const over = Math.abs(s.value - exact) - s.tolerance;
        if (over > worst.over) worst = { over, share: s.value, exact };
      });
      t.assert.ok(
        worst.over <= 0,
        `legend says ${worst.share}% where the segment fills ${worst.exact.toFixed(2)}%`
      );
      return `${domains} segments · ${filled.toFixed(1)}px of ${barWidth}px · shares match`;
    });

    await t.test('the sort buttons reorder the cards', async () => {
      const bySize = (await domainCardTitle(page, 0).textContent()) ?? '';

      await domainSortButton(page, 'name').click();
      await t.settle(500);
      const names = await domainCardTitles(page).allTextContents();
      const firstByName = (await domainCardTitle(page, 0).textContent()) ?? '';
      t.assert.notEqual(firstByName, bySize, `the first card stayed ${bySize}`);
      t.assert.deepEqual(
        names,
        [...names].sort((a, b) => a.localeCompare(b)),
        `not alphabetical: ${names.slice(0, 5).join(', ')}`
      );

      await domainSortButton(page, 'code').click();
      await t.settle(500);
      const restored = (await domainCardTitle(page, 0).textContent()) ?? '';
      t.assert.equal(restored, bySize, `restoring the size sort gave ${restored}`);
      return `${bySize} → ${firstByName} → ${restored}`;
    });

    await t.test('clicking a domain card filters the atlas to that domain', async () => {
      const unfiltered = typeCounts((await statusbar(page).textContent()) ?? '');
      t.assert.equal(unfiltered.length, 2, 'status bar does not report a type count');
      t.assert.equal(unfiltered[0], unfiltered[1], `${unfiltered[0]} of ${unfiltered[1]} types are shown unfiltered`);

      const name = (await domainCardTitle(page, 0).textContent()) ?? '';
      await domainCards(page).first().click();
      await t.settle(900);

      const chips = await activeChips(page).count();
      t.assert.equal(chips, 1, `${chips} active chips after filtering`);
      const chip = (await activeChips(page).first().textContent()) ?? '';
      t.assert.ok(chip.includes(name), `the active chip is ${JSON.stringify(chip)}, not ${JSON.stringify(name)}`);

      const filtered = typeCounts((await statusbar(page).textContent()) ?? '');
      t.assert.equal(filtered.length, 2, 'status bar lost its type count');
      t.assert.ok(filtered[0] < unfiltered[1], `${filtered[0]} of ${unfiltered[1]} types shown for ${name}`);

      t.assert.equal(await seam.store.view(page), 'treemap', 'the card did not open the treemap');
      return `${name}: ${filtered[0]} / ${filtered[1]} types`;
    });

    await t.test('no console errors', async () => {
      t.assert.deepEqual(t.errors, [], t.errors.slice(0, 3).join(' | '));
      return 'clean';
    });
  },
};
