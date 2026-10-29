/** Language-specific extraction ends here; the atlas pipeline consumes one record contract. */
import { initParser } from './parsers.mjs';
import { parseJavaFileWith } from './java-ast.mjs';
import { parseSourceFileWith } from './source-ast.mjs';

const extractors = {
  java: parseJavaFileWith,
  python: (parser, file, relative) => parseSourceFileWith(parser, file, relative, 'python'),
  c: (parser, file, relative) => parseSourceFileWith(parser, file, relative, 'c'),
  cpp: (parser, file, relative) => parseSourceFileWith(parser, file, relative, 'cpp'),
};

export async function loadAdapter(language) {
  const extract = extractors[language.id];
  if (!extract) throw new Error(`No structure adapter registered for ${language.id}`);
  const engine = await initParser(language);
  return {
    grammar: engine.grammar,
    capabilities: {
      structure: true,
      inheritance: language.id !== 'c',
      fileDependencies: language.id !== 'java',
      memberReferences: language.id === 'java',
    },
    parseFile: (file, relative, options) => extract(engine.parser, file, relative, options),
  };
}
