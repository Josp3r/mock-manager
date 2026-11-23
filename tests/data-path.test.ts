import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { resolveDataPath } from '../src/main/data-path';

const profiles = resolve('profile-fixtures');
const isolated = join(profiles, 'isolated-release');
const development = join(profiles, 'development');
const cli = join(profiles, 'cli');

describe('brand rename storage compatibility', () => {
  it('keeps the legacy default profile for existing projects, engine and proxy journal', () => {
    expect(resolveDataPath({ appData: profiles, packaged: true }))
      .toBe(join(profiles, 'Whistle Mock Manager'));
  });

  it('honors an explicitly selected Electron profile in packaged builds and ignores dev overrides', () => {
    expect(resolveDataPath({ appData: profiles, packaged: true,
      commandLineProfile: isolated, developmentProfile: development }))
      .toBe(isolated);
  });

  it('retains the absolute development profile override priority', () => {
    expect(resolveDataPath({ appData: profiles, packaged: false,
      commandLineProfile: cli, developmentProfile: development }))
      .toBe(development);
  });

  it('ignores relative development overrides without losing an explicit profile', () => {
    expect(resolveDataPath({ appData: profiles, packaged: false,
      commandLineProfile: cli, developmentProfile: 'relative' }))
      .toBe(cli);
    expect(resolveDataPath({ appData: profiles, packaged: false, developmentProfile: 'relative' }))
      .toBe(join(profiles, 'Whistle Mock Manager'));
  });
});
