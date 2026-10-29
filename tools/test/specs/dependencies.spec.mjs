/**
 * Dependencies: the force graph, its three sub-modes, the adjacency matrix and
 * the gestures that drive the graph.
 *
 * Five behaviours here are regression guards — each was reported as a defect,
 * fixed, and is the reason these are named tests rather than anonymous checks:
 *
 *   - the sub-mode buttons did not switch anything: `setDepMode()` only wrote a
 *     module-local variable, so the pane changed while the stage toolbar kept
 *     the previous button active;
 *   - panning was undone by the store update that follows the gesture, because
 *     every update rebuilt the graph and a rebuild re-fits the view;
 *   - a drag lost the zoom: panning must move the view without scaling it;
 *   - a plain click pinned and nudged the node it pressed on, because a press
 *     was treated as a drag before the pointer had travelled;
 *   - the treemap shares this canvas *and* this tooltip, and its handlers stayed
 *     live outside the treemap view: dragging the graph hit-tested stale
 *     treemap rectangles and popped a class tooltip under the cursor.
 *
 * The force layout settles far more slowly than the treemap, so the first
 * measurement waits over two seconds before it reads the canvas.
 */

import {
  activeStageAction,
  depsLinkRows,
  inspectorBody,
  matrixCells,
  matrixFilledCells,
  pane,
  stageAction,
  tab,
  tooltip,
} from '../locators.mjs';
import { canvasBox, litCanvasSamples } from '../probes.mjs';
import { seam } from '../seam.mjs';

/** The shared tooltip's state, in the shape the old linear script read it. */
async function tipState(page) {
  const tip = tooltip(page);
  if (await tip.isHidden()) return { hidden: true, text: '' };
  return { hidden: false, text: ((await tip.textContent()) ?? '').trim().replace(/\s+/g, ' ') };
}

