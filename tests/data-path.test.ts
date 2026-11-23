import { describe, expect, it } from 'vitest';
import { resolveDataPath } from '../src/main/data-path';

describe('brand rename storage compatibility', () => {
  it('keeps the legacy default profile for existing projects, engine and proxy journal', () => {
    expect(resolveDataPath({ appData: '/profiles', packaged: true }))
      .toBe('/profiles/Whistle Mock Manager');
  });

  it('honors an explicitly selected Electron profile in packaged builds and ignores dev overrides', () => {
    expect(resolveDataPath({ appData: '/profiles', packaged: true,
      commandLineProfile: '/isolated/release-check', developmentProfile: '/development-only' }))
      .toBe('/isolated/release-check');
  });

  it('retains the absolute development profile override priority', () => {
    expect(resolveDataPath({ appData: '/profiles', packaged: false,
      commandLineProfile: '/cli-profile', developmentProfile: '/development-profile' }))
      .toBe('/development-profile');
  });

  it('ignores relative development overrides without losing an explicit profile', () => {
    expect(resolveDataPath({ appData: '/profiles', packaged: false,
      commandLineProfile: '/cli-profile', developmentProfile: 'relative' }))
      .toBe('/cli-profile');
    expect(resolveDataPath({ appData: '/profiles', packaged: false, developmentProfile: 'relative' }))
      .toBe('/profiles/Whistle Mock Manager');
  });
});
