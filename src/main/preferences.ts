import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isLanguagePreference, resolveLocale, t, type LanguageSettings } from '../shared/i18n';

/** UI preferences intentionally live outside draft/apply/backup project data. */
export class PreferenceStore {
  private readonly path: string;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly root: string) { this.path = join(root, 'preferences.json'); }

  async load(systemLanguages: readonly string[]): Promise<LanguageSettings> {
    await this.tail;
    try {
      if ((await stat(this.path)).size > 4096) throw new Error('Invalid preferences');
      const value: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const preference = (value as Record<string, unknown>).language;
        if (isLanguagePreference(preference)) return { preference, locale: resolveLocale(preference, systemLanguages) };
      }
    } catch { /* A missing or damaged UI preference must not block the workspace. */ }
    return { preference: 'system', locale: resolveLocale('system', systemLanguages) };
  }

  setLanguage(value: unknown, systemLanguages: readonly string[]): Promise<LanguageSettings> {
    const run = this.tail.then(async () => {
      if (!isLanguagePreference(value)) throw new Error(t('语言设置无效。', 'Invalid language setting.'));
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const temporary = this.path + '.' + randomUUID() + '.tmp';
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify({ language: value }) + '\n', 'utf8'); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, this.path);
      } finally { await rm(temporary, { force: true }); }
      return { preference: value, locale: resolveLocale(value, systemLanguages) };
    });
    this.tail = run.catch(() => {});
    return run;
  }
}
