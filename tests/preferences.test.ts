import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PreferenceStore } from '../src/main/preferences';

const roots: string[] = [];
async function profile() {
  const root = await mkdtemp(join(tmpdir(), 'mock-manager-language-'));
  roots.push(root);
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true}))); });

describe('language preferences', () => {
  it('defaults to the system language without creating a project or preference', async () => {
    const root = await profile();
    expect(await new PreferenceStore(root).load(['zh-CN'])).toEqual({ preference: 'system', locale: 'zh-CN' });
    await expect(readFile(join(root, 'preferences.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('persists a choice across instances while leaving project bytes untouched', async () => {
    const root = await profile();
    const project = '{"name":"用户内容","body":"{not translated}"}\n';
    await writeFile(join(root, 'data.json'), project);
    const store = new PreferenceStore(root);
    expect(await store.setLanguage('en', ['zh-CN'])).toEqual({ preference: 'en', locale: 'en' });
    expect(await new PreferenceStore(root).load(['zh-CN'])).toEqual({ preference: 'en', locale: 'en' });
    expect(await readFile(join(root, 'data.json'), 'utf8')).toBe(project);
  });
  it('rejects untrusted language values without overwriting a valid setting', async () => {
    const root = await profile();
    const store = new PreferenceStore(root);
    await store.setLanguage('en', ['zh-CN']);
    for (const value of ['fr', null, {}, '../data.json']) await expect(store.setLanguage(value, ['zh-CN'])).rejects.toThrow();
    expect(await store.load(['zh-CN'])).toEqual({ preference: 'en', locale: 'en' });
  });
  it('preserves malformed preferences and falls back without blocking startup', async () => {
    const root = await profile();
    await writeFile(join(root, 'preferences.json'), '{invalid');
    expect(await new PreferenceStore(root).load(['en-US'])).toEqual({ preference: 'system', locale: 'en' });
    expect(await readFile(join(root, 'preferences.json'), 'utf8')).toBe('{invalid');
  });
  it('serializes changes so the last selected preference survives restart', async () => {
    const root = await profile();
    const store = new PreferenceStore(root);
    await Promise.all([store.setLanguage('en', ['en']), store.setLanguage('zh-CN', ['en'])]);
    expect(await new PreferenceStore(root).load(['en'])).toEqual({ preference: 'zh-CN', locale: 'zh-CN' });
    await store.setLanguage('system', ['en-GB']);
    expect(await new PreferenceStore(root).load(['zh-CN'])).toEqual({ preference: 'system', locale: 'zh-CN' });
  });
});
