import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Parser, Language } from 'web-tree-sitter';

const require = createRequire(import.meta.url);
const parsers = new Map();

export function grammarAsset(language) {
  const file = require.resolve(`${language.grammar}/${language.grammar}.wasm`);
  return { name: `${language.grammar}.wasm`, file };
}

export function initParser(language) {
  if (!parsers.has(language.id)) parsers.set(language.id, (async () => {
    await Parser.init();
    const asset = grammarAsset(language);
    const parser = new Parser();
    parser.setLanguage(await Language.load(asset.file));
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(asset.file), 'package.json'), 'utf8'));
    return { parser, grammar: `${pkg.name}@${pkg.version}` };
  })());
  return parsers.get(language.id);
}
