/**
 * Source viewer: the modal that renders the decompiled file a type came from,
 * plus the raw HTTP plumbing behind it.
 *
 * The last two tests are the regression guard from the old smoke script: the
 * source tree is served from a configurable mount (`ZOMBIE_SRC`), and a request
 * for an unknown mount must 404 instead of falling through to the SPA fallback
 * and handing the viewer `index.html` — an HTML body where a `.java` file was
 * expected is far more confusing than a missing file.
 */

import { inspectorAction, modal, modalPrimary, modalTitle, sourceRows } from '../locators.mjs';
import { seam } from '../seam.mjs';
import { ISO_PLAYER } from '../fixtures.mjs';

export default {
  name: 'Source viewer',

  async run(t) {
    const { page } = t;
    const oneLine = (text) => text.replace(/\s+/g, ' ').trim();
    const base = t.url.replace(/\/$/, '');

    await t.test('"View source" opens the file the type was extracted from', async () => {
      await seam.store.apply(page, { classIdByName: ISO_PLAYER });
      const button = inspectorAction(page, 'View source');
      await button.waitFor({ timeout: 10000 });
      await button.click();

      // The modal opens straight away with a placeholder and swaps in the
      // table once the file has been fetched.
      await sourceRows(page).first().waitFor({ timeout: 15000 });
      const rows = await sourceRows(page).count();
      t.assert.ok(rows > 50, `only ${rows} source rows`);
      const title = oneLine(await modalTitle(page).innerText());
      t.assert.match(title, /IsoPlayer/, `the modal titles the wrong file: ${JSON.stringify(title)}`);
      await t.shot('04-source');

      await modalPrimary(page).click();
      await t.settle(250);
      t.assert.equal(await modal(page).count(), 0, 'the modal stayed open after its primary button');
      return `${rows} rows · ${title.slice(0, 56)}`;
    });

    await t.test('the raw tree is served at the configured mount', async () => {
      const mount = (await seam.atlas.meta(page)).sourceMount ?? 'zombie';
      const firstPath = await seam.atlas.firstPath(page);
      // The viewer fetches `src/<path>`, and the server only answers under
      // `/src/<mount>/`: a path without the mount would 404 for every type.
      t.assert.ok(firstPath.startsWith(`${mount}/`), `dataset path ${JSON.stringify(firstPath)} does not start with mount ${JSON.stringify(mount)}`);

      const res = await page.request.get(`${base}/src/${firstPath}`);
      t.assert.ok(res.ok(), `GET /src/${firstPath} → ${res.status()}`);
      const body = await res.text();
      t.assert.match(body, /^\s*(\/\/|package)/, `the body does not look like Java: ${JSON.stringify(body.slice(0, 60))}`);
      t.assert.ok(!/<html/i.test(body), 'the raw source request returned the SPA HTML instead of the file');
      return `${res.status()} /src/${firstPath} · ${body.length} bytes`;
    });

    await t.test('an unknown source mount is a 404, not the SPA', async () => {
      const res = await page.request.get(`${base}/src/definitely-not-the-mount/x.java`);
      t.assert.equal(res.status(), 404, `the unknown mount answered ${res.status()}`);
      const body = await res.text();
      t.assert.ok(!/<html/i.test(body), 'the 404 body is the SPA HTML');
      return `404 · ${oneLine(body).slice(0, 40)}`;
    });

    /**
     * Regression guard for a defect found while unit-testing the highlighter.
     *
     * The keyword pass ran over the whole line *after* the string and comment
     * passes had inserted their spans, and `var` is a Java keyword — so it was
     * being replaced inside the highlighter's own `style="color:var(--warn)"`
     * attributes. Every string and comment mark came out with a span nested
     * inside its tag, which corrupted the attribute and the surrounding markup.
     *
     * Nothing caught it: the code still *looked* like highlighted Java, and the
     * only existing assertion was on the row count.
     */
    await t.test('the highlighted markup is well formed', async () => {
      await seam.store.apply(page, { classIdByName: ISO_PLAYER });
      const button = inspectorAction(page, 'View source');
      await button.waitFor({ timeout: 10000 });
      await button.click();
      await sourceRows(page).first().waitFor({ timeout: 15000 });

      const report = await page.evaluate(() => {
        const cells = [...document.querySelectorAll('.src-code tr td:not(.ln)')];
        const broken = [];
        for (const td of cells) {
          const html = td.innerHTML;
          // A span opening inside another tag means an attribute was rewritten.
          if (/<[^>]*<span/.test(html)) broken.push(html.slice(0, 120));
        }
        const colourOf = (td) => getComputedStyle(td.querySelector('span') ?? td).color;
        return {
          cells: cells.length,
          broken: broken.slice(0, 3),
          brokenCount: broken.length,
          highlighted: cells.filter((td) => td.innerHTML.includes('<span')).length,
          colours: new Set(cells.map(colourOf)).size,
        };
      });

      t.assert.ok(report.cells > 50, `only ${report.cells} source cells`);
      t.assert.deepEqual(report.broken, [], `${report.brokenCount} cells contain a span inside a tag`);
      t.assert.ok(report.highlighted > report.cells * 0.5, `only ${report.highlighted}/${report.cells} cells highlighted`);
      // Untouched, keyword, string and comment text must resolve to distinct
      // colours — one colour would mean the spans render but do nothing.
      t.assert.ok(report.colours >= 3, `only ${report.colours} distinct text colours`);

      await modalPrimary(page).click();
      await t.settle(250);
      return `${report.cells} cells · ${report.highlighted} highlighted · ${report.colours} colours`;
    });

    await t.test('no console errors', async () => {
      t.assert.deepEqual(t.errors, [], t.errors.slice(0, 3).join(' | '));
      return 'clean';
    });
  },
};
