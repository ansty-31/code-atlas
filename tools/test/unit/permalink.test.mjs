/**
 * Permalink round-trip properties, and the validation the URL path used to skip.
 *
 * The encoder and decoder were once two hand-mirrored lists — 17 branches
 * writing `URLSearchParams`, 18 reading them back — with nothing checking they
 * agreed. Adding a field to one and forgetting the other produced a link that
 * silently dropped a setting. The property test below closes that gap: it
 * generates random states across every permalinked field and requires the
 * decode of the encode to reproduce them exactly.
 *
 * Known limitation, asserted rather than assumed: list fields are joined with
 * commas, so a value containing a comma would not survive. Every value the app
 * puts in those lists (domain keys, stereotype names) is comma-free.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  PERMALINK_FIELDS,
  getPath,
  setPath,
} from '../../../src/state/schema.ts';
import { DEP_MODES, VIEW_IDS, decodeParams, encodeParams } from '../../../src/state/permalink.ts';

/* ------------------------------------------------------------- generators -- */

/** Deterministic PRNG, so a failing iteration is reproducible from its seed. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const WORDS = ['iso', 'network', 'ai', 'core', 'ui', 'lua-api', 'manager', 'packet'];

function randomValue(spec, rnd) {
  switch (spec.kind) {
    case 'enum':
      return spec.values[Math.floor(rnd() * spec.values.length)];
    case 'bool':
      return rnd() < 0.5;
    case 'int':
      return spec.min + Math.floor(rnd() * Math.min(spec.max - spec.min, 1000));
    case 'float':
      return Math.round((spec.min + rnd() * (spec.max - spec.min)) * 1000) / 1000;
    case 'string':
      return WORDS[Math.floor(rnd() * WORDS.length)];
    case 'intList': {
      const pool = [];
      for (let v = spec.itemMin; v <= spec.itemMax; v++) pool.push(v);
      return pool.filter(() => rnd() < 0.5).slice(0, spec.maxItems);
    }
    case 'stringList':
      return WORDS.filter(() => rnd() < 0.4).slice(0, spec.maxItems);
    case 'weights':
      return { ...spec.default };
  }
}

/** A state that varies only the fields a permalink is meant to carry. */
function randomState(rnd) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  for (const spec of PERMALINK_FIELDS) setPath(settings, spec.path, randomValue(spec, rnd));
  return {
    view: VIEW_IDS[Math.floor(rnd() * VIEW_IDS.length)],
    depMode: DEP_MODES[Math.floor(rnd() * DEP_MODES.length)],
    selection: {
      classId: rnd() < 0.5 ? Math.floor(rnd() * 1000) : null,
      packagePath: rnd() < 0.5 ? 'zombie.iso' : null,
      hoverId: null,
      zoom: rnd() < 0.5 ? ['p:zombie', 'p:zombie.iso'] : [],
    },
    settings,
  };
}

const baseState = () => ({
  view: 'treemap',
  depMode: 'graph',
  selection: { classId: null, packagePath: null, hoverId: null, zoom: [] },
  settings: structuredClone(DEFAULT_SETTINGS),
});

/** The part of a state a permalink is responsible for reproducing. */
function projection(state) {
  const settings = {};
  for (const spec of PERMALINK_FIELDS) setPath(settings, spec.path, getPath(state.settings, spec.path));
  return {
    view: state.view,
    depMode: state.depMode,
    zoom: state.selection.zoom,
    classId: state.selection.classId,
    packagePath: state.selection.packagePath,
    settings,
  };
}

/* ------------------------------------------------------------- properties -- */

test('a permalink round-trips every permalinked field', () => {
  const rnd = lcg(20240914);
  for (let i = 0; i < 400; i++) {
    const state = randomState(rnd);
    const encoded = encodeParams(state);
    const decoded = decodeParams(new URLSearchParams(encoded), baseState());
    assert.deepEqual(projection(decoded), projection(state), `iteration ${i} — #${encoded}`);
  }
});

