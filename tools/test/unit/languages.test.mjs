import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { LANGUAGES, languageForPath, selectLanguages } from '../../../src/shared/languages.mjs';
import { initParser } from '../../lib/parsers.mjs';
import { parseSourceFileWith } from '../../lib/source-ast.mjs';
import { runExtraction } from '../../extract.mjs';
import { applyFilters } from '../../../src/state/query.ts';
import { buildDefaults } from '../../../src/state/schema.ts';

test('language registry validates selections and recognises headers', () => {
  assert.equal(languageForPath('test.PY').id, 'python');
  assert.equal(languageForPath('test.c').id, 'c');
  assert.equal(languageForPath('test.h', 'c').id, 'c');
  assert.equal(languageForPath('test.hpp').id, 'cpp');
  assert.deepEqual(selectLanguages('python,cpp').map((language) => language.id), ['python', 'cpp']);
  assert.throws(() => selectLanguages('typo'), /Unknown language/);
});

test('Python/C++ extraction keeps real structure, exact totals and language boundaries', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-mixed-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-data-'));
  t.after(() => { fs.rmSync(root, { recursive: true }); fs.rmSync(out, { recursive: true }); });
  const sources = {
    'py/base.py': 'class Base:\n    pass\n',
    'py/app.py': `from .base import Base
# class Phantom: pass
class Worker(Base):
    """文档 with class Phantom in a string."""
    value: int = 2
    class Nested:
        pass
    async def run(self, n: int) -> int:
        if n and self.value:
            return n
        return 0

def standalone(n):
    return n
`,
    'include/base.hpp': '#pragma once\nclass Base {\npublic:\n virtual int run(int n) = 0;\n};\n',
    'src/app.cpp': `#include "base.hpp"
namespace demo {
template<typename T>
class Worker : public Base {
public:
  int first, second;
  int run(int n) override {
    if (n && first) return n;
    return 0;
  }
};
int standalone(int n) { return n; }
}
`,
    'src/one-line.cpp': 'struct A {}; struct B {};\n',
    'src/helper.c': 'int helper(int n) { return n; }\n',
    'java/Legacy.java': 'package legacy; public class Legacy { public int run() { return 1; } }\n',
    '.gitignore': 'ignored/\n',
    'ignored/skip.py': 'class Ignored: pass',
    'node_modules/skip.py': 'class Dependency: pass',
  };
  for (const [name, source] of Object.entries(sources)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), source);
  }
  execFileSync('git', ['init', '-q', root]);
  const result = await runExtraction({ src: root, out, quiet: true });
  assert.equal(result.files, 7);
  const read = (name) => JSON.parse(fs.readFileSync(path.join(out, name)));
  const { columns, rows } = read('classes.json');
  const entities = rows.map((row) => Object.fromEntries(columns.map((name, index) => [name, row[index]])));
  assert.deepEqual(read('meta.json').languages.sort(), ['c', 'cpp', 'java', 'python']);
  assert.ok(!entities.some((entity) => ['Phantom', 'Ignored', 'Dependency'].includes(entity.name)));
  const find = (language, name) => entities.find((entity) => entity.language === language && entity.name === name);
  for (const language of ['python', 'cpp']) {
    const worker = find(language, 'Worker');
    assert.deepEqual(worker.superIds, [find(language, 'Base').id]);
    assert.equal(worker.complexity, 3);
    assert.ok(worker.fqn.includes(worker.path.slice(worker.path.indexOf('/') + 1)));
  }
  assert.ok(find('python', 'Worker').doc.includes('文档'));
  assert.equal(find('cpp', 'Worker').fields, 2);
  assert.equal(find('python', 'Nested').parentType, find('python', 'Worker').fqn);
  const deps = read('deps-classes.json');
  assert.ok(deps.some(([from, to]) => from === find('python', 'app.py').id && to === find('python', 'base.py').id));
  assert.ok(deps.some(([from, to]) => from === find('cpp', 'app.cpp').id && to === find('cpp', 'base.hpp').id));
  for (const language of ['python', 'cpp', 'c']) {
    for (const [name, source] of Object.entries(sources)) {
      if (languageForPath(name)?.id !== language) continue;
      if (name.startsWith('ignored/') || name.startsWith('node_modules/')) continue;
      const own = entities.filter((entity) => entity.path.endsWith('/' + name));
      assert.equal(own.reduce((sum, entity) => sum + entity.loc, 0), source.split('\n').length, name);
      assert.equal(own.reduce((sum, entity) => sum + entity.bytes, 0), Buffer.byteLength(source), name);
    }
  }
  const settings = buildDefaults();
  settings.filters.languages = ['python'];
  const allowed = applyFilters({ classes: entities.map((entity) => ({ ...entity, language: entity.language, pkg: entity.package, domain: entity.package, luaExposed: false })) }, settings);
  assert.equal(allowed.ids.size, entities.filter((entity) => entity.language === 'python').length);
  await runExtraction({ src: root, out, quiet: true, languages: 'python', noRefs: true });
  assert.deepEqual(read('meta.json').languages, ['python']);
  assert.equal(read('meta.json').capabilities.memberReferences, false);
  assert.equal(fs.existsSync(path.join(out, 'refs/meta.json')), false, 'old Java reference data survived a project change');
  assert.equal(fs.existsSync(path.join(out, 'members/include.json')), false, 'old language shards survived a project change');
});

