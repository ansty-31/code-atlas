/**
 * Hierarchy: the inheritance forest.
 *
 * Left: every type with no internal supertype, ranked by subtree size (the
 * list is capped at 400 rows). Right: an expandable tree of one chosen root,
 * with the selected type revealed automatically, implemented interfaces shown
 * as dashed children, and a roots filter.
 *
 * Ported from the original smoke test. Those two checks only saw a
 * populated tree because an earlier phase of that one long session had already
 * selected a class from the search box; on a fresh page the tree pane says
 * "Pick a root" until a root is clicked or a type is selected. The port keeps
 * both assertions (`> 5` tree rows, `> 10` root links) and makes that
 * precondition explicit instead of accidental.
 */

import {
  hierarchyCaret,
  hierarchyCheckbox,
  hierarchyFilter,
  hierarchyInterfaceRows,
  hierarchyLinks,
  hierarchyRootLink,
  hierarchyRootName,
  hierarchyRootsTitle,
  hierarchyRows,
  hierarchyRow,
  hierarchyRowName,
  hierarchyTreeTitle,
  statusbar,
  tab,
} from '../locators.mjs';
import { seam } from '../seam.mjs';
import { ISO_PLAYER } from '../fixtures.mjs';

/** `Hierarchy roots (3221)` → 3221. */
const countIn = (text) => Number((text.match(/[\d,]+/)?.[0] ?? '0').replace(/,/g, ''));

/** Computed paint of an element, used to compare a marked row with an ordinary one. */
const paint = (locator, prop) => locator.evaluate((el, p) => getComputedStyle(el)[p], prop);

