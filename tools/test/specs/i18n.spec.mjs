/**
 * Localization: the whole UI is translated, and switching language keeps your
 * place.
 *
 * Ported from the original monolithic i18n spec. The old file mixed three concerns — catalog
 * integrity, browser localization, and degraded operation (no storage, no
 * dataset). The pure catalog check moved to `tools/test/unit/catalog.test.mjs`;
 * the degraded paths stay here because they are still about language selection.
 *
 * The primary page is opened with a `zh-CN` browser locale, so "did the app
 * follow the browser?" is tested first and everything else builds on it.
 */

import {
  controlsHeading,
  graphHint,
  helpButton,
  inspectorTitle,
  languageSelect,
  memberFilter,
  modal,
  modalRoot,
  pane,
  searchBox,
  sourceCode,
  stageAction,
  stageMessage,
  tab,
  topbar,
  uiLanguage,
} from '../locators.mjs';
import { seam } from '../seam.mjs';

/** zh-CN labels, read from `src/locales/zh-cn.json`. */
const ZH = {
  treemap: '矩形树图',
  hierarchy: '继承层次',
  dependencies: '依赖关系',
  subsystems: '子系统',
  insights: '统计分析',
  controls: '视图控制',
  search: '搜索',
  titleFragment: '源码地图',
  hierarchyHeading: '继承树根节点',
  graphHint: '滚轮缩放',
  subsystemsHeading: '功能领域',
  insightsHeading: '复杂度最高的方法',
  matrix: '矩阵',
  matrixHeading: '包邻接矩阵',
  helpHeading: '鼠标与键盘',
  close: '关闭',
  viewSource: '查看源码',
  sourceHeading: '声明于第',
  loadError: '无法加载数据集',
};

/**
 * Every view, its tab label, and a locator for a heading that must be
 * translated. The dependency graph draws on the canvas and puts its interaction
 * hint in its own overlay rather than in the pane, so each view supplies its
 * own locator instead of a shared "pane + heading" shape.
 */
const VIEWS = [
  ['hierarchy', ZH.hierarchy, (p) => pane(p, 'hierarchy').getByText(ZH.hierarchyHeading, { exact: false })],
  ['dependencies', ZH.dependencies, (p) => graphHint(p).filter({ hasText: ZH.graphHint })],
  ['subsystems', ZH.subsystems, (p) => pane(p, 'subsystems').getByText(ZH.subsystemsHeading, { exact: false })],
  ['insights', ZH.insights, (p) => pane(p, 'insights').getByText(ZH.insightsHeading, { exact: false })],
];