test('malformed source is reported and a later file can still be parsed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-parse-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const { parser } = await initParser(LANGUAGES.find((language) => language.id === 'python'));
  const file = path.join(root, 'bad.py');
  fs.writeFileSync(file, 'class Broken(:\n    pass\n');
  assert.ok(parseSourceFileWith(parser, file, 'root/bad.py', 'python').file.parseErrors > 0);
  fs.writeFileSync(file, 'def valid():\n    return "<script>文</script>"\n');
  const parsed = parseSourceFileWith(parser, file, 'root/good.py', 'python');
  assert.equal(parsed.file.parseErrors, 0);
  assert.equal(parsed.types[0].members[0].name, 'valid');
});


test('Python aliases and src layout resolve without guessing across modules', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-import-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-import-data-'));
  t.after(() => { fs.rmSync(root, { recursive: true }); fs.rmSync(out, { recursive: true }); });
  for (const [name, source] of Object.entries({
    'src/app/base.py': 'class Base:\n    pass\n',
    'src/app/other.py': 'class Base:\n    pass\n',
    'src/app/main.py': 'from .base import Base as Parent\nimport app.base as model\nclass First(Parent):\n    pass\nclass Second(model.Base):\n    pass\n',
  })) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), source);
  }
  await runExtraction({ src: root, out, quiet: true });
  const { columns, rows } = JSON.parse(fs.readFileSync(path.join(out, 'classes.json')));
  const entities = rows.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
  const base = entities.find((entity) => entity.name === 'Base' && entity.path.endsWith('/base.py'));
  for (const name of ['First', 'Second']) assert.deepEqual(entities.find((entity) => entity.name === name).superIds, [base.id]);
});

test('C++ fixture preserves templates, multiple bases, overloads and separate definitions', async (t) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-cpp-data-'));
  t.after(() => fs.rmSync(out, { recursive: true }));
  await runExtraction({ src: 'tools/test/fixtures/mixed', out, quiet: true });
  const read = (name) => JSON.parse(fs.readFileSync(path.join(out, name)));
  const { columns, rows } = read('classes.json');
  const entities = rows.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
  const tracker = entities.find((entity) => entity.name === 'Tracker');
  assert.deepEqual(tracker.superIds.map((id) => entities[id].name), ['PositionSource', 'Resettable']);
  assert.match(tracker.fqn, /navigation.Tracker$/);
  const members = read('members/include.json')[tracker.id].members;
  assert.deepEqual(members.filter((member) => member[1] === 'update').map((member) => member[3]), [['int value'], ['double value']]);
  assert.equal(entities.find((entity) => entity.name === 'model.cpp').methods, 3);
  assert.equal(read('meta.json').parseErrors.files, 0);
});
