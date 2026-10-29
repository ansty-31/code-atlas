/**
 * The application shell.
 *
 * This is the markup that used to sit in `index.html`. It is rendered from JSX
 * now so the shell can take part in the reactive tree as the panels are
 * migrated; for the moment it renders once and the existing imperative modules
 * drive the containers by id, exactly as before.
 *
 * The ids and class names are a contract: `styles.css` targets them, and the
 * browser suite locates them. `tools/test/locators.mjs` is the other half of
 * that contract.
 */

import { msg } from '../i18n';

export function App() {
  return (
    <>
      <div id="app">
        <header class="topbar">
          <div class="brand">
            <span class="brand-mark" aria-hidden="true" />
            <span class="brand-text">
              Code<b>Atlas</b>
            </span>
            <span class="brand-sub" id="brand-sub">
              {msg('loading…')}
            </span>
          </div>

          {/* The tabs are filled by `buildTabs()`, which owns the click wiring. */}
          <nav class="tabs" id="tabs" role="tablist" aria-label={msg('Views')} />

          <div class="topbar-right">
            <select
              id="language"
              class="language-select"
              aria-label={msg('Language')}
              title={msg('Language')}
            >
              <option value="en" lang="en">
                English
              </option>
              <option value="zh-CN" lang="zh-CN">
                简体中文
              </option>
            </select>

            <div class="search-wrap">
              <input
                id="search"
                class="search"
                type="search"
                placeholder={msg('Search classes, packages, members…  (/)')}
                autocomplete="off"
                spellcheck="false"
                aria-label={msg('Search')}
              />
              <div id="search-results" class="search-results" hidden />
            </div>

            <button id="btn-settings" class="icon-btn" title={msg('Customize (S)')} aria-label={msg('Customize')}>
              ⚙
            </button>
            <button id="btn-theme" class="icon-btn" title={msg('Toggle theme (T)')} aria-label={msg('Toggle theme')}>
              ◐
            </button>
            <button id="btn-help" class="icon-btn" title={msg('Help (?)')} aria-label={msg('Help')}>
              ?
            </button>
          </div>
        </header>

        <div class="workspace">
          <aside class="sidebar" id="sidebar">
            <section class="panel" id="panel-controls">
              <h2>{msg('View controls')}</h2>
              <div id="controls" />
            </section>
            <section class="panel" id="panel-legend">
              <h2>{msg('Legend')}</h2>
              <div id="legend" />
            </section>
          </aside>

          <main class="stage" id="stage">
            <div class="stage-head">
              <nav class="breadcrumbs" id="breadcrumbs" aria-label={msg('Zoom path')} />
              <div class="stage-actions" id="stage-actions" />
            </div>
            <div class="canvas-wrap" id="canvas-wrap">
              <canvas id="canvas" />
              <svg id="overlay" class="overlay" />
              <div id="tooltip" class="tooltip" hidden />
              <div id="empty-state" class="empty-state" hidden />
              <div id="stage-message" class="stage-message" hidden />
            </div>
            <div class="stage-foot" id="stage-foot" />
          </main>

          <aside class="inspector" id="inspector">
            <div id="inspector-body" class="inspector-body" />
          </aside>
        </div>

        <footer class="statusbar" id="statusbar" />
      </div>

      {/* Modals (help, source viewer) mount here. */}
      <div id="modal-root" />
    </>
  );
}
