/**
 * Every selector the suite depends on, in one place.
 *
 * The specs themselves never write a raw selector: they ask for a *thing*
 * (a tab, a stage action, a control field) and this module decides how to find
 * it. That keeps the markup contract in a single reviewable file, so a UI
 * restructure is a change here rather than across fourteen specs.
 *
 * Preference order, most to least durable:
 *   1. language-neutral app concepts — `[data-view="treemap"]`
 *   2. accessible roles and names
 *   3. container ids that the app itself treats as stable (`#inspector-body`)
 *   4. CSS class names from the design system (`.chip`, `.rank-row`)
 */

export const sel = {
  app: '#app',
  /** The document element: carries the applied theme (`data-theme`) and language (`lang`). */
  html: 'html',
  topbar: '.topbar',
  brandSub: '#brand-sub',
  tabs: '#tabs',
  sidebar: '#sidebar',
  controls: '#controls',
  legend: '#legend',
  stage: '#stage',
  stageActions: '#stage-actions',
  breadcrumbs: '#breadcrumbs',
  canvasWrap: '#canvas-wrap',
  workspace: '.workspace',
  canvas: '#canvas',
  overlay: '#overlay',
  tooltip: '#tooltip',
  emptyState: '#empty-state',
  stageMessage: '#stage-message',
  inspector: '#inspector',
  inspectorBody: '#inspector-body',
  statusbar: '#statusbar',
  search: '#search',
  searchResults: '#search-results',
  language: '#language',
  helpButton: '#btn-help',
  themeButton: '#btn-theme',
  settingsButton: '#btn-settings',
  modalRoot: '#modal-root',

  /** Panes are created lazily by their view and removed on teardown. */
  pane: {
    hierarchy: '#hierarchy-pane',
    dependencies: '#deps-pane',
    subsystems: '#subsystems-pane',
    insights: '#insights-pane',
  },
};

/* ---------------------------------------------------------------- shell -- */

export const app = (page) => page.locator(sel.app);
/** The applied colour theme — `light` or `dark` (the app's `html[data-theme]` switch). */
export const theme = (page) => page.locator(sel.html).getAttribute('data-theme');
/** The active UI language — `en` or `zh-CN` (`html[lang]`). */
export const uiLanguage = (page) => page.locator(sel.html).getAttribute('lang');
/** The three-column shell. Collapsing the sidebar/inspector is driven by
 *  `no-sidebar` / `no-inspector` classes on this element. */
export const workspace = (page) => page.locator(sel.workspace);
export const sidebar = (page) => page.locator(sel.sidebar);
export const inspector = (page) => page.locator(sel.inspector);
export const brandSub = (page) => page.locator(sel.brandSub);
export const statusbar = (page) => page.locator(sel.statusbar);
export const breadcrumbs = (page) => page.locator(sel.breadcrumbs);
export const crumbs = (page) => page.locator(`${sel.breadcrumbs} .crumb`);

/** View tabs. Keyed by view id so the locator survives translation. */
export const tab = (page, view) => page.locator(`${sel.tabs} [data-view="${view}"]`);
export const tabs = (page) => page.locator(`${sel.tabs} [data-view]`);

export const stageAction = (page, label) =>
  page.locator(`${sel.stageActions} button`).filter({ hasText: label }).first();
export const stageActions = (page) => page.locator(`${sel.stageActions} button`);
/** Labels of the stage buttons currently marked active. */
export const activeStageActions = (page) =>
  page.locator(`${sel.stageActions} button.on`).allTextContents();
/** The stage button carrying `label` that is marked active — count 1 or 0. */
export const activeStageAction = (page, label) =>
  page.locator(`${sel.stageActions} button.on`).filter({ hasText: label });

/** The one tooltip element, shared by the treemap and the dependency graph. */
export const tooltip = (page) => page.locator(sel.tooltip);

export const pane = (page, view) => page.locator(sel.pane[view]);
export const modal = (page) => page.locator(`${sel.modalRoot} .modal`);
export const modalPrimary = (page) => page.locator(`${sel.modalRoot} button.primary`);
/** The "nothing to draw" card that explains an over-filtered treemap. */
export const emptyState = (page) => page.locator(sel.emptyState);
export const emptyStateCard = (page) => page.locator(`${sel.emptyState} .empty-state-card`);
export const emptyStateWhy = (page) => page.locator(`${sel.emptyState} .why`);
export const emptyStateAction = (page, label) =>
  page.locator(`${sel.emptyState} button`).filter({ hasText: label }).first();

/* --------------------------------------------------- shell, chrome, panes -- */

