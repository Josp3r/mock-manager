import { afterEach, describe, expect, it } from 'vitest';
import { shutdownEngine } from '../src/main/engine-shutdown';
import { setLocale } from '../src/shared/i18n';
import type { SystemProxyStatus } from '../src/shared/types';
const view = (managed: boolean, state: SystemProxyStatus['state'] = managed ? 'on' : 'off'): SystemProxyStatus => ({supported: true, managed, state, services: []});
describe('engine shutdown', () => {
  afterEach(() => setLocale('zh-CN'));
  it('localizes a missing restore error while keeping the engine running', async () => {
    setLocale('en');
    let stopped = false;
    await expect(shutdownEngine({status: async () => view(true), disable: async () => view(true, 'error')},
      {stop: async () => {stopped = true;}})).rejects.toThrow(/could not restore the system proxy/i);
    expect(stopped).toBe(false);
  });
  it('restores owned proxy before stopping the engine', async () => {
    const events: string[] = [];
    await shutdownEngine({status: async () => view(true), disable: async () => {events.push('restore'); return view(false);}},
      {stop: async () => {events.push('stop');}});
    expect(events).toEqual(['restore', 'stop']);
  });
  it('keeps the engine alive if restore is cancelled or conflicts', async () => {
    for (const state of ['error', 'changed'] as const) {
      let stopped = false;
      await expect(shutdownEngine({status: async () => view(true), disable: async () => ({...view(true,state), message:'恢复失败'})},
        {stop: async () => {stopped=true;}})).rejects.toThrow('恢复失败');
      expect(stopped).toBe(false);
    }
  });
  it('does not change a proxy it does not own', async () => {
    let restored = false, stopped = false;
    await shutdownEngine({status: async () => view(false,'external'), disable: async () => {restored=true; return view(false);}},
      {stop: async () => {stopped=true;}});
    expect(restored).toBe(false); expect(stopped).toBe(true);
  });
  it('keeps the engine alive on unreadable managed proxy state', async () => {
    let stopped = false;
    await expect(shutdownEngine({status: async () => {throw new Error('read failed');}, disable: async () => view(false)},
      {stop: async () => {stopped=true;}})).rejects.toThrow('read failed');
    expect(stopped).toBe(false);
  });
});