export default {
  name: 'Hierarchy',

  async run(t) {
    const { page } = t;

    // The pane is created on first render and removed on teardown, so every
    // locator below is only meaningful after this click.
    await t.test('the Hierarchy tab lists the roots of the forest', async () => {
      await tab(page, 'hierarchy').click();
      await t.settle(700);

      const listed = await hierarchyLinks(page).count();
      t.assert.ok(listed > 10, `only ${listed} roots listed`);

      const total = countIn((await hierarchyRootsTitle(page).textContent()) ?? '');
      t.assert.ok(total > listed, `title reports ${total} roots for ${listed} rows`);
      return `${listed} of ${total} roots listed`;
    });

    await t.test('the tree waits for a root or a selected type', async () => {
      const rows = await hierarchyRows(page).count();
      t.assert.equal(rows, 0, `tree rendered ${rows} rows before anything was chosen`);
      return 'nothing expanded yet';
    });

    await t.test('selecting a type elsewhere reveals it in the tree', async () => {
      await seam.store.apply(page, { classIdByName: ISO_PLAYER, view: 'hierarchy' });
      await t.settle(800);

      const rows = await hierarchyRows(page).count();
      t.assert.ok(rows > 5, `only ${rows} tree rows`);

      const revealed = hierarchyRow(page, ISO_PLAYER);
      t.assert.equal(await revealed.count(), 1, `${ISO_PLAYER} was not revealed`);

      const title = (await hierarchyTreeTitle(page).textContent()) ?? '';
      t.assert.match(title, /Inheritance tree/, `tree title was ${JSON.stringify(title)}`);

      // The revealed type is the selection: its name is painted with the accent
      // colour and a heavier weight than an ordinary row.
      const rootRow = hierarchyRows(page).first();
      const rootName = (await hierarchyRowName(rootRow).textContent()) ?? '';
      t.assert.notEqual(rootName, ISO_PLAYER, 'the tree root is the selected type');
      t.assert.notEqual(
        await paint(hierarchyRowName(revealed.first()), 'color'),
        await paint(hierarchyRowName(rootRow), 'color'),
        'the selected row is not highlighted'
      );
      t.assert.equal(await paint(hierarchyRowName(revealed.first()), 'fontWeight'), '600', 'selected row weight');

      // Revealing also marks the hierarchy root in the left list.
      const rootBg = await paint(hierarchyRootLink(page, rootName).first(), 'backgroundColor');
      t.assert.notEqual(rootBg, 'rgba(0, 0, 0, 0)', `${rootName} is not marked in the roots list`);

      await t.shot('05-hierarchy');
      return `${ISO_PLAYER} revealed under ${rootName} · ${rows} rows`;
    });

    // Runs on the tree the test above revealed (75 rows, 22 interface edges).
    await t.test('the interfaces checkbox toggles the dashed interface rows', async () => {
      const box = hierarchyCheckbox(page, 'interfaces');
      t.assert.ok(await box.isChecked(), 'interfaces started off');
      const dashed = await hierarchyInterfaceRows(page).count();
      t.assert.ok(dashed > 0, 'no interface rows on screen to toggle');

      const withRows = await hierarchyRows(page).count();
      await box.click();
      await t.settle(500);
      const off = await hierarchyInterfaceRows(page).count();
      const withoutRows = await hierarchyRows(page).count();
      await box.click();
      await t.settle(500);
      const back = await hierarchyInterfaceRows(page).count();

      t.assert.equal(off, 0, `${off} dashed rows survived the toggle`);
      t.assert.ok(withoutRows < withRows, `${withRows} rows with interfaces, ${withoutRows} without`);
      t.assert.equal(back, dashed, `only ${back} of ${dashed} dashed rows came back`);
      return `${withRows} rows with, ${withoutRows} without (${dashed} dashed)`;
    });

    await t.test('the caret collapses and expands a node', async () => {
      const caret = hierarchyCaret(hierarchyRows(page).first());
      t.assert.equal(await caret.textContent(), '▾', 'the root row is not expanded');
      const open = await hierarchyRows(page).count();

      await caret.click();
      await t.settle(500);
      const closed = await hierarchyRows(page).count();
      t.assert.equal(closed, 1, `collapsing the root left ${closed} rows`);

      await caret.click();
      await t.settle(500);
      const reopened = await hierarchyRows(page).count();
      t.assert.equal(reopened, open, `re-expanding gave ${reopened} of ${open} rows`);
      return `${open} rows → 1 → ${reopened}`;
    });

    // Runs while the 75-row GameEntity tree from the reveal is still on screen,
    // so the filter's effect on both the roots list and the tree is measured.
    await t.test('lua only narrows the roots once a filter is typed', async () => {
      const box = hierarchyCheckbox(page, 'lua only');
      await hierarchyFilter(page).fill('Iso');
      await t.settle(500);
      const filtered = await hierarchyLinks(page).count();

      await box.click();
      await t.settle(500);
      const narrowed = await hierarchyLinks(page).count();

      // Restore the filter before asserting, so a failure cannot leak into the
      // tests that follow.
      await box.click();
      await hierarchyFilter(page).fill('');
      await t.settle(500);

      t.assert.ok(narrowed < filtered, `lua only changed nothing: ${filtered} → ${narrowed} roots`);
      return `“Iso”: ${filtered} → ${narrowed} roots`;
    });

    /**
     * Known defect, found while porting.
     *
     * `matches()` (src/views/hierarchy.ts:113) honours `useLuaFilter` before it
     * looks at `filterText`, but both of its call sites guard the whole
     * predicate with `!filterText ||` — the roots list (line 167) and the tree
     * rows (line 213). With an empty filter box the checkbox is therefore never
     * consulted: `roots().filter((c) => !filterText || hasMatchInSubtree(c))`
     * short-circuits to `true`.
     *
     * Evidence: 400 listed roots and 75 tree rows before and after ticking
     * "lua only" with an empty box; typing "Iso" first makes the same toggle go
     * 400 → 137 roots. The checkbox looks broken to a user who has not typed
     * anything.
     */
    await t.todo('lua only filters the roots on its own', async () => {
      const box = hierarchyCheckbox(page, 'lua only');
      const before = await hierarchyLinks(page).count();
      const rowsBefore = await hierarchyRows(page).count();

      await box.click();
      await t.settle(500);
      const after = await hierarchyLinks(page).count();
      const rowsAfter = await hierarchyRows(page).count();
      await box.click();
      await t.settle(400);

      t.assert.ok(after < before, `${before} roots and ${rowsBefore} rows stayed ${after}/${rowsAfter} with lua only`);
      return `${before} → ${after} roots`;
    });

    await t.test('the roots filter types at the caret, not at the start', async () => {
      await hierarchyFilter(page).fill('');
      await t.settle(400);

      // The pane is rebuilt on every keystroke (the tree follows the filter
      // too), so the caret has to survive the repaint — it used to land back at
      // position 0 and reverse whatever was typed.
      await hierarchyFilter(page).click();
      await hierarchyFilter(page).pressSequentially('Iso', { delay: 40 });
      await t.settle(500);
      t.assert.equal(await hierarchyFilter(page).inputValue(), 'Iso', 'typing into the roots filter reversed the query');

      await hierarchyFilter(page).fill('');
      await t.settle(400);
      return '"Iso" in order';
    });

    await t.test('choosing a root in the left list renders that hierarchy', async () => {
      const link = hierarchyLinks(page).first();
      const name = ((await hierarchyRootName(link).textContent()) ?? '').trim();
      t.assert.ok(name.length > 0, 'the first root has no name');

      await link.click();
      await t.settle(700);

      const title = (await hierarchyTreeTitle(page).textContent()) ?? '';
      t.assert.ok(title.includes(name), `tree title ${JSON.stringify(title)} does not name ${name}`);

      const rows = await hierarchyRows(page).count();
      t.assert.ok(rows > 1, `${name} rendered ${rows} rows`);
      const firstRow = (await hierarchyRowName(hierarchyRows(page).first()).textContent()) ?? '';
      t.assert.equal(firstRow, name, `the tree starts at ${firstRow}`);

      // The chosen root is the one marked in the left list — and only that one.
      t.assert.notEqual(await paint(link, 'backgroundColor'), 'rgba(0, 0, 0, 0)', 'chosen root is not marked');
      t.assert.equal(
        await paint(hierarchyLinks(page).nth(1), 'backgroundColor'),
        'rgba(0, 0, 0, 0)',
        'a second root is marked as well'
      );
      return `${name}: ${rows} rows`;
    });

    await t.test('the status bar reports the hierarchy summary while this view is active', async () => {
      const text = (await statusbar(page).textContent()) ?? '';
      const summary = text.match(/([\d,]+) roots · ([\d,]+) implements edges/);
      t.assert.ok(summary, `status bar was ${JSON.stringify(text.slice(0, 90))}`);

      await tab(page, 'treemap').click();
      await t.settle(500);
      const other = (await statusbar(page).textContent()) ?? '';
      t.assert.ok(!/implements edges/.test(other), 'the summary survived the view switch');
      return summary[0];
    });

    await t.test('no console errors', async () => {
      t.assert.deepEqual(t.errors, [], t.errors.slice(0, 3).join(' | '));
      return 'clean';
    });
  },
};
