/**
 * The settings schema is the single source of truth, so it has to be complete.
 *
 * The valuable tests here are the two coverage directions: every declared field
 * must resolve in the defaults, and every value in the defaults must be covered
 * by a declared field. Together they fail the moment someone adds a setting to
 * the `Settings` type (or to `DEFAULT_SETTINGS`) without a schema entry — the
 * drift that the old hand-maintained validator could not detect.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  PERMALINK_FIELDS,
  SETTINGS_FIELDS,
  buildDefaults,
  getPath,
} from '../../../src/state/schema.ts';

const specPaths = new Set(SETTINGS_FIELDS.map((f) => f.path));

/**
 * Leaf paths in `obj` that no field spec covers. Descent stops at a covered
 * path, so the `weights` object counts as one field rather than six.
 */
function uncoveredPaths(obj, prefix = '') {
  const out = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (specPaths.has(path)) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out.push(...uncoveredPaths(value, path));
    } else {
      out.push(path);
    }
  }
  return out;
}

test('every declared field resolves in the defaults', () => {
  const missing = SETTINGS_FIELDS.filter((f) => getPath(DEFAULT_SETTINGS, f.path) === undefined).map((f) => f.path);
  assert.deepEqual(missing, [], 'a spec points at a path that has no default');
});

test('every default value is covered by a declared field', () => {
  const uncovered = uncoveredPaths(DEFAULT_SETTINGS);
  assert.deepEqual(uncovered, [], 'these settings would never be validated or persisted');
});

test('buildDefaults returns an independent copy', () => {
  const a = buildDefaults();
  a.filters.domains.push('mutated');
  a.filters.kinds.push(2);
  a.weights.code = 0.5;
  a.theme = 'light';

  const b = buildDefaults();
  assert.deepEqual(b.filters.domains, [], 'a default array was shared between copies');
  assert.deepEqual(b.filters.kinds, []);
  assert.equal(b.weights.code, 1, 'a default weight was shared between copies');
  assert.equal(b.theme, 'dark');
  assert.deepEqual(DEFAULT_SETTINGS.filters.domains, [], 'the module default itself was mutated');
});

test('permalink keys are unique and short', () => {
  const keys = PERMALINK_FIELDS.map((f) => f.key);
  assert.equal(new Set(keys).size, keys.length, `duplicate permalink key in ${keys.join(',')}`);
  for (const key of keys) {
    assert.ok(key.length <= 3, `permalink key "${key}" is not short`);
  }
});

test('the declared field set covers the documented settings', () => {
  // Spot-check the fields whose absence would silently drop a user preference.
  const required = [
    'theme', 'sizeMetric', 'colorMode', 'groupBy', 'layout', 'palette', 'labelMode', 'sort',
    'depthLimit', 'padding', 'minShare', 'showMembers', 'sidebar', 'inspector', 'weights',
    'filters.query', 'filters.kinds', 'filters.stereotypes', 'filters.domains', 'filters.luaOnly', 'filters.minCode',
  ];
  const missing = required.filter((p) => !specPaths.has(p));
  assert.deepEqual(missing, []);
});
