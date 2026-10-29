/**
 * Inspector: what the right-hand panel shows for a selection.
 *
 * `boot.spec` covers the empty panel (the project overview); this spec covers
 * what a selection replaces it with — a type's metrics, ancestry and members, a
 * package's aggregates and actions — and the transitions between them.
 *
 * Two regression guards live here. The member filter is a live input: it must
 * keep focus *and* the caret while the list is filtered, and a value that is
 * too wide for the panel must be clipped rather than wrapped or pushed out past
 * the panel's edge.
 */

import {
  inspectorAction,
  inspectorBadges,
  inspectorBody,
  inspectorTitle,
  memberFilter,
  memberRows,
  metricKeys,
  pane,
  refsSection,
} from '../locators.mjs';
import { seam } from '../seam.mjs';
import { ISO_PLAYER, ZOOM_ISO } from '../fixtures.mjs';

/** Metric keys the class panel always renders. */
const CLASS_METRICS = ['source lines', 'code lines', 'methods', 'fields', 'complexity'];

/**
 * The one package `IsoPlayer` lives in. Not `ISO_DOMAIN`: that fixture is the
 * *domain* key (`iso`), which is not a package path and has no panel.
 */
const ISO_PACKAGE = 'zombie.iso';

/** Below 1400px the stylesheet narrows the inspector to its tightest width. */
const NARROW_VIEWPORT = { width: 1100, height: 900 };

