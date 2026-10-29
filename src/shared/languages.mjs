/** Shared by discovery, extraction, the watcher and the source viewer. */
export const LANGUAGES = [
  { id: 'java', name: 'Java', extensions: ['.java'], grammar: 'tree-sitter-java' },
  { id: 'python', name: 'Python', extensions: ['.py', '.pyw', '.pyi'], grammar: 'tree-sitter-python' },
  { id: 'c', name: 'C', extensions: ['.c'], grammar: 'tree-sitter-c' },
  { id: 'cpp', name: 'C++', extensions: ['.cpp', '.cc', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.h'], grammar: 'tree-sitter-cpp' },
];

export function languageForPath(file, headerLanguage = 'cpp') {
  if (file.endsWith('.C')) return LANGUAGES.find((language) => language.id === 'cpp');
  const extension = file.slice(file.lastIndexOf('.')).toLowerCase();
  if (extension === '.h') return LANGUAGES.find((language) => language.id === headerLanguage);
  return LANGUAGES.find((language) => language.extensions.includes(extension));
}

export function selectLanguages(value = 'auto') {
  if (value === 'auto') return LANGUAGES;
  const ids = value.split(',').map((id) => id.trim().toLowerCase());
  const unknown = ids.filter((id) => !LANGUAGES.some((language) => language.id === id));
  if (unknown.length) throw new Error(`Unknown language: ${unknown.join(', ')}. Use auto or ${LANGUAGES.map((l) => l.id).join(', ')}.`);
  return LANGUAGES.filter((language) => ids.includes(language.id));
}

export const IGNORED_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', '.venv', 'venv', '__pycache__', '.api-cache',
]);

export const languageName = (id) => LANGUAGES.find((language) => language.id === id)?.name ?? id;
export const languageColor = (id) => ({ python: '#59b39a', c: '#4e9de0', cpp: '#b07fd6', java: '#d1785b' })[id] ?? '#8d8d8d';
