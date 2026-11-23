import { useSyncExternalStore } from 'react';
import { resolveLocale, setLocale, type LanguagePreference, type LanguageSettings } from '../shared/i18n';

let current: LanguageSettings = { preference: 'system', locale: resolveLocale('system', navigator.languages) };
const listeners = new Set<() => void>();
const snapshot = () => current;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function publish(next: LanguageSettings) {
  current = next;
  setLocale(next.locale);
  document.documentElement.lang = next.locale;
  for (const listener of listeners) listener();
}
export async function initializeLanguage() {
  try { publish(await window.mockManager.getLanguage()); }
  catch { publish(current); }
}
export async function changeLanguage(preference: LanguagePreference) {
  publish(await window.mockManager.setLanguage(preference));
}
export function useLanguage() { return useSyncExternalStore(subscribe, snapshot); }
