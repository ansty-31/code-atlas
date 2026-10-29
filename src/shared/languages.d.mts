export interface SourceLanguage {
  id: string;
  name: string;
  extensions: string[];
  grammar: string;
}
export const LANGUAGES: SourceLanguage[];
export function languageForPath(file: string, headerLanguage?: string): SourceLanguage | undefined;
export function selectLanguages(value?: string): SourceLanguage[];
export const IGNORED_DIRS: Set<string>;

export function languageName(id: string): string;
export function languageColor(id: string): string;
