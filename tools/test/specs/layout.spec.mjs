/**
 * Panel layout: tall panels stay scrollable and the shell never clips.
 *
 * Regression guard, carried over from the `--- scrolling ---` section of the
 * old linear smoke test: a `1fr` grid row plus `body{overflow:hidden}` used to
 * give every tall panel overflow that no gesture could reach — the sidebar and
 * inspector had content, `scrollHeight` exceeded `clientHeight`, and `scrollTop`
 * still stayed pinned at 0.
 *
 * The invariant is therefore "every pixel of overflow is reachable", not a
 * fixed amount: `canScroll` scrolls a container to its maximum and reports
 * whether it got there, and `overflowReachable` accepts both a panel with
 * nothing to scroll and one whose whole overflow is reachable.
 *
 * The panels that always carry more content than a 1000px viewport (the
 * inspector of a large class, the three data panes, the sidebar at 720p) are
 * additionally required to have more than 100px of overflow, so a pane that
 * collapsed to nothing fails loudly instead of passing vacuously.
 */

import { sel, tab } from '../locators.mjs';
import { canScroll, fitsViewport, overflowReachable } from '../probes.mjs';
import { seam } from '../seam.mjs';
import { ISO_PLAYER } from '../fixtures.mjs';

/** Overflow below this is too small to prove that a panel really scrolls. */
const SUBSTANTIAL = 100;

/** Panes whose content is always taller than one viewport. */
const PANES = [
  ['hierarchy', 'Hierarchy'],
  ['subsystems', 'Subsystems'],
  ['insights', 'Insights'],
];

export default {
  name: 'Panel layout',

  async run(t) {
    const { page } = t;
    /** The viewport the suite booted with, to restore after the 720p check. */
    const viewport = page.viewportSize();

    await t.test('the sidebar reaches the end of its overflow', async () => {
      const r = await canScroll(page, sel.sidebar);
      t.assert.ok(r, 'the sidebar was not found');
      t.assert.ok(overflowReachable(r), JSON.stringify(r));
      return `${r.overflow}px overflow, ${r.reached}px reached`;
    });

    await t.test(`the inspector of ${ISO_PLAYER} reaches the end of its overflow`, async () => {
      await seam.store.apply(page, { classIdByName: ISO_PLAYER });
      await t.settle(1500);
      const r = await canScroll(page, sel.inspector);
      t.assert.ok(r, 'the inspector was not found');
      t.assert.ok(overflowReachable(r) && r.overflow > SUBSTANTIAL, JSON.stringify(r));
      return `${r.overflow}px overflow, ${r.reached}px reached`;
    });

    await t.test('the sidebar still reaches the end of its overflow at 720p', async () => {
      await page.setViewportSize({ width: 1280, height: 720 });
      await t.settle(500);
      try {
        const r = await canScroll(page, sel.sidebar);
        t.assert.ok(overflowReachable(r) && (r?.overflow ?? 0) > SUBSTANTIAL, JSON.stringify(r));
        return `${r.overflow}px overflow at 1280×720`;
      } finally {
        // Restore even when the assertion above fails, so one layout defect
        // cannot cascade into every later test in this spec.
        await page.setViewportSize(viewport);
        await t.settle(400);
      }
    });

    await t.test('the shell fits the viewport without clipped overflow', async () => {
      const fits = await fitsViewport(page);
      t.assert.ok(fits, `the shell is taller than the ${viewport.width}×${viewport.height} viewport, so its bottom is cut off`);
      return `${viewport.width}×${viewport.height}`;
    });

    for (const [view, name] of PANES) {
      // Panes are created on first visit and removed on teardown, so each one
      // has to be opened before it can be measured.
      await t.test(`the ${name} pane reaches the end of its overflow`, async () => {
        await tab(page, view).click();
        await t.settle(700);
        const r = await canScroll(page, sel.pane[view]);
        t.assert.ok(r, `the ${name} pane was not rendered`);
        t.assert.ok(overflowReachable(r) && r.overflow > SUBSTANTIAL, JSON.stringify(r));
        return `${r.overflow}px overflow, ${r.reached}px reached`;
      });
    }

    await t.test('no console errors', async () => {
      t.assert.deepEqual(t.errors, [], t.errors.slice(0, 3).join(' | '));
      return 'clean';
    });
  },
};
