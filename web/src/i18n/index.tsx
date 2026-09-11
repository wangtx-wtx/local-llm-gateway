import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_LANGUAGE, dictionary, LANGUAGES, type Language, type TranslationKey } from './dictionary';
import { interpolate, type TranslateParams } from './interpolate';

/**
 * Minimal i18n runtime.
 *
 * A context plus a lookup function — no framework, in keeping with the
 * dashboard's zero-runtime-dependency design. The language is persisted in
 * localStorage and reflected on `<html lang>` so the browser (and screen
 * readers) follow it.
 */

export type { Language, TranslationKey };
export type { TranslateParams };
export { LANGUAGES };

export interface I18n {
  lang: Language;
  setLang: (lang: Language) => void;
  /** Look up a key, interpolating `{name}` placeholders from `params`. */
  t: (key: TranslationKey, params?: TranslateParams) => string;
}

const STORAGE_KEY = 'llmgw.lang';

/**
 * Pick the initial language: an explicit user choice wins, otherwise follow the
 * browser, otherwise English.
 */
function detectLanguage(): Language {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'en' || stored === 'zh') return stored;
  } catch {
    /* storage may be unavailable; fall through to detection */
  }
  const preferred = typeof navigator !== 'undefined' ? navigator.language : '';
  return preferred.toLowerCase().startsWith('zh') ? 'zh' : DEFAULT_LANGUAGE;
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }): JSX.Element {
  const [lang, setLangState] = useState<Language>(detectLanguage);

  useEffect(() => {
    // Keep the document in sync so CSS, browser UI and assistive tech agree.
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    try {
      window.localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      /* the preference simply will not persist */
    }
  }, [lang]);

  const setLang = useCallback((next: Language) => setLangState(next), []);

  const value = useMemo<I18n>(() => {
    return {
      lang,
      setLang,
      t: (key, params) => {
        const entry = dictionary[key];
        if (!entry) {
          // Never render a raw key: show the key itself so the gap is obvious
          // in development and harmless in production.
          return String(key);
        }
        return interpolate(entry[lang], params);
      },
    };
  }, [lang, setLang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used inside <I18nProvider>');
  return context;
}

/**
 * Locale-aware number/date formatting for code that is not a component.
 * Falls back to the browser locale when called outside the provider.
 */
export function localeFor(lang: Language): string {
  return lang === 'zh' ? 'zh-CN' : 'en-US';
}

/**
 * Label an enum-ish value coming from the API.
 *
 * Raw API values are never rewritten — this only looks up a display label and
 * falls back to the raw value, so an unknown status still renders sensibly.
 */
export function enumLabel(t: I18n['t'], group: string, value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const key = `enum.${group}.${value}` as TranslationKey;
  return key in dictionary ? t(key) : value;
}