export default {
  name: 'Localization',
  locale: 'zh-CN',
  viewport: { width: 1440, height: 1000 },

  async run(t) {
    const { page } = t;

    await t.test('the browser language selects Chinese', async () => {
      const lang = await uiLanguage(page);
      t.assert.equal(lang, 'zh-CN', `html[lang]=${lang}`);
      return 'zh-CN from the browser locale';
    });

    await t.test('the shell and its accessibility labels are translated', async () => {
      t.assert.equal(await controlsHeading(page).textContent(), ZH.controls, 'sidebar heading');
      t.assert.equal(await searchBox(page).getAttribute('aria-label'), ZH.search, 'search aria-label');
      const title = await page.title();
      t.assert.ok(title.includes(ZH.titleFragment), `title=${title}`);
      return `${ZH.controls} · ${ZH.search} · ${title.slice(0, 30)}`;
    });

    await t.test('every view is translated', async () => {
      for (const [view, label, heading] of VIEWS) {
        await tab(page, view).click();
        await t.settle(900);
        t.assert.equal(await tab(page, view).textContent(), label, `${view} tab label`);
        await heading(page).first().waitFor({ timeout: 15000 });
      }
      await tab(page, 'treemap').click();
      await t.settle(400);
      t.assert.equal(await tab(page, 'treemap').textContent(), ZH.treemap, 'treemap tab label');
      return '4 panes + 5 tabs';
    });

    await t.test('the dependency matrix is translated', async () => {
      await tab(page, 'dependencies').click();
      await t.settle(2200);
      await t.page.getByRole('button', { name: ZH.matrix, exact: true }).click();
      await t.settle(800);
      await pane(page, 'dependencies').getByText(ZH.matrixHeading, { exact: false }).first().waitFor({ timeout: 15000 });
      return ZH.matrixHeading;
    });

    await t.test('the help dialog is translated', async () => {
      await helpButton(page).click();
      await t.settle(400);
      const text = (await modalRoot(page).textContent()) ?? '';
      t.assert.ok(text.includes(ZH.helpHeading), 'keyboard section missing');
      await page.getByRole('button', { name: ZH.close, exact: true }).click();
      await t.settle(250);
      t.assert.equal(await modal(page).count(), 0, 'modal did not close');
      return ZH.helpHeading;
    });

    // Source identifiers stay language-neutral: only display labels translate.
    await t.test('source names are preserved, only the UI is translated', async () => {
      await tab(page, 'treemap').click();
      await t.settle(400);
      await seam.store.apply(page, {
        settings: { groupBy: 'stereotype+package' },
        filters: { minCode: 10 },
        classIdByName: 'IsoPlayer',
        zoom: ['st:class'],
      });
      await inspectorTitle(page).filter({ hasText: 'IsoPlayer' }).waitFor({ timeout: 15000 });
      const rootId = await seam.treemap.zoomRootId(page);
      t.assert.equal(rootId, 'st:class', `zoom root id was ${rootId}`);
      return 'IsoPlayer and st:class unchanged';
    });

    await t.test('the source viewer is translated', async () => {
      await page.getByRole('button', { name: ZH.viewSource, exact: true }).click();
      await sourceCode(page).waitFor({ timeout: 15000 });
      const text = (await modalRoot(page).textContent()) ?? '';
      t.assert.ok(text.includes(ZH.sourceHeading), 'source metadata not translated');
      await page.getByRole('button', { name: ZH.close, exact: true }).click();
      await t.settle(250);
      return ZH.sourceHeading;
    });

    // Regression guard: filtering repaints the member list, and the input must
    // keep both its value and its focus while that happens — in the translated
    // UI as much as in English.
    await t.test('the member filter works in Chinese and keeps focus', async () => {
      await memberFilter(page).fill('get');
      await memberFilter(page).waitFor({ timeout: 15000 });
      await page.waitForFunction(() => document.activeElement?.id === 'member-filter', null, { timeout: 15000 });
      t.assert.equal(await memberFilter(page).inputValue(), 'get', 'the query was lost');
      return 'focus retained across the repaint';
    });

    await t.test('exported type kinds stay language-neutral', async () => {
      const download = page.waitForEvent('download', { timeout: 15000 });
      await stageAction(page, 'JSON').click();
      const file = await download;
      // Read the artefact the browser produced rather than any in-memory state.
      const { readFile } = await import('node:fs/promises');
      const payload = JSON.parse(await readFile(await file.path(), 'utf8'));
      const kinds = new Set(payload.types.map((c) => c.kind));
      t.assert.ok(payload.types.length > 0, 'nothing was exported');
      for (const kind of kinds) {
        t.assert.ok(
          ['class', 'interface', 'enum', 'record', 'annotation'].includes(kind),
          `untranslated kind leaked into the export: ${kind}`
        );
      }
      return `${payload.types.length} types, kinds: ${[...kinds].join(', ')}`;
    });

    await t.test('switching language preserves the view, filters, selection and zoom', async () => {
      const before = await seam.store.state(page);
      const snapshot = JSON.stringify([before.view, before.selection, before.settings, before.depMode]);

      await t.switchLanguage('en');

      const after = await seam.store.state(page);
      const restored = JSON.stringify([after.view, after.selection, after.settings, after.depMode]);
      t.assert.equal(restored, snapshot, 'state did not survive the language switch');
      t.assert.equal(await controlsHeading(page).textContent(), 'View controls', 'shell not in English');
      return 'view, selection, filters and dependency mode preserved';
    });

    // The language chosen above is stored, so these must run in the *same*
    // context — a fresh one would have empty storage and fall back to the
    // browser locale, testing nothing.
    const goto = async (url) => {
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => !!window.zombieAtlas, null, { timeout: 20000 });
      await t.settle(700);
    };

    await t.test('a saved language overrides the browser', async () => {
      await goto(t.url);
      t.assert.equal(await uiLanguage(page), 'en', 'saved language not applied');
      return 'en from storage beats zh-CN from the browser';
    });

    await t.test('?lang= overrides the saved language', async () => {
      await goto(`${t.url}?lang=zh-CN`);
      t.assert.equal(await uiLanguage(page), 'zh-CN', 'URL language not applied');
      return '?lang=zh-CN wins over storage';
    });

    await t.test('an unsupported language falls back to English', async () => {
      const app = await t.newApp({ locale: 'fr-FR', search: '?lang=invalid', waitForData: false });
      t.assert.equal(await uiLanguage(app.page), 'en', 'did not fall back');
      return 'invalid → en';
    });

    await t.test('the header fits at 1440px in Chinese', async () => {
      const overflow = await topbar(page).evaluate((el) => el.scrollWidth > el.clientWidth);
      t.assert.equal(overflow, false, 'the top bar overflows in Chinese');
      return 'no overflow';
    });

    // Degraded operation: language switching must still work with no storage
    // and no dataset, and the failure must be reported in the chosen language.
    await t.test('language switching survives denied storage and a missing dataset', async () => {
      const app = await t.newApp({
        locale: 'fr-FR',
        search: '?lang=invalid',
        waitForData: false,
        route: async (context) => {
          await context.addInitScript(() => {
            Object.defineProperty(window, 'localStorage', {
              get() {
                throw new Error('storage denied');
              },
            });
          });
          await context.route('**/data/**', (route) => route.fulfill({ status: 503, body: 'unavailable' }));
        },
      });

      await stageMessage(app.page).waitFor({ state: 'visible', timeout: 20000 });
      t.assert.equal(await uiLanguage(app.page), 'en', 'fallback after invalid lang');

      await languageSelect(app.page).selectOption('zh-CN');
      await app.page.waitForURL('**lang=zh-CN**');
      await app.page.getByText(ZH.loadError, { exact: false }).waitFor({ timeout: 20000 });
      t.assert.equal(await uiLanguage(app.page), 'zh-CN', 'switch failed without storage');
      return 'localized load error, switchable without storage';
    });

    await t.test('no console errors', async () => {
      t.assert.deepEqual(t.errors, [], t.errors.slice(0, 3).join(' | '));
      return 'clean';
    });
  },
};
