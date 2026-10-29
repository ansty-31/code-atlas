/**
 * `applyFilters` and `searchAtlas` against a synthetic atlas.
 *
 * These are the functions behind every chip, the query box and the ranked search
 * dropdown. The browser suite exercises them through the UI; these cases pin the
 * logic itself — each filter's boundary, how they combine, and the distinction
 * between "passes every filter" and "matched the text query", which the
 * highlight feature depends on.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, buildDefaults } from '../../../src/state/schema.ts';
import { applyFilters, searchAtlas } from '../../../src/state/query.ts';
import { makeAtlas } from '../synthetic-atlas.mjs';

const atlas = makeAtlas();

/** Settings with the given filter fields applied. */
const withFilters = (filters) => {
  const settings = buildDefaults();
  Object.assign(settings.filters, filters);
  return settings;
};

const idsOf = (filters) => [...applyFilters(atlas, withFilters(filters)).ids].sort((a, b) => a - b);

/** `Alpha` (0), `Beta` (1), `AlphaBeta` (2), `Gamma` (3). */
const ALL = [0, 1, 2, 3];

test('no filters admits everything', () => {
  assert.deepEqual(idsOf({}), ALL);
  assert.equal(applyFilters(atlas, buildDefaults()).total, 4);
  assert.deepEqual(Object.keys(applyFilters(atlas, buildDefaults())).sort(), ['ids', 'total']);
});

test('only @UsedFromLua types', () => {
  assert.deepEqual(idsOf({ luaOnly: true }), [1]);
});

test('by functional domain', () => {
  assert.deepEqual(idsOf({ domains: ['iso'] }), [1, 2]);
  assert.deepEqual(idsOf({ domains: ['core', 'network'] }), [0, 3]);
});

test('by declaration kind', () => {
  assert.deepEqual(idsOf({ kinds: [0] }), [0, 3], 'classes');
  assert.deepEqual(idsOf({ kinds: [1, 2] }), [1, 2], 'interfaces and enums');
});

test('by stereotype', () => {
  assert.deepEqual(idsOf({ stereotypes: ['manager'] }), [3]);
});

test('by minimum code lines', () => {
  assert.deepEqual(idsOf({ minCode: 50 }), [0, 2]);
  assert.deepEqual(idsOf({ minCode: 3 }), [0, 1, 2], 'only Gamma (2 lines) drops out');
  assert.deepEqual(idsOf({ minCode: 101 }), [], 'a threshold above every type');
});

test('filters combine conjunctively', () => {
  assert.deepEqual(idsOf({ domains: ['iso'], kinds: [2] }), [2]);
  assert.deepEqual(idsOf({ domains: ['iso'], kinds: [0] }), [], 'no class in iso');
  assert.deepEqual(idsOf({ luaOnly: true, minCode: 10 }), [], 'Beta is lua-exposed but only 5 lines');
});

test('the text query matches name, fqn, package and annotations', () => {
  assert.deepEqual(idsOf({ query: 'Alpha' }), [0, 2], 'name substring');
  assert.deepEqual(idsOf({ query: 'zombie.network' }), [3], 'package');
  assert.deepEqual(idsOf({ query: 'usedfromlua' }), [1, 3], 'annotation, case-insensitively');
});

test('the text query matches member names when a member index is supplied', () => {
  const memberNames = new Map([[0, ['recalculate', 'gethealth']]]);
  const settings = withFilters({ query: 'recalculate' });

  assert.deepEqual([...applyFilters(atlas, settings).ids], [], 'members are invisible without the index');
  assert.deepEqual([...applyFilters(atlas, settings, memberNames).ids], [0]);
});

test('a text query composes with the other filters', () => {
  assert.deepEqual(idsOf({ query: 'Alpha' }), [0, 2], 'both name matches');
  assert.deepEqual(idsOf({ query: 'Alpha', minCode: 60 }), [0], 'AlphaBeta is only 50 lines');
  assert.deepEqual(idsOf({ query: 'Alpha', domains: ['iso'] }), [2], 'Alpha is in core');
});

test('an empty or whitespace query is not a query', () => {
  const settings = buildDefaults();
  settings.filters.query = '   ';
  assert.deepEqual([...applyFilters(atlas, settings).ids], ALL);
});

/* ------------------------------------------------------------------ search -- */

test('an empty query returns nothing', () => {
  assert.deepEqual(searchAtlas(atlas, ''), []);
  assert.deepEqual(searchAtlas(atlas, '  '), []);
});

test('an exact name outranks a prefix, which outranks a substring', () => {
  const hits = searchAtlas(atlas, 'Alpha');
  const byName = new Map(hits.map((h) => [h.name, h.score]));
  assert.ok(byName.get('Alpha') > byName.get('AlphaBeta'), `scores: ${JSON.stringify([...byName])}`);
});

test('name matches outrank fully-qualified-name matches', () => {
  const hits = searchAtlas(atlas, 'Gamma');
  assert.equal(hits[0].name, 'Gamma');
  assert.equal(hits[0].type, 'class');
  assert.equal(hits[0].id, 3);
});

test('a package path produces a package hit', () => {
  const hits = searchAtlas(atlas, 'zombie.iso');
  const pkg = hits.find((h) => h.type === 'package');
  assert.ok(pkg, `no package hit in ${JSON.stringify(hits.map((h) => h.name))}`);
  assert.equal(pkg.sub, 'zombie.iso');
  assert.equal(pkg.meta, '2 types');
});

test('results are ordered by score and capped by the limit', () => {
  const hits = searchAtlas(atlas, 'a', 2);
  assert.equal(hits.length, 2, 'limit not applied');
  for (let i = 1; i < hits.length; i++) {
    assert.ok(hits[i - 1].score >= hits[i].score, 'results are not sorted by score');
  }
});

test('a query that matches nothing returns an empty list', () => {
  assert.deepEqual(searchAtlas(atlas, 'zzzznotpresent'), []);
});

test('the defaults the search reads are the schema defaults', () => {
  // Guards against the fixture and the schema drifting apart.
  assert.equal(DEFAULT_SETTINGS.filters.query, '');
  assert.deepEqual(DEFAULT_SETTINGS.filters.domains, []);
});
