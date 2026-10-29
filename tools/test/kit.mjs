/**
 * The test kit: a tiny spec/test registry with per-test failure isolation.
 *
 * Why not `node:test`: the specs share one browser, one server and one booted
 * page per spec file (booting the app takes ~1.5s), and `node --test` runs each
 * file in its own process, which would pay that cost per file and lose the
 * shared fixture. The tradeoff is this ~120-line harness.
 *
 * The important property it buys over the old linear script: **a failing test
 * does not abort the spec, and an aborting spec does not take down the run.**
 * Previously one missing element threw, the process died, and every result the
 * run had gathered so far was lost because results were only printed at the
 * end.
 */

import assert from 'node:assert/strict';
import { openApp } from './harness.mjs';
import { screenshot, settle } from './probes.mjs';

/** Collects results across specs and knows how to report them. */
export function createRecorder({ onResult } = {}) {
  const results = [];
  return {
    results,
    add(result) {
      results.push(result);
      onResult?.(result);
      return result;
    },
    failures: () => results.filter((r) => !r.ok && !r.todo),
    passed: () => results.filter((r) => r.ok).length,
    todos: () => results.filter((r) => r.todo),
  };
}

/**
 * Build the `t` object handed to a spec's `run(t)`.
 *
 * The primary page is booted and ready; `t.test()` records one assertion group.
 * A test body may `return` a string to be shown as its detail in the report —
 * numbers measured during the run are worth keeping visible on success, not
 * just on failure.
 */
export async function createTestContext({ browser, spec, url, shots, recorder }) {
  const primary = await openApp(browser, {
    url,
    locale: spec.locale ?? 'en-US',
    viewport: spec.viewport,
    search: spec.search,
  });
  const extras = [];

  const t = {
    page: primary.page,
    errors: primary.errors,
    url,
    browser,
    assert,

    /** Run one named assertion group. Returns true when it passed. */
    async test(name, fn) {
      const started = Date.now();
      try {
        const detail = await fn();
        recorder.add({
          spec: spec.name,
          name,
          ok: true,
          detail: typeof detail === 'string' ? detail : '',
          ms: Date.now() - started,
        });
        return true;
      } catch (err) {
        recorder.add({
          spec: spec.name,
          name,
          ok: false,
          detail: err?.message ?? String(err),
          ms: Date.now() - started,
        });
        return false;
      }
    },

    /**
     * A test for behaviour that is currently broken.
     *
     * Expected failures are recorded as TODO and do not fail the run, but they
     * stay visible in the output. If the body *passes*, it is reported as XPASS
     * so the test gets promoted to `t.test()` when the defect is fixed.
     */
    async todo(name, fn) {
      const started = Date.now();
      try {
        const detail = await fn();
        recorder.add({
          spec: spec.name,
          name,
          ok: true,
          todo: true,
          detail: `unexpectedly passes — promote to t.test()${typeof detail === 'string' && detail ? ` (${detail})` : ''}`,
          ms: Date.now() - started,
        });
        return true;
      } catch (err) {
        recorder.add({
          spec: spec.name,
          name,
          ok: false,
          todo: true,
          detail: err?.message ?? String(err),
          ms: Date.now() - started,
        });
        return false;
      }
    },

    /** Record a failure unconditionally — for `else` branches of a guard. */
    fail(name, detail) {
      recorder.add({ spec: spec.name, name, ok: false, detail, ms: 0 });
    },

    /** Open a second, independent page (own context, own storage). */
    async newApp(opts = {}) {
      const app = await openApp(browser, { url, ...opts });
      extras.push(app);
      return app;
    },

    /** Errors collected since `mark = t.errors.length`. */
    errorsSince(mark) {
      return primary.errors.slice(mark);
    },

    async shot(name, opts = {}) {
      if (!shots.enabled) return;
      await screenshot(t.page, shots.dir, name, opts);
    },

    /**
     * Switch the UI language. The app persists state and navigates, so wait for
     * the navigation rather than a fixed delay.
     */
    async switchLanguage(code) {
      await t.page.locator('#language').selectOption(code);
      await t.page.waitForURL(`**lang=${code}**`);
      await t.page.waitForFunction(() => !!window.zombieAtlas, null, { timeout: 20000 });
      await settle(t.page, 600);
    },

    settle: (ms) => settle(t.page, ms),

    async dispose() {
      for (const app of extras) await app.close();
      await primary.close();
    },
  };

  return t;
}
