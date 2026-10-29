/**
 * The storage codec: a wrong value in any field must fall back to its default
 * and say so, and the payload must repair itself on the next write.
 *
 * The per-field cases below are generated from `SETTINGS_FIELDS`, so a new
 * setting is covered the moment it is declared. The old hand-written validator
 * had ~20 branch paths that nothing exercised directly — the browser suite only
 * checked one aggregate "malformed payload" scenario.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, SETTINGS_FIELDS, getPath, setPath } from '../../../src/state/schema.ts';
import {
  SETTINGS_KEY,
  SETTINGS_VERSION,
  decodeSettings,
  encodeSettings,
  loadSettings,
  saveSettings,
} from '../../../src/state/persist.ts';

/* --------------------------------------------------------------- helpers -- */

function fakeStorage(initial) {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, v),
    keys: () => [...map.keys()],
  };
}

const freshReport = () => ({ status: 'ok', repairs: [], version: SETTINGS_VERSION });

/** A payload with `value` at `path`. */
function payloadWith(path, value) {
  const payload = { version: SETTINGS_VERSION };
  setPath(payload, path, value);
  return payload;
}

/** A value of the wrong type for each kind of field. */
const WRONG = {
  enum: 42,
  bool: 'yes',
  int: 'deep',
  float: 9e9,
  string: 123,
  intList: 'all',
  stringList: 'not-an-array',
  weights: 'nope',
};

/* ------------------------------------------------- per-field repair cases -- */

for (const spec of SETTINGS_FIELDS) {
  test(`${spec.path}: a malformed value falls back and is reported`, () => {
    const report = freshReport();
    const decoded = decodeSettings(payloadWith(spec.path, WRONG[spec.kind]), report);

    assert.deepEqual(
      getPath(decoded, spec.path),
      spec.default,
      `${spec.path} did not fall back to its default`
    );
    assert.ok(
      report.repairs.some((r) => r.startsWith(spec.path)),
      `no repair mentioned ${spec.path}: ${JSON.stringify(report.repairs)}`
    );
  });
}

/* ------------------------------------------------------------ whole payload -- */

test('absent fields keep their defaults silently', () => {
  const report = freshReport();
  const decoded = decodeSettings({ version: SETTINGS_VERSION }, report);
  assert.deepEqual(decoded, DEFAULT_SETTINGS);
  assert.deepEqual(report.repairs, [], 'an absent field should not be reported as a repair');
});

test('a non-object payload falls back wholesale', () => {
  const report = freshReport();
  assert.deepEqual(decodeSettings('just a string', report), DEFAULT_SETTINGS);
  assert.equal(report.repairs.length, 1);
  assert.match(report.repairs[0], /root: not an object/);
});

test('extra keys in the payload are ignored', () => {
  const report = freshReport();
  const decoded = decodeSettings({ version: SETTINGS_VERSION, somethingElse: true }, report);
  assert.deepEqual(decoded, DEFAULT_SETTINGS);
  assert.deepEqual(report.repairs, []);
  assert.equal('somethingElse' in decoded, false);
});

test('list fields drop invalid entries and say how many', () => {
  const report = freshReport();
  const decoded = decodeSettings(
    payloadWith('filters.kinds', [0, 2, 0, 'x', 99, null]),
    report
  );
  assert.deepEqual(decoded.filters.kinds, [0, 2], 'not deduplicated or range-filtered');
  assert.ok(report.repairs.some((r) => /filters\.kinds: dropped 4 invalid/.test(r)), report.repairs.join(' | '));
});

test('oversized lists are truncated', () => {
  const report = freshReport();
  const many = Array.from({ length: 300 }, (_, i) => `pkg${i}`);
  const decoded = decodeSettings(payloadWith('filters.domains', many), report);
  assert.equal(decoded.filters.domains.length, 200);
});