/** The sidebar's "View controls" heading — a translation checkpoint. */
export const controlsHeading = (page) => page.locator('#panel-controls h2');
export const topbar = (page) => page.locator(sel.topbar);
export const modalRoot = (page) => page.locator(sel.modalRoot);
export const stageMessage = (page) => page.locator(sel.stageMessage);
export const languageSelect = (page) => page.locator(sel.language);
/** The source-viewer's code table. */
export const sourceCode = (page) => page.locator('.src-code');
/** The gradient swatch the legend shows for numeric colour modes. */
export const legendGradient = (page) => page.locator(`${sel.legend} .legend-gradient`);

/* ------------------------------------------------------------- controls -- */

/**
 * A sidebar field, found by its visible label.
 *
 * The label element is a sibling of its control rather than wrapping it, so
 * `getByLabel()` cannot be used yet; this is the single place that assumption
 * lives.
 */
export const controlField = (page, label) =>
  page.locator(`${sel.controls} .field`).filter({ has: page.getByText(label, { exact: true }) });

export const controlSelect = (page, label) => controlField(page, label).locator('select');
export const controlNumber = (page, label) => controlField(page, label).locator('input[type="number"]');
export const controlRange = (page, label) => controlField(page, label).locator('input[type="range"]');
/** Every range input in the sidebar (composite weights + depth/padding/cull). */
export const controlRanges = (page) => page.locator(`${sel.controls} input[type="range"]`);
export const controlCheckbox = (page, label) =>
  page.locator(`${sel.controls} label.chk`).filter({ hasText: label }).locator('input');
export const controlButton = (page, label) =>
  page.locator(`${sel.controls} button`).filter({ hasText: label }).first();

export const chips = (page) => page.locator(`${sel.controls} .chip`);
export const activeChips = (page) => page.locator(`${sel.controls} .chip.on`);
export const chip = (page, text) => chips(page).filter({ hasText: text }).first();
/** The persistence footer note (storage status / repairs). */
export const storageNote = (page) => page.locator(`${sel.controls} .field:last-child .hint`);

export const legendItems = (page) => page.locator(`${sel.legend} .legend-item`);

/* --------------------------------------------------------------- search -- */

export const searchBox = (page) => page.locator(sel.search);
export const searchResults = (page) => page.locator(sel.searchResults);
export const searchItems = (page) => page.locator('.sr-item');
export const activeSearchItem = (page) => page.locator('.sr-item.active');
/** The single explanatory row shown in place of hits when nothing matches. */
export const searchEmpty = (page) => page.locator(`${sel.searchResults} .sr-empty`);

/* ------------------------------------------------------------ inspector -- */

export const inspectorBody = (page) => page.locator(sel.inspectorBody);
export const inspectorTitle = (page) => page.locator(`${sel.inspectorBody} h1`);
export const memberFilter = (page) => page.locator('#member-filter');
export const inspectorAction = (page, label) =>
  page.locator(`${sel.inspectorBody} button`).filter({ hasText: label }).first();
/** Title badges — the first one is the selected type's kind. */
export const inspectorBadges = (page) => page.locator(`${sel.inspectorBody} .badge`);
/** Metric names in the panel's definition lists. */
export const metricKeys = (page) => page.locator(`${sel.inspectorBody} .kv dt`);
/** One row per member in the filterable members list. */
export const memberRows = (page) => page.locator(`${sel.inspectorBody} .member-list .member`);
/** The inspector's References section — present only when the bundle has the reference layer. */
export const refsSection = (page) => page.locator(`${sel.inspectorBody} [data-refs="section"]`);
/** Rows inside the References section (one per referenced member). */
export const refsRows = (page) => page.locator(`${sel.inspectorBody} [data-refs="row"]`);

/* ------------------------------------------------------- dependencies ----- */

/** The caret that expands one class pair into its member-level edges. */
export const memberEdgeCaret = (page) => page.locator(`${sel.pane.dependencies} .edge-item .caret`);
/** The member-level rows revealed by that caret. */
export const memberEdgeRows = (page) => page.locator(`${sel.pane.dependencies} .member-edges .link`);
/** One insight card, located by its heading. */
export const insightCardNamed = (page, title) =>
  page.locator(`${sel.pane.insights} .card`).filter({ has: page.locator('h3', { hasText: title }) });

/* ---------------------------------------------------------------- modal -- */

export const helpButton = (page) => page.locator(sel.helpButton);
export const modalTitle = (page) => page.locator(`${sel.modalRoot} .modal h2`);
/** The `<kbd>` keys documented by a dialog (the help dialog lists its own). */
export const modalKeys = (page) => page.locator(`${sel.modalRoot} .modal kbd`);
/** The click-outside surface behind a dialog. */
export const modalBackdrop = (page) => page.locator(`${sel.modalRoot} .modal-backdrop`);

/* --------------------------------------------------------------- panes -- */