export default {
  name: 'Dependencies',

  async run(t) {
    const { page } = t;

    /**
     * Press on empty canvas and drag by (dx, dy) *page* pixels, the way the old
     * script did it inline: press, travel in steps so the drag threshold is
     * crossed, release. The tooltip is read while the button is still down.
     *
     * Returns the view transform before, during and after the gesture — the
     * mid-gesture snapshot is what tells a pan from a node drag.
     */
    const dragEmptyCanvas = async (dx, dy) => {
      const box = await canvasBox(page);
      const spot = await seam.graph.findEmptyPoint(page);
      t.assert.ok(spot, 'no empty canvas point found to drag from');
      const before = await seam.graph.snapshot(page);
      await page.mouse.move(box.left + spot.x, box.top + spot.y);
      await page.mouse.down();
      await page.mouse.move(box.left + spot.x + dx, box.top + spot.y + dy, { steps: 12 });
      const mid = await seam.graph.snapshot(page);
      const tip = await tipState(page);
      await page.mouse.up();
      await t.settle(350);
      return { spot, before, mid, tip, after: await seam.graph.snapshot(page) };
    };

    // ------------------------------------------------------ graph / modes --
    await t.test('the Dependencies tab paints a force graph', async () => {
      await tab(page, 'dependencies').click();
      await t.settle(2600);
      const lit = await litCanvasSamples(page);
      t.assert.ok(lit > 100, `only ${lit} lit samples`);
      await t.shot('06-dependencies');
      return `${lit} lit samples`;
    });

    await t.test('switching to the matrix sub-mode renders the adjacency matrix', async () => {
      await stageAction(page, 'matrix').click();
      await t.settle(700);
      const cells = await matrixCells(page).count();
      t.assert.ok(cells > 100, `only ${cells} cells`);
      return `${cells} cells`;
    });

    await t.test('clicking a matrix cell lists the class-level edges for that pair', async () => {
      const filled = matrixFilledCells(page);
      const populated = await filled.count();
      t.assert.ok(populated > 0, 'no matrix cell carries a reference to click');
      await filled.first().click();
      await t.settle(900);
      const rows = await depsLinkRows(page).count();
      t.assert.ok(rows > 0, `the clicked pair listed ${rows} class edges`);
      await t.shot('07-matrix');
      return `${rows} class edges listed under the cell`;
    });

    await t.test('the matrix sub-mode is marked active and shows its pane', async () => {
      await stageAction(page, 'matrix').click();
      await t.settle(500);
      const { mode } = await seam.graph.snapshot(page);
      t.assert.equal(mode, 'matrix', `the graph thinks it is in "${mode}" mode`);
      t.assert.equal(await activeStageAction(page, 'matrix').count(), 1, 'the matrix button is not the active one');
      t.assert.ok(await pane(page, 'dependencies').isVisible(), 'the matrix pane stayed hidden');
      return 'mode=matrix, button active, pane visible';
    });

    await t.test('the classes sub-mode is marked active and shows its pane', async () => {
      await stageAction(page, 'classes').click();
      await t.settle(500);
      const { mode } = await seam.graph.snapshot(page);
      t.assert.equal(mode, 'classes', `the graph thinks it is in "${mode}" mode`);
      t.assert.equal(await activeStageAction(page, 'classes').count(), 1, 'the classes button is not the active one');
      t.assert.ok(await pane(page, 'dependencies').isVisible(), 'the classes pane stayed hidden');
      return 'mode=classes, button active, pane visible';
    });

    await t.test('going back to the graph sub-mode hides the pane', async () => {
      await stageAction(page, 'graph').click();
      await t.settle(500);
      const { mode } = await seam.graph.snapshot(page);
      t.assert.equal(mode, 'graph', `the graph thinks it is in "${mode}" mode`);
      t.assert.equal(await activeStageAction(page, 'graph').count(), 1, 'the graph button is not the active one');
      t.assert.ok(!(await pane(page, 'dependencies').isVisible()), 'the pane is still covering the graph');
      return 'mode=graph, button active, pane hidden';
    });

    // ---------------------------------------------------------- gestures ---
    await t.test('the mouse wheel zooms the graph in', async () => {
      const box = await canvasBox(page);
      // the canvas-space point the original sweep zoomed around
      const at = { x: 720, y: 420 };
      t.assert.ok(at.x < box.width && at.y < box.height, `point (${at.x}, ${at.y}) is outside the ${box.width}x${box.height} canvas`);
      const before = await seam.graph.snapshot(page);
      await page.mouse.move(box.left + at.x, box.top + at.y);
      await page.mouse.wheel(0, -600);
      await t.settle(350);
      const after = await seam.graph.snapshot(page);
      t.assert.ok(after.zoom > before.zoom * 1.2, `zoom went ${before.zoom.toFixed(2)} -> ${after.zoom.toFixed(2)}`);
      return `${before.zoom.toFixed(2)} → ${after.zoom.toFixed(2)}`;
    });

    await t.test('dragging empty canvas pans the view 1:1, even once the pointer leaves the canvas', async () => {
      const { spot, before, after } = await dragEmptyCanvas(150, -120);
      // the whole point of the test is that the gesture carries on outside the box
      t.assert.ok(spot.y - 120 < 0, `the drag never left the canvas (start y=${spot.y})`);
      const dx = Math.round(after.panX - before.panX);
      const dy = Math.round(after.panY - before.panY);
      t.assert.ok(Math.abs(dx - 150) < 4 && Math.abs(dy + 120) < 4, `delta ${dx},${dy} (expected 150,-120)`);
      return `delta ${dx},${dy}`;
    });

    await t.test('panning leaves the zoom untouched', async () => {
      const { before, mid, after } = await dragEmptyCanvas(90, -70);
      t.assert.ok(mid.panning, 'the gesture did not pan — did it grab a node instead?');
      t.assert.ok(Math.abs(after.zoom - before.zoom) < 1e-9, `zoom went ${before.zoom.toFixed(3)} -> ${after.zoom.toFixed(3)}`);
      return `zoom ${after.zoom.toFixed(3)} unchanged across the pan`;
    });

    await t.test('no tooltip appears while dragging the graph', async () => {
      const { tip } = await dragEmptyCanvas(150, -120);
      t.assert.ok(tip.hidden, `tooltip appeared mid-drag: ${JSON.stringify(tip.text.slice(0, 46))}`);
      return 'tooltip stayed hidden mid-drag';
    });

    // ------------------------------------------------- hover / click / fit --
    await t.test('hovering a node reads out that package, not a stale treemap node', async () => {
      const box = await canvasBox(page);
      const node = await seam.graph.findNode(page);
      t.assert.ok(node, 'no graph node found to hover');
      await page.mouse.move(box.left + node.x, box.top + node.y);
      await t.settle(400);
      const tip = await tipState(page);
      t.assert.ok(!tip.hidden, 'no tooltip appeared for the hovered node');
      t.assert.ok(tip.text.includes(node.path), `tooltip does not name ${node.path}: ${JSON.stringify(tip.text.slice(0, 60))}`);
      return `${node.path} — ${tip.text.slice(0, 46)}`;
    });

    await t.test('a plain click on a node neither drags it nor refits the view', async () => {
      const box = await canvasBox(page);
      const node = await seam.graph.findNode(page);
      t.assert.ok(node, 'no graph node found to click');
      const before = await seam.graph.snapshot(page);
      await page.mouse.click(box.left + node.x, box.top + node.y);
      await t.settle(400);
      const after = await seam.graph.snapshot(page);
      t.assert.equal(after.draggingNode, null, `node ${after.draggingNode} was left dragging`);
      t.assert.ok(Math.abs(after.zoom - before.zoom) < 1e-9, `zoom went ${before.zoom.toFixed(3)} -> ${after.zoom.toFixed(3)}`);
      t.assert.ok(Math.abs(after.panX - before.panX) < 1e-9, `pan went ${before.panX.toFixed(1)} -> ${after.panX.toFixed(1)}`);
      return `dragging=null, zoom ${after.zoom.toFixed(3)}, pan ${after.panX.toFixed(0)} unchanged`;
    });

    await t.test('a plain click on a node selects its package', async () => {
      const box = await canvasBox(page);
      const node = await seam.graph.findNode(page);
      t.assert.ok(node, 'no graph node found to click');
      await page.mouse.click(box.left + node.x, box.top + node.y);
      await t.settle(500);
      const text = (await inspectorBody(page).textContent()) ?? '';
      t.assert.ok(text.includes(node.path), `inspector does not show ${node.path}`);
      return node.path;
    });

    await t.test('Fit reframes the graph', async () => {
      const before = await seam.graph.snapshot(page);
      await stageAction(page, 'Fit').click();
      await t.settle(500);
      const after = await seam.graph.snapshot(page);
      t.assert.ok(
        Math.abs(after.panX - before.panX) > 1 || Math.abs(after.zoom - before.zoom) > 1e-6,
        `the view did not move: pan ${before.panX.toFixed(1)} -> ${after.panX.toFixed(1)}, zoom ${before.zoom.toFixed(3)} -> ${after.zoom.toFixed(3)}`
      );
      await t.shot('16-dependencies-zoom');
      return `pan ${before.panX.toFixed(0)} → ${after.panX.toFixed(0)}, zoom ${before.zoom.toFixed(2)} → ${after.zoom.toFixed(2)}`;
    });

    await t.test('no console errors', async () => {
      t.assert.deepEqual(t.errors, [], t.errors.slice(0, 3).join(' | '));
      return 'clean';
    });
  },
};
