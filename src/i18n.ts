/** UI localization. Source identifiers and serialized state remain language-neutral. */
import en from './locales/en.json';
import zhCN from './locales/zh-cn.json';

export type Locale = 'en' | 'zh-CN';
export type MessageKey = keyof typeof en;
export const LANGUAGE_STORAGE_KEY = 'zombie-atlas.language.v1';
const catalogs: Record<Locale, Record<MessageKey, string>> = { en, 'zh-CN': zhCN };

function supported(value: string | null): Locale | undefined {
  if (value === 'en' || value === 'zh-CN') return value;
  return undefined;
}

/** Explicit link language wins over the saved preference, then browser language. */
export function resolveLocale(): Locale {
  const explicit = supported(new URL(location.href).searchParams.get('lang'));
  if (explicit) return explicit;
  try {
    const saved = supported(localStorage.getItem(LANGUAGE_STORAGE_KEY));
    if (saved) return saved;
  } catch { /* Browsers can deny storage; the URL still supports language selection. */ }
  for (const language of navigator.languages ?? [navigator.language]) {
    if (/^zh(?:-|$)/i.test(language)) return 'zh-CN';
    if (/^en(?:-|$)/i.test(language)) return 'en';
  }
  return 'en';
}

export const locale = resolveLocale();

/** Interpolate in one pass so source text containing placeholders stays literal. */
export function msg(key: MessageKey, ...values: (string | number | undefined)[]): string {
  const text = catalogs[locale][key] ?? en[key];
  return text.replace(/\{(\d+)\}/g, (token, index: string) => {
    const value = values[Number(index)];
    return value === undefined ? token : String(value);
  });
}

/** For known display categories from the dataset; unknown categories retain their name. */
export function trLabel(value: string): string {
  return Object.hasOwn(en, value) ? msg(value as MessageKey) : value;
}

/** Runs before data loading, so the shell and errors are localized even offline. */
export function initLanguage(onBeforeChange: () => void): void {
  document.documentElement.lang = locale;
  document.title = msg('Zombie Atlas — Project Zomboid source map');
  document.querySelector('meta[name="description"]')?.setAttribute(
    'content', msg('Interactive treemap, hierarchy and dependency atlas generated from the decompiled Project Zomboid source tree.')
  );
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = msg(el.dataset.i18n as MessageKey);
  });
  for (const attr of ['title', 'aria-label', 'placeholder'] as const) {
    document.querySelectorAll<HTMLElement>(`[data-i18n-${attr}]`).forEach((el) => {
      el.setAttribute(attr, msg(el.getAttribute(`data-i18n-${attr}`) as MessageKey));
    });
  }
  const select = document.getElementById('language') as HTMLSelectElement;
  select.value = locale;
  select.addEventListener('change', () => {
    const next = supported(select.value);
    if (!next || next === locale) return;
    onBeforeChange();
    try { localStorage.setItem(LANGUAGE_STORAGE_KEY, next); } catch { /* URL fallback below. */ }
    const url = new URL(location.href);
    url.searchParams.set('lang', next);
    // Reload initializes every view, including cached canvas labels, in one language.
    location.assign(url.href);
  });
}
