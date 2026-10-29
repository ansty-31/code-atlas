/**
 * Test-environment bootstrap for `node --test`.
 *
 * Two jobs:
 *
 * 1. **Module resolution.** Node strips types from `.ts` files natively, but its
 *    ESM resolver requires an explicit file extension, while the app is written
 *    the way Vite expects (`from './schema'`). The app is never executed by Node
 *    — it is always bundled first — so the workaround belongs here in the test
 *    tooling rather than as `.ts` extensions scattered through `src/`. The same
 *    hook serves `.json` as a module, because `i18n.ts` imports its catalogs the
 *    way Vite expects and Node only accepts that with an import attribute.
 *
 * 2. **A minimal platform.** `i18n.ts` reads `location.href` to resolve the
 *    locale at import time, so any module that can produce a translated string
 *    needs this much of a browser to load at all. These are stubs for the
 *    platform, not behaviour: nothing here changes what the app does.
 *
 * Usage: node --import ./tools/test/ts-resolve.mjs --test tools/test/unit
 */

import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- platform --
globalThis.location ??= {
  href: 'http://localhost/',
  search: '',
  pathname: '/',
  hash: '',
  assign() {},
};
globalThis.localStorage ??= {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
};

// -------------------------------------------------------------- resolution --
/** Files by which an extensionless relative import may resolve. */
const SUFFIXES = ['.ts', '/index.ts'];

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
      const base = new URL(specifier, context.parentURL);
      for (const suffix of SUFFIXES) {
        const candidate = new URL(`${base.href}${suffix}`);
        if (existsSync(fileURLToPath(candidate))) {
          return { url: candidate.href, shortCircuit: true };
        }
      }
    }
    return nextResolve(specifier, context);
  },

  /**
   * `i18n.ts` imports its catalogs as plain `./locales/en.json`, which Vite
   * handles but Node only accepts with an explicit import attribute. Serving the
   * file as a module keeps the application source unchanged and lets unit tests
   * import anything that indirectly touches a translated string.
   */
  load(url, context, nextLoad) {
    if (url.endsWith('.json')) {
      const source = readFileSync(fileURLToPath(url), 'utf8');
      return {
        format: 'module',
        source: `export default JSON.parse(${JSON.stringify(source)});`,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});