export const domainCards = (page) => page.locator('.domain-card');
export const insightCards = (page) => page.locator(`${sel.pane.insights} .card`);
export const rankRows = (page) => page.locator(`${sel.pane.insights} .rank-row`);
export const hierarchyRows = (page) => page.locator(`${sel.pane.hierarchy} .member-list > div`);
export const hierarchyLinks = (page) => page.locator(`${sel.pane.hierarchy} .link`);
export const matrixCells = (page) => page.locator(`${sel.pane.dependencies} svg rect`);
/** Matrix cells that carry at least one package reference (clickable for a list). */
export const matrixFilledCells = (page) =>
  page.locator(`${sel.pane.dependencies} svg rect[data-w]:not([data-w="0"])`);
/** Class-level edge rows rendered underneath the matrix. */
export const depsLinkRows = (page) => page.locator(`${sel.pane.dependencies} .link-list .link`);
export const graphHint = (page) => page.locator('.graph-hint');
export const sourceRows = (page) => page.locator('.src-code tr');
export const sourceLanguageChips = (page) => page.locator('#controls button.chip');
export const linkRows = (page) => page.locator('.link-list .link');

/* ------------------------------------------------------- hierarchy pane -- */

/**
 * The hierarchy pane holds two panels: the roots list and the inheritance
 * tree. They are the pane's only `.card`s, always rendered in that order.
 */
export const hierarchyRootsCard = (page) => page.locator(`${sel.pane.hierarchy} .card`).first();
export const hierarchyRootsTitle = (page) => hierarchyRootsCard(page).locator('h3');
export const hierarchyTreeCard = (page) => page.locator(`${sel.pane.hierarchy} .card`).nth(1);
export const hierarchyTreeTitle = (page) => hierarchyTreeCard(page).locator('h3');
export const hierarchyTreeSubtitle = (page) => hierarchyTreeCard(page).locator('.sub').first();

/** The roots filter box and the two display checkboxes above the list. */
export const hierarchyFilter = (page) => page.locator(`${sel.pane.hierarchy} #hierarchy-filter`);
export const hierarchyCheckbox = (page, label) =>
  page.locator(`${sel.pane.hierarchy} label.chk`).filter({ hasText: label }).locator('input');

/** A root in the left list, found by the type name it shows. */
export const hierarchyRootLink = (page, name) =>
  hierarchyLinks(page).filter({ has: page.locator('.nm', { hasText: name }) });
export const hierarchyRootName = (link) => link.locator('.nm');

/** A row of the tree, found by the type name it shows. */
export const hierarchyRow = (page, name) =>
  hierarchyRows(page).filter({ has: page.locator('.m-name', { hasText: name }) });
export const hierarchyRowName = (row) => row.locator('.m-name');
/** The expand/collapse caret of a tree row — the row's first span. */
export const hierarchyCaret = (row) => row.locator('span').first();
/** The dashed child rows that stand for an implemented interface. */
export const hierarchyInterfaceRows = (page) =>
  hierarchyRows(page).filter({ has: page.locator('span', { hasText: '⟶' }) });

/* ------------------------------------------------------ subsystems pane -- */

export const domainOverviewCard = (page) => page.locator(`${sel.pane.subsystems} .card`).first();
export const domainOverviewTitle = (page) => domainOverviewCard(page).locator('h3');
/**
 * The overview card's children are, in order: the stacked bar, its legend and
 * then the sort controls.
 */
export const domainOverviewBar = (page) => domainOverviewCard(page).locator(':scope > div').nth(0);
export const domainOverviewLegend = (page) => domainOverviewCard(page).locator(':scope > div').nth(1);
export const domainBarSegments = (page) => domainOverviewBar(page).locator(':scope > div');
export const domainLegendItems = (page) => domainOverviewLegend(page).locator(':scope > span');
export const domainSortButton = (page, label) =>
  domainOverviewCard(page).locator('.graph-controls button').filter({ hasText: label }).first();
export const domainCardTitles = (page) => domainCards(page).locator('h3');
export const domainCardTitle = (page, index = 0) => domainCardTitles(page).nth(index);

/* -------------------------------------------------------- insights pane -- */

export const insightCard = (page, index = 0) => insightCards(page).nth(index);
/** The ranking rows inside one card — the pane holds several ranked lists. */
export const cardRankRows = (card) => card.locator('.rank-row');
export const rankRowName = (row) => row.locator('.nm');
export const rankRowValue = (row) => row.locator('.vl');
export const insightSortButton = (page, label, cardIndex = 0) =>
  insightCard(page, cardIndex).locator('.graph-controls button').filter({ hasText: label }).first();
/** The package-coupling table — the only table in the insights pane. */
export const couplingRows = (page) => page.locator(`${sel.pane.insights} table tbody tr`);
