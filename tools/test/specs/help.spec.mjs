/**
 * Help dialog: what opens it, what it documents, and how it closes.
 *
 * The old smoke script only checked that one modal opened and that its primary
 * button closed it; the content assertions here matter because the dialog is
 * the only place the shortcuts and the five views are written down.
 */

import { helpButton, modal, modalBackdrop, modalKeys, modalPrimary, modalTitle, tabs } from '../locators.mjs';

export default {
  name: 'Help',

  async run(t) {
    const { page } = t;
    const oneLine = (text) => text.replace(/\s+/g, ' ').trim();

    /** Open the dialog if it is not already open. */
    const openHelp = async () => {
      if ((await modal(page).count()) === 0) await page.keyboard.press('?');
      await modal(page).waitFor({ timeout: 5000 });
      await t.settle(200);
    };

    /** Close it again, whatever state it is in. */
    const closeHelp = async () => {
      if (await modal(page).count()) {
        await modalPrimary(page).click();
        await t.settle(200);
      }
    };

    await t.test('pressing ? opens the help dialog', async () => {
      await page.keyboard.press('?');
      await modal(page).waitFor({ timeout: 5000 });
      t.assert.equal(await modal(page).count(), 1, `${await modal(page).count()} dialogs are open`);
      t.assert.equal(oneLine(await modalTitle(page).innerText()), 'Zombie Atlas', 'the dialog has the wrong title');
      await t.shot('13-help');
      return 'open';
    });

    await t.test('the dialog documents the five views and the keyboard shortcuts', async () => {
      await openHelp();
      const content = await modal(page).innerText();

      const views = (await tabs(page).allInnerTexts()).map(oneLine).filter(Boolean);
      t.assert.equal(views.length, 5, `the shell offers ${views.length} views`);
      const undocumented = views.filter((view) => !content.includes(view));
      t.assert.deepEqual(undocumented, [], `views missing from the dialog: ${undocumented.join(', ')}`);

      const keys = (await modalKeys(page).allInnerTexts()).map(oneLine).filter(Boolean);
      t.assert.ok(keys.length >= 8, `only ${keys.length} shortcuts documented: ${keys.join(' ')}`);
      for (const key of ['Esc', '/', '1…5']) {
        t.assert.ok(keys.includes(key), `shortcut ${JSON.stringify(key)} is not documented`);
      }
      // Section headings are uppercased by CSS.
      t.assert.match(content, /mouse & keyboard/i, 'no "Mouse & keyboard" section');

      await closeHelp();
      return `${views.length} views · ${keys.length} shortcuts: ${keys.join(' ')}`;
    });

    await t.test('the primary button closes the dialog', async () => {
      await openHelp();
      await modalPrimary(page).click();
      await t.settle(250);
      t.assert.equal(await modal(page).count(), 0, 'the dialog stayed open');
      return 'closed';
    });

    await t.test('clicking the backdrop closes the dialog', async () => {
      await openHelp();
      // Top-left corner: well clear of the centred dialog, inside the backdrop.
      await modalBackdrop(page).click({ position: { x: 8, y: 8 } });
      await t.settle(250);
      t.assert.equal(await modal(page).count(), 0, 'clicking outside the dialog left it open');
      return 'closed';
    });

    await t.test('#btn-help opens the same dialog', async () => {
      await closeHelp();
      await helpButton(page).click();
      await modal(page).waitFor({ timeout: 5000 });
      t.assert.equal(await modal(page).count(), 1, `${await modal(page).count()} dialogs are open`);
      t.assert.equal(oneLine(await modalTitle(page).innerText()), 'Zombie Atlas', 'the dialog has the wrong title');
      t.assert.match(await modal(page).innerText(), /Treemap/, 'the button opened an empty dialog');

      await closeHelp();
      t.assert.equal(await modal(page).count(), 0, 'the dialog stayed open');
      return 'button and ? agree';
    });

    await t.test('no console errors', async () => {
      t.assert.deepEqual(t.errors, [], t.errors.slice(0, 3).join(' | '));
      return 'clean';
    });
  },
};
