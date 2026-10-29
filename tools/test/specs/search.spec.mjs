/**
 * Search: the top-bar query box, its result list and its keyboard handling.
 *
 * The first three tests are the `--- selection ---` block of the old linear
 * smoke script (`/` focuses the box, hits appear, a hit drives the inspector).
 * The rest cover `bindSearch()` in `src/main.ts`, which that script never
 * exercised.
 *
 * The arrow-key test asserts node identity, not only the highlight: the
 * highlight is moved by `setActive()`, which exists because rebuilding the rows
 * detaches the row under the cursor and re-fires `mouseenter` forever.
 */

import {
  activeSearchItem,
  inspectorBody,
  inspectorTitle,
  memberFilter,
  searchBox,
  searchEmpty,
  searchItems,
  searchResults,
  statusbar,
} from '../locators.mjs';
import { seam } from '../seam.mjs';
import { ISO_PLAYER } from '../fixtures.mjs';

export default {
  name: 'Search',

  async run(t) {
    const { page } = t;
    const oneLine = (text) => text.replace(/\s+/g, ' ').trim();

    /** Type a query through the UI and let the result list paint. */
    const query = async (text) => {
      await searchBox(page).fill(text);
      await t.settle(250);
    };

    /** Text of the highlighted row, or `<none>` so a lost highlight fails fast. */
    const activeRow = async () =>
      (await activeSearchItem(page).count()) === 0 ? '<none>' : oneLine(await activeSearchItem(page).innerText());

    await t.test('/ focuses the search box', async () => {
      await page.keyboard.press('/');
      const focused = await searchBox(page).evaluate((el) => el === document.activeElement);
      t.assert.ok(focused, 'the search box did not take focus');
      return 'search ready';
    });

    await t.test('typing a type name returns ranked hits', async () => {
      await query(ISO_PLAYER);
      const hits = await searchItems(page).count();
      t.assert.ok(hits > 0, `no hits for ${ISO_PLAYER}`);
      const top = oneLine(await searchItems(page).first().innerText());
      t.assert.ok(top.includes(ISO_PLAYER), `top hit was ${JSON.stringify(top)}`);
      return `${hits} hits · ${top.slice(0, 48)}`;
    });

    await t.test('choosing a hit shows the type in the inspector', async () => {
      await searchItems(page).first().click();
      // Members come from a separate shard; the filter input only appears once
      // that shard has been fetched and rendered.
      await memberFilter(page).waitFor({ timeout: 15000 });
      t.assert.equal(oneLine(await inspectorTitle(page).innerText()), ISO_PLAYER, 'the inspector titled the wrong type');

      // Section headings are uppercased by CSS, so match the rendered text
      // case-insensitively.
      const panel = await inspectorBody(page).innerText();
      t.assert.match(panel, /hierarchy/i, 'the panel shows no hierarchy section');
      t.assert.match(panel, /methods/i, 'the panel shows no members section');
      t.assert.ok(!(await searchResults(page).isVisible()), 'the result list stayed open over the inspector');
      await t.shot('03-selection');
      return `${ISO_PLAYER} · hierarchy · members`;
    });

    await t.test('the arrow keys move the highlight without rebuilding the rows', async () => {
      // Park the pointer clear of the result panel: a cursor sitting where a
      // row appears would move the highlight by hover before the keys do.
      await page.mouse.move(90, 940);
      await page.keyboard.press('/');
      await query('Iso');

      const rows = searchItems(page);
      const total = await rows.count();
      t.assert.ok(total >= 3, `only ${total} rows for "Iso"`);
      const first = oneLine(await rows.first().innerText());
      t.assert.equal(await activeRow(), first, 'the first row did not start highlighted');

      const firstRow = await rows.first().elementHandle();
      await page.keyboard.press('ArrowDown');
      await t.settle(150);
      t.assert.ok(await firstRow.evaluate((el) => el.isConnected), 'moving the highlight rebuilt the row list');
      t.assert.equal(await activeSearchItem(page).count(), 1, 'the highlight is not on exactly one row');
      t.assert.equal(await activeRow(), oneLine(await rows.nth(1).innerText()), 'ArrowDown did not move to the second row');

      await page.keyboard.press('ArrowUp');
      await t.settle(150);
      t.assert.equal(await activeRow(), first, 'ArrowUp did not return to the first row');

      // The highlight clamps at the ends instead of running off the list.
      for (let i = 0; i < total + 2; i++) await page.keyboard.press('ArrowDown');
      await t.settle(200);
      t.assert.equal(await activeSearchItem(page).count(), 1, 'the end of the list left no row highlighted');
      t.assert.equal(await activeRow(), oneLine(await rows.last().innerText()), 'ArrowDown did not stop at the last row');
      return `${total} rows · highlight 1 → 2 → 1 → ${total}`;
    });

    await t.test('Escape clears the query and closes the results', async () => {
      await query('Iso');
      const hits = await searchItems(page).count();
      t.assert.ok(hits > 0, 'the results did not open');

      await page.keyboard.press('Escape');
      await t.settle(250);
      t.assert.equal(await searchBox(page).inputValue(), '', 'the query stayed in the box');
      t.assert.ok(!(await searchResults(page).isVisible()), 'the results panel stayed open');
      t.assert.equal((await seam.store.filters(page)).query, '', 'the treemap filter was not cleared');

      // ...and the box is still usable afterwards.
      await query('Iso');
      t.assert.ok(await searchResults(page).isVisible(), 'typing after Escape did not reopen the results');
      await page.keyboard.press('Escape');
      await t.settle(250);
      return `${hits} hits cleared`;
    });

    await t.test('a query with no matches explains itself', async () => {
      await query('zzz-no-such-type-zzz');
      t.assert.equal(await searchItems(page).count(), 0, 'a nonsense query produced hits');
      t.assert.equal(await searchEmpty(page).count(), 1, 'no empty-state row was rendered');
      t.assert.match(oneLine(await searchEmpty(page).innerText()), /No matches/, 'the empty row does not explain the miss');

      await page.keyboard.press('Escape');
      await t.settle(200);
      return '"No matches"';
    });

    await t.test('clicking outside closes the results', async () => {
      await query('Iso');
      t.assert.ok(await searchResults(page).isVisible(), 'the results panel did not open');

      await statusbar(page).click();
      await t.settle(250);
      t.assert.ok(!(await searchResults(page).isVisible()), 'the results panel survived a click outside it');

      // Leave the app unfiltered for whatever runs next.
      await searchBox(page).fill('');
      await t.settle(200);
      t.assert.equal((await seam.store.filters(page)).query, '', 'clearing the box left the filter applied');
      return 'closed';
    });

    await t.test('no console errors', async () => {
      t.assert.deepEqual(t.errors, [], t.errors.slice(0, 3).join(' | '));
      return 'clean';
    });
  },
};
