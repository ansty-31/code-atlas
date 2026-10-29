/**
 * Treemap: painting, hover, zoom, tiling and the member level.
 *
 * Contains two regression guards carried over from the original smoke test —
 * both describe defects that were reported and fixed, so they are named tests
 * rather than anonymous checks:
 *
 *   - a double-click inside an already-zoomed view used to emit a path relative
 *     to the *current* subtree, which matched no child of the root, so the map
 *     snapped back to the root instead of zooming in;
 *   - the tiling algorithm was missing from the rebuild key, so switching it
 *     did nothing until some unrelated setting changed.
 */

import {
  controlSelect,
  crumbs,
  emptyState,
  emptyStateAction,
  emptyStateWhy,
  stageAction,
  tooltip,
} from '../locators.mjs';
import { canvasSnapshot, distinctCanvasColors } from '../probes.mjs';
import { seam } from '../seam.mjs';
import { ZOOM_ISO } from '../fixtures.mjs';

export default {
  name: 'Treemap',

  async run(t) {
    const { page } = t;

    await t.test('paints a multi-coloured map', async () => {
      const colours = await distinctCanvasColors(page);
      t.assert.ok(colours > 25, `only ${colours} distinct samples`);
      await t.shot('01-treemap');
      return `${colours} distinct samples`;
    });

    await t.test('hover reveals a tooltip with a full readout', async () => {
      await page.mouse.move(700, 500);
      await t.settle(350);
      const visible = await tooltip(page).isVisible();
      t.assert.ok(visible, 'tooltip stayed hidden');
      const text = (await tooltip(page).textContent()) ?? '';
      t.assert.ok(text.length > 20, `tooltip text too short: ${JSON.stringify(text)}`);
      return text.trim().replace(/\s+/g, ' ').slice(0, 60);
    });

    await t.test('double-click zooms into a package', async () => {
      await page.mouse.dblclick(700, 500);
      await t.settle(400);
      const count = await crumbs(page).count();
      t.assert.ok(count >= 2, `${count} breadcrumbs after zoom`);
      await t.shot('02-treemap-zoomed');
      return `${count} breadcrumbs`;
    });

    // ---------------------------------------------------------------- zoom --
    // Regression guard (1): zoom paths are absolute and re-resolved from the
    // full tree on every layout.
    await t.test('double-clicking inside a zoomed view zooms deeper', async () => {
      await page.keyboard.press('Escape');
      await t.settle(250);
      await seam.store.apply(page, { zoom: ZOOM_ISO });
      await t.settle(500);

      const deeper = await seam.treemap.findGroup(page);
      t.assert.ok(deeper, 'no group rectangle found to zoom into');
      const before = await seam.store.zoomPath(page);

      await page.mouse.dblclick(deeper.x, deeper.y);
      await t.settle(500);
      const after = await seam.store.zoomPath(page);

      const detail = `${before.join(' > ')} -> ${after.join(' > ')}`;
      t.assert.equal(after.length, before.length + 1, `depth did not grow: ${detail}`);
      t.assert.equal(after.at(-1), deeper.id, `last id is not the clicked node: ${detail}`);
      t.assert.equal(after.slice(0, before.length).join('|'), before.join('|'), `prefix changed: ${detail}`);
      return detail;
    });

    await t.test('the layout follows the zoom path to its last id', async () => {
      const zoom = await seam.store.zoomPath(page);
      const rootId = await seam.treemap.zoomRootId(page);
      t.assert.equal(rootId, zoom.at(-1), `layout root ${rootId} vs zoom ${zoom.at(-1)}`);
      return String(rootId);
    });

    // A path naming a node that is not on the way down (an old permalink, a
    // stale bookmark) must degrade to the part that does resolve.
    await t.test('an unroutable zoom id degrades to the resolvable prefix', async () => {
      await seam.store.apply(page, { zoom: ['p:zombie', 'p:does.not.exist', 'p:zombie.iso'] });
      await t.settle(500);
      const rootId = await seam.treemap.zoomRootId(page);
      t.assert.equal(rootId, 'p:zombie', `resolved to ${rootId}`);
      return rootId;
    });

    // ------------------------------------------------------------ tiling --
    await t.test('switching the tiling algorithm repaints immediately', async () => {
      await seam.store.apply(page, { zoom: [] });
      await t.settle(400);
      const before = await canvasSnapshot(page);
      await stageAction(page, 'Binary').click();
      await t.settle(550);
      const after = await canvasSnapshot(page);
      t.assert.notEqual(after, before, 'canvas was unchanged by the layout switch');
      return 'Binary ≠ Squarified';
    });

    // Regression guard (2): the tiling algorithm is part of the rebuild key.
    await t.test('every tiling algorithm renders differently', async () => {
      const signatures = new Set();
      signatures.add(await canvasSnapshot(page)); // Binary, from the test above

      for (const label of ['Slice', 'Squarified']) {
        await stageAction(page, label).click();
        await t.settle(550);
        signatures.add(await canvasSnapshot(page));
      }

      // "Strips" is only reachable from the sidebar select.
      await controlSelect(page, 'Layout').selectOption('strip');
      await t.settle(550);
      signatures.add(await canvasSnapshot(page));

      t.assert.equal(signatures.size, 4, `only ${signatures.size}/4 tilings were distinct`);
      await controlSelect(page, 'Layout').selectOption('squarify');
      await t.settle(450);
      return '4/4 distinct';
    });

    // ---------------------------------------------------- member leaves ----
    // The leaf count must grow when the member level is enabled. Filters are
    // reset and one package is zoomed into first, otherwise the filtered tree
    // may legitimately be empty.
    //
    // The zoom target matters: `ensureMembers()` loads the shard for the
    // *outermost* `p:` segment of the zoom path, so the member level only has
    // data for the package it names. Zooming to the root package is the case
    // that works end to end — see the TODO below for the one that does not.
    await t.test('enabling the member level adds leaves', async () => {
      await seam.store.apply(page, { zoom: ['p:zombie'], resetFilters: true, view: 'treemap' });
      await t.settle(900);

      const before = (await seam.treemap.snapshot(page)).leaves;
      await page.keyboard.press('m');
      await t.settle(2600);
      const after = (await seam.treemap.snapshot(page)).leaves;

      t.assert.ok(after > before, `${before} -> ${after} leaves`);
      await t.shot('12-members');
      await page.keyboard.press('m');
      await t.settle(500);
      return `${before} -> ${after} leaves`;
    });

    /**
     * Known defect, found while splitting the original smoke test apart.
     *
     * `TreemapView.ensureMembers()` picks the zoom package with
     * `zoom.find(z => z.startsWith('p:'))` — the *outermost* segment — while the
     * rectangles on screen belong to the *deepest* one. Zoomed into a nested
     * package the required member shard is therefore never fetched, and the
     * member toggle silently does nothing.
     *
     * The old smoke test passed only because an earlier phase of that one long
     * session had a search query active, which makes `ensureMembers()` take the
     * "load every shard" branch and happen to have the data. Splitting the suite
     * into independent specs removed the accident and exposed the defect.
     */
    await t.todo('the member level works when zoomed into a nested package', async () => {
      await seam.store.apply(page, { zoom: ZOOM_ISO, resetFilters: true, view: 'treemap' });
      await t.settle(900);
      const before = (await seam.treemap.snapshot(page)).leaves;
      await page.keyboard.press('m');
      await t.settle(2600);
      const after = (await seam.treemap.snapshot(page)).leaves;
      t.assert.ok(after > before, `${before} -> ${after} leaves at ${ZOOM_ISO.join(' > ')}`);
      return `${before} -> ${after} leaves`;
    });

    // An over-filtered map used to go blank with no explanation, which is
    // indistinguishable from a broken app.
    await t.test('a filter that matches nothing explains itself and offers a way back', async () => {
      await seam.store.apply(page, { zoom: [], resetFilters: true, filters: { minCode: 999999 } });
      await t.settle(900);

      await emptyState(page).waitFor({ state: 'visible', timeout: 10000 });
      const why = (await emptyStateWhy(page).textContent()) ?? '';
      t.assert.match(why, /999999/, `the card did not name the active filter: ${JSON.stringify(why)}`);

      await emptyStateAction(page, 'Clear filters').click();
      await t.settle(900);
      const snapshot = await seam.treemap.snapshot(page);
      t.assert.ok(snapshot.leaves > 100, `only ${snapshot.leaves} leaves after clearing`);
      t.assert.equal(await emptyState(page).isVisible(), false, 'the card is still showing');
      return `explained (${why.trim()}) and recovered to ${snapshot.leaves} leaves`;
    });

    await t.test('no console errors', async () => {
      t.assert.deepEqual(t.errors, [], t.errors.slice(0, 3).join(' | '));
      return 'clean';
    });
  },
};
