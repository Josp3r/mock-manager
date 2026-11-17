import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataStore } from '../src/main/store';
import { SyncController } from '../src/main/sync';
import type { WhistleApi, WhistleAccess } from '../src/main/whistle';
import type { AppData } from '../src/shared/types';

function fake() {
  const files = new Map<string, { value: string; selected: boolean }>([['existing', { value: 'example.test host://127.0.0.1', selected: true }]]);
  let multiSelect = true, disabled = false, fail = false;
  const api: WhistleApi = {
    network: { getStatus: async () => ({ version: '2.10.12', port: 8899 }) },
    isEnabledHTTPS: async () => true,
    rules: {
      getStatus: async () => ({ multiSelect, disabled, list: [...files].map(([name, v]) => ({ name, selected: v.selected })) }),
      get: async name => files.get(name) || null,
      add: async (name, value, selected) => { if (fail) throw new Error('write failed'); files.set(name, { value, selected: selected || files.get(name)?.selected || false }); },
      select: async name => { const v = files.get(name); if (!v) return false; v.selected = true; return true; },
      unselect: async name => { const v = files.get(name); if (v) v.selected = false; return !!v; },
      setMultiSelect: async value => { multiSelect = value; },
      turnOn: async () => { disabled = false; }
    }
  };
  const access: WhistleAccess = { find: async () => '/test/w2', resolve: async () => ({ path: '/test/w2', api }), start: async () => {} };
  return { files, access, setMulti: (v: boolean) => { multiSelect = v; }, setDisabled: (v: boolean) => { disabled = v; }, setFail: (v: boolean) => { fail = v; } };
}
describe('managed Whistle synchronization', () => {
  let root: string, store: DataStore, controller: SyncController, engine: ReturnType<typeof fake>;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'mock-sync-')); store = new DataStore(root); engine = fake(); controller = new SyncController(store, engine.access); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  async function active() { const data = await store.load(); data.projects[0].endpoints[0].enabled = true; await controller.saveDraft(data); return data; }
  it('applies and disables only its own file, leaving existing selected rules intact', async () => {
    await active(); const result = await controller.apply();
    expect(result.status.syncState).toBe('synced');
    expect(engine.files.get('existing')?.selected).toBe(true);
    expect(result.data.lastApplied?.rules).toContain('file://');
    await controller.disable();
    expect(engine.files.get(result.data.lastApplied!.ruleName)?.selected).toBe(false);
    expect(engine.files.get('existing')?.selected).toBe(true);
  });
  it('refuses single-select and disabled-global mode without changing either', async () => {
    await active(); engine.setMulti(false); await expect(controller.apply()).rejects.toThrow(/多选/);
    expect(engine.files.size).toBe(1);
    engine.setMulti(true); engine.setDisabled(true); await expect(controller.apply()).rejects.toThrow(/全局/);
    expect(engine.files.size).toBe(1);
  });
  it('rejects an externally modified managed file', async () => {
    await active(); const result = await controller.apply();
    engine.files.get(result.data.lastApplied!.ruleName)!.value = '# manually changed';
    expect((await controller.status()).syncState).toBe('conflict');
    await expect(controller.apply()).rejects.toThrow(/外部|冲突/);
    expect(engine.files.get(result.data.lastApplied!.ruleName)?.value).toBe('# manually changed');
  });
  it('keeps the successful snapshot after a failed apply', async () => {
    const data = await active(); const first = await controller.apply();
    data.projects[0].endpoints[0].scenarios[0].body = '{"changed":true}';
    await controller.saveDraft(data); engine.setFail(true);
    await expect(controller.apply()).rejects.toThrow('write failed');
    expect((await store.load()).lastApplied?.hash).toBe(first.data.lastApplied?.hash);
  });
  it('does not lose newer draft or successful snapshot when a stale UI save arrives', async () => {
    const data = await active(); const stale = structuredClone(data);
    await controller.apply(); stale.projects[0].name = '新的草稿';
    const saved = await controller.saveDraft(stale);
    expect(saved.lastApplied).toBeDefined(); expect(saved.projects[0].name).toBe('新的草稿');
    expect((await controller.status()).syncState).toBe('pending');
  });
  it('restores the previous successful scene after editing the draft', async () => {
    await active(); const applied = await controller.apply();
    const draft = await store.load(); draft.projects[0].endpoints[0].enabled = false;
    await controller.saveDraft(draft); const restored = await controller.restore();
    expect(restored.data.projects).toEqual(applied.data.projects); expect(restored.status.syncState).toBe('synced');
  });
});
