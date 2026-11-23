import { afterEach, describe, expect, it } from 'vitest';
import { getLocale, resolveLocale, setLocale, t } from '../src/shared/i18n';

afterEach(() => setLocale('zh-CN'));

describe('language resolution', () => {
  it('uses an explicit choice before system preferences', () => {
    expect(resolveLocale('en', ['zh-CN'])).toBe('en');
    expect(resolveLocale('zh-CN', ['en-US'])).toBe('zh-CN');
  });
  it('chooses the first supported system language and falls back to English', () => {
    expect(resolveLocale('system', ['zh-Hant-TW', 'en-US'])).toBe('zh-CN');
    expect(resolveLocale('system', ['fr-FR', 'en-GB', 'zh-CN'])).toBe('en');
    expect(resolveLocale('system', ['de-DE'])).toBe('en');
    expect(resolveLocale('system', [])).toBe('en');
  });
  it('switches subsequent translations without altering interpolated user content', () => {
    const userName = '我的项目 {other} $&';
    setLocale('en');
    expect(getLocale()).toBe('en');
    expect(t('删除「{name}」的 {count} 条规则', 'Delete {count} rules in "{name}"', { name: userName, count: 2 }))
      .toBe('Delete 2 rules in "我的项目 {other} $&"');
    setLocale('zh-CN');
    expect(t('语言', 'Language')).toBe('语言');
  });
});
