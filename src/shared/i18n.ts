export type Locale = 'zh-CN' | 'en';
export type LanguagePreference = 'system' | Locale;
export interface LanguageSettings { preference: LanguagePreference; locale: Locale }

// Pure modules keep the legacy locale until the desktop bootstrap resolves the
// persisted preference. Both processes initialize it before user-facing work.
let locale: Locale = 'zh-CN';
export const getLocale = (): Locale => locale;
export function setLocale(next: Locale) { locale = next; }
export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === 'system' || value === 'zh-CN' || value === 'en';
}
export function resolveLocale(preference: LanguagePreference, systemLanguages: readonly string[]): Locale {
  if (preference !== 'system') return preference;
  for (const language of systemLanguages) {
    if (/^zh(?:[-_]|$)/i.test(language)) return 'zh-CN';
    if (/^en(?:[-_]|$)/i.test(language)) return 'en';
  }
  return 'en';
}
/** Explicit copy pairs avoid translating or rewriting arbitrary user content. */
export function t(zh: string, en: string, params: Record<string, string | number> = {}): string {
  return (locale === 'en' ? en : zh).replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match);
}