test('weights are validated per key', () => {
  const report = freshReport();
  const decoded = decodeSettings(payloadWith('weights', { code: 0.4, complexity: 'lots', methods: 5 }), report);
  assert.equal(decoded.weights.code, 0.4, 'a valid weight was rejected');
  assert.equal(decoded.weights.complexity, 0, 'an invalid weight did not fall back');
  assert.equal(decoded.weights.methods, 0, 'an out-of-range weight did not fall back');
  assert.ok(report.repairs.some((r) => r.startsWith('weights.complexity')));
  assert.ok(report.repairs.some((r) => r.startsWith('weights.methods')));
});

/* ---------------------------------------------------------------- storage -- */

test('a save/load round trip preserves every setting', () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.theme = 'light';
  settings.colorMode = 'complexity';
  settings.depthLimit = 4;
  settings.filters.domains = ['iso', 'network'];
  settings.filters.kinds = [0, 1];
  settings.filters.query = 'player';
  settings.filters.luaOnly = true;
  settings.weights.complexity = 0.35;

  const storage = fakeStorage();
  saveSettings(settings, { status: 'missing', repairs: [], version: SETTINGS_VERSION }, storage);
  const { settings: restored, report } = loadSettings(storage);

  assert.deepEqual(restored, settings);
  assert.equal(report.status, 'ok');
  assert.deepEqual(report.repairs, []);
});

test('a malformed payload is repaired and then written back cleanly', () => {
  const storage = fakeStorage({
    [SETTINGS_KEY]: JSON.stringify({
      version: 99,
      theme: 42,
      sizeMetric: 'not-a-metric',
      colorMode: { nope: true },
      groupBy: 'nonsense',
      layout: 7,
      depthLimit: 'deep',
      padding: 'lots',
      minShare: -3,
      sort: 'sideways',
      sidebar: 'yes',
      weights: { code: 'a', complexity: null },
      filters: { query: 123, kinds: 'all', stereotypes: 'x', domains: 'iso', luaOnly: 'yes', minCode: -5 },
    }),
  });

  const first = loadSettings(storage);
  assert.equal(first.report.status, 'repaired');
  assert.ok(first.report.repairs.length > 10, `only ${first.report.repairs.length} repairs reported`);
  assert.ok(first.report.repairs.some((r) => r.includes('payload version 99')));
  assert.deepEqual(first.settings, DEFAULT_SETTINGS, 'every bad field should have fallen back');

  // Writing the result back repairs storage, so the next load is clean.
  saveSettings(first.settings, first.report, storage);
  const second = loadSettings(storage);
  assert.equal(second.report.status, 'ok');
  assert.deepEqual(second.report.repairs, []);
  assert.deepEqual(second.settings, DEFAULT_SETTINGS);
});

test('the stored payload carries the schema version', () => {
  const encoded = encodeSettings(DEFAULT_SETTINGS);
  assert.equal(encoded.version, SETTINGS_VERSION);
  assert.equal(encoded.theme, 'dark');
});

test('unreadable storage degrades without throwing', () => {
  assert.equal(loadSettings(null).report.status, 'unavailable');
  assert.deepEqual(loadSettings(null).settings, DEFAULT_SETTINGS);

  const throwing = {
    getItem() { throw new Error('storage denied'); },
    setItem() { throw new Error('storage denied'); },
  };
  assert.equal(loadSettings(throwing).report.status, 'unavailable');
  assert.equal(saveSettings(DEFAULT_SETTINGS, freshReport(), throwing).status, 'unavailable');
  assert.equal(saveSettings(DEFAULT_SETTINGS, freshReport(), null).status, 'unavailable');
});

test('corrupt JSON is treated as unreadable', () => {
  const { report, settings } = loadSettings(fakeStorage({ [SETTINGS_KEY]: '{not json' }));
  assert.equal(report.status, 'unavailable');
  assert.deepEqual(settings, DEFAULT_SETTINGS);
});