export default {
  name: 'Inspector',

  async run(t) {
    const { page } = t;
    const oneLine = (text) => text.replace(/\s+/g, ' ').trim();

    /** Select a type the way a click on the treemap/hierarchy would. */
    const select = async (name) => {
      await seam.store.apply(page, { classIdByName: name });
      await inspectorTitle(page).filter({ hasText: name }).waitFor({ timeout: 10000 });
    };

    /**
     * Every metric row currently on screen, measured in the page: how many
     * lines it takes, whether its value is clipped, and whether the row stays
     * inside the panel that holds it.
     */
    const measureMetrics = () =>
      page.evaluate(() => {
        const body = document.querySelector('#inspector-body');
        const box = body.getBoundingClientRect();
        return [...body.querySelectorAll('.kv dt')].map((dt) => {
          const dd = dt.nextElementSibling;
          const rect = dd.getBoundingClientRect();
          const line = parseFloat(getComputedStyle(dd).lineHeight) || parseFloat(getComputedStyle(dd).fontSize) * 1.2;
          return {
            key: dt.textContent.trim(),
            value: dd.textContent,
            lines: Math.round(rect.height / line),
            clipped: dd.scrollWidth > dd.clientWidth + 1,
            title: dd.getAttribute('title'),
            pastRight: Math.round(rect.right - box.right),
            pastLeft: Math.round(box.left - rect.left),
          };
        });
      });

    /** The reported shape: no wrap, no overflow, tooltip exactly when clipped. */
    const assertMetricsFit = (rows, where) => {
      t.assert.ok(rows.length > 0, `${where}: no metric rows were rendered`);
      const wrapped = rows.filter((r) => r.lines > 1).map((r) => r.key);
      t.assert.deepEqual(wrapped, [], `${where}: these rows wrapped instead of truncating: ${wrapped.join(', ')}`);
      const escaped = rows.filter((r) => r.pastRight > 1 || r.pastLeft > 1).map((r) => `${r.key} (+${r.pastRight}px)`);
      t.assert.deepEqual(escaped, [], `${where}: these values stick out of the panel: ${escaped.join(', ')}`);
      const wrongTitle = rows
        .filter((r) => (r.clipped ? r.title !== r.value : r.title !== null))
        .map((r) => `${r.key}: ${r.title === null ? 'no tooltip' : JSON.stringify(r.title)}`);
      t.assert.deepEqual(wrongTitle, [], `${where}: tooltips do not match clipping: ${wrongTitle.join('; ')}`);
      return rows.filter((r) => r.clipped).map((r) => r.key);
    };

    /**
     * The worst horizontal overflow anywhere in the panel, and how many values
     * are being clipped to stay there.
     *
     * Content inside an element that clips (`.sig`, `.nm`, a `dd`) is left out:
     * that text is ellipsized on purpose, and measuring it would report every
     * long member signature as a layout problem.
     */
    const measurePanelOverflow = () =>
      page.evaluate(() => {
        const body = document.querySelector('#inspector-body');
        const box = body.getBoundingClientRect();
        const clippedByAncestor = (el) => {
          for (let p = el.parentElement; p && p !== body; p = p.parentElement) {
            if (getComputedStyle(p).overflowX !== 'visible') return true;
          }
          return false;
        };
        let worst = { pastRight: 0, cls: '', text: '' };
        for (const el of body.querySelectorAll('*')) {
          const pastRight = Math.round(el.getBoundingClientRect().right - box.right);
          if (pastRight > worst.pastRight && !clippedByAncestor(el)) {
            worst = { pastRight, cls: el.className?.toString() ?? el.tagName.toLowerCase(), text: (el.textContent ?? '').slice(0, 60) };
          }
        }
        let clippedValues = 0;
        for (const el of body.querySelectorAll('.sub, dd')) if (el.scrollWidth > el.clientWidth + 1) clippedValues++;
        return { ...worst, clippedValues };
      });

    await t.test('selecting a type replaces the project overview', async () => {
      const overview = await inspectorBody(page).innerText();
      t.assert.match(overview, /Project overview/, 'the panel did not open on the project overview');

      await select(ISO_PLAYER);
      const panel = await inspectorBody(page).innerText();
      t.assert.equal(oneLine(await inspectorTitle(page).innerText()), ISO_PLAYER, 'the panel titled the wrong type');
      t.assert.ok(!/Project overview/.test(panel), 'the overview is still rendered behind the selection');
      return 'overview → IsoPlayer';
    });

    await t.test('the type panel shows name, kind, metrics, hierarchy and members', async () => {
      await select(ISO_PLAYER);
      // Members arrive from a per-package shard; the filter input only exists
      // once that shard has been fetched and rendered.
      await memberFilter(page).waitFor({ timeout: 15000 });

      const badge = oneLine(await inspectorBadges(page).first().innerText());
      t.assert.equal(badge, 'class', `the kind badge reads ${JSON.stringify(badge)}`);

      const keys = await metricKeys(page).allInnerTexts();
      const missing = CLASS_METRICS.filter((k) => !keys.includes(k));
      t.assert.deepEqual(missing, [], `metrics missing from the panel: ${missing.join(', ')}`);

      // Section headings are uppercased by CSS, so match rendered text loosely.
      const panel = await inspectorBody(page).innerText();
      t.assert.match(panel, /hierarchy/i, 'no hierarchy section');
      t.assert.match(panel, /methods/i, 'no members section');

      const members = await memberRows(page).count();
      t.assert.ok(members > 50, `only ${members} member rows`);
      return `${ISO_PLAYER} · ${badge} · ${keys.length} metrics · ${members} member rows`;
    });

    await t.test('the member filter narrows the list and keeps focus while re-rendering', async () => {
      await select(ISO_PLAYER);
      await memberFilter(page).waitFor({ timeout: 15000 });
      await memberFilter(page).fill('');
      await t.settle(250);

      const before = await memberRows(page).count();
      t.assert.ok(before > 50, `only ${before} member rows before filtering`);

      await memberFilter(page).fill('get');
      await t.settle(350);
      const after = await memberRows(page).count();
      t.assert.ok(after > 0, `filtering to "get" left ${after} member rows`);
      t.assert.ok(after < before, `the filter did not narrow the list: ${before} → ${after} rows`);

      // Regression guard: typing repaints the member list, and the input has to
      // come through that with its focus and its query intact (the panel is
      // also rebuilt whenever a member or reference shard finishes loading).
      const focused = await memberFilter(page).evaluate((el) => el === document.activeElement);
      t.assert.ok(focused, 'the filter lost keyboard focus when the list re-rendered');
      t.assert.equal(await memberFilter(page).inputValue(), 'get', 'the query was lost when the list re-rendered');

      await memberFilter(page).fill('');
      await t.settle(250);
      return `${before} → ${after} rows · focus kept`;
    });

    await t.test('the member filter types at the caret, not at the start', async () => {
      await select(ISO_PLAYER);
      await memberFilter(page).waitFor({ timeout: 15000 });
      await memberFilter(page).fill('');
      await t.settle(250);

      // `fill()` sets the value in one shot, so it cannot see this defect:
      // every keystroke used to rebuild the input, and the replacement put the
      // caret back at position 0 — the typed characters came out reversed.
      await memberFilter(page).click();
      await memberFilter(page).pressSequentially('get', { delay: 40 });
      await t.settle(300);
      t.assert.equal(await memberFilter(page).inputValue(), 'get', 'typing into the filter reversed the query');

      // …and an edit in the middle of the value has to stay in the middle.
      await memberFilter(page).fill('abcd');
      await memberFilter(page).press('ArrowLeft');
      await memberFilter(page).press('ArrowLeft');
      await memberFilter(page).pressSequentially('X', { delay: 40 });
      await t.settle(300);
      t.assert.equal(await memberFilter(page).inputValue(), 'abXcd', 'the caret was not where the arrow keys left it');

      await memberFilter(page).fill('');
      await t.settle(250);
      return '"get" in order · mid-value edit → abXcd';
    });

    await t.test('metric values truncate instead of wrapping or overflowing', async () => {
      const original = page.viewportSize();
      await page.setViewportSize(NARROW_VIEWPORT);
      try {
        await select(ISO_PLAYER);
        await memberFilter(page).waitFor({ timeout: 15000 });
        await t.settle(400);

        const declaredAt = (await measureMetrics()).find((r) => r.key === 'declared at');
        t.assert.ok(declaredAt, 'the class panel has no "declared at" metric');
        t.assert.ok(
          declaredAt.clipped,
          `"declared at" (${declaredAt.value}, ${declaredAt.pastRight}px past the panel edge) is not truncated — the row wraps or pushes the panel wider instead`
        );
        const clipped = assertMetricsFit(await measureMetrics(), 'class metrics');

        await seam.store.apply(page, { packagePath: ISO_PACKAGE });
        await inspectorAction(page, 'Zoom treemap here').waitFor({ timeout: 10000 });
        await t.settle(400);
        assertMetricsFit(await measureMetrics(), 'package metrics');

        return `class metrics clipped: ${clipped.join(', ')} · package metrics fit`;
      } finally {
        await page.setViewportSize(original);
        await t.settle(300);
      }
    });

    await t.test('wide reference rows are clipped, not pushed out of the panel', async () => {
      const original = page.viewportSize();
      await page.setViewportSize(NARROW_VIEWPORT);
      try {
        // A type's own name is repeated in its rows (the References list labels
        // a caller `new VeryLongClassName`), so the longest-named types are the
        // widest rows the panel can be asked to draw.
        const names = await seam.atlas.longestNames(page, 3);
        let clippedValues = 0;
        for (const name of names) {
          await select(name);
          // The section only carries `data-refs` once the shard has loaded.
          await refsSection(page).waitFor({ timeout: 5000 }).catch(() => {});
          await t.settle(350);

          const worst = await measurePanelOverflow();
          t.assert.equal(
            worst.pastRight,
            0,
            `${name}: <${worst.cls}> "${worst.text}" sticks ${worst.pastRight}px past the panel edge`
          );
          clippedValues += worst.clippedValues;
        }
        t.assert.ok(clippedValues > 0, 'none of the widest types produced a clipped value — the check proved nothing');
        return `${names.length} wide types · ${clippedValues} values clipped · nothing past the edge`;
      } finally {
        await page.setViewportSize(original);
        await t.settle(300);
      }
    });

    await t.test('selecting a package shows its panel and zoom action', async () => {
      await seam.store.apply(page, { packagePath: ISO_PACKAGE });
      const zoom = inspectorAction(page, 'Zoom treemap here');
      await zoom.waitFor({ timeout: 10000 });

      t.assert.equal(oneLine(await inspectorTitle(page).innerText()), 'iso', 'the panel titled the wrong package');
      const panel = await inspectorBody(page).innerText();
      t.assert.match(panel, /zombie\.iso/, 'the panel does not name the package path');
      t.assert.match(panel, /package metrics/i, 'the package panel has no metrics');

      await zoom.click();
      await t.settle(700);
      t.assert.equal(await seam.store.view(page), 'treemap', 'zooming did not switch to the treemap');
      t.assert.deepEqual(await seam.store.zoomPath(page), ZOOM_ISO, `zoom path was ${(await seam.store.zoomPath(page)).join(' > ')}`);
      return `${ISO_PACKAGE} → ${ZOOM_ISO.join(' > ')}`;
    });

    await t.test('"Show in hierarchy" switches to the hierarchy view', async () => {
      await select(ISO_PLAYER);
      const focus = inspectorAction(page, 'Show in hierarchy');
      await focus.waitFor({ timeout: 10000 });
      await focus.click();
      await t.settle(700);

      t.assert.equal(await seam.store.view(page), 'hierarchy', 'the view did not switch');
      const expected = await seam.atlas.classId(page, ISO_PLAYER);
      t.assert.equal((await seam.store.selection(page)).classId, expected, 'the wrong type is selected');
      t.assert.ok(await pane(page, 'hierarchy').isVisible(), 'the hierarchy pane is not shown');
      return `view=hierarchy · ${ISO_PLAYER}`;
    });

    await t.test('no console errors', async () => {
      t.assert.deepEqual(t.errors, [], t.errors.slice(0, 3).join(' | '));
      return 'clean';
    });
  },
};