test('defaults produce a link that carries only the view', () => {
  const params = encodeParams(baseState());
  assert.equal(params.toString(), 'v=treemap');
});

test('a fully-populated state uses the documented short keys', () => {
  const rnd = lcg(7);
  const state = randomState(rnd);
  state.view = 'dependencies';
  state.depMode = 'matrix';
  state.selection.zoom = ['p:zombie'];
  state.selection.classId = 42;
  state.settings.colorMode = 'complexity';
  state.settings.groupBy = 'stereotype';
  state.settings.theme = 'light';
  const keys = [...encodeParams(state).keys()].sort();

  for (const expected of ['v', 'dm', 'z', 'sel', 'c', 'g', 't']) {
    assert.ok(keys.includes(expected), `missing "${expected}" in ${keys.join(',')}`);
  }
  // Non-permalinked preferences must never leak into a link.
  for (const absent of ['palette', 'labelMode', 'sort', 'padding', 'minShare', 'sidebar', 'inspector', 'weights']) {
    assert.ok(!keys.includes(absent), `"${absent}" should not travel in a permalink`);
  }
});

/* ------------------------------------------------------------ validation -- */

/**
 * Regression guard for a defect found while splitting the old test suite: the
 * URL path assigned `colorMode`, `groupBy` and `layout` straight from the query
 * string with a bare cast, while the storage path validated the same three
 * fields against allow-lists. A malformed link produced a state no control could
 * reach — the treemap fell back to its default colouring while the legend
 * switched on `colorMode` and listed domains, so the two disagreed.
 */
test('unrecognised enum values in a permalink fall back to their defaults', () => {
  const params = new URLSearchParams('c=garbage&g=garbage&l=garbage&m=not-a-metric&t=chartreuse');
  const decoded = decodeParams(params, baseState());
  assert.equal(decoded.settings.colorMode, 'domain');
  assert.equal(decoded.settings.groupBy, 'package');
  assert.equal(decoded.settings.layout, 'squarify');
  assert.equal(decoded.settings.sizeMetric, 'code');
  assert.equal(decoded.settings.theme, 'dark');
});

test('numeric permalink values are range-checked', () => {
  const decoded = decodeParams(new URLSearchParams('d=99&min=-5'), baseState());
  assert.equal(decoded.settings.depthLimit, 0, 'out-of-range depth limit was accepted');
  assert.equal(decoded.settings.filters.minCode, 0, 'negative minCode was accepted');
});

test('unrecognised view and dependency mode are ignored', () => {
  const decoded = decodeParams(new URLSearchParams('v=nowhere&dm=sideways'), baseState());
  assert.equal(decoded.view, 'treemap');
  assert.equal(decoded.depMode, 'graph');
});

test('a non-numeric selection id is ignored', () => {
  const decoded = decodeParams(new URLSearchParams('sel=IsoPlayer'), baseState());
  assert.equal(decoded.selection.classId, null);
});

test('a class or package the dataset does not contain is ignored', () => {
  const lookup = { hasClass: (id) => id === 7, hasPackage: (path) => path === 'zombie.iso' };

  const ok = decodeParams(new URLSearchParams('sel=7&pkg=zombie.iso'), baseState(), lookup);
  assert.equal(ok.selection.classId, 7);
  assert.equal(ok.selection.packagePath, 'zombie.iso');

  const stale = decodeParams(new URLSearchParams('sel=999&pkg=zombie.gone'), baseState(), lookup);
  assert.equal(stale.selection.classId, null, 'a stale bookmark kept an unknown class id');
  assert.equal(stale.selection.packagePath, null, 'a stale bookmark kept an unknown package');
});

test('decoding does not mutate the state it builds on', () => {
  const base = baseState();
  const before = structuredClone(base);
  decodeParams(new URLSearchParams('t=light&c=kind&z=p:zombie&dom=iso'), base);
  assert.deepEqual(base, before, 'decodeParams mutated its base state');
});
