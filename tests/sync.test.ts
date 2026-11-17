import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataStore } from '../src/main/store';
import { SyncController } from '../src/main/sync';
import type { WhistleApi, WhistleAccess } from '../src/main/whistle';
import type { AppData } from '../src/shared/types';

function fake() {
  const files = new Map<string, { value: string; selected: boolean }>([['existing', { value: 'example.test host://127.0.0.1', selected: true }]]);
  let multiSelect = true, disabled = false, fail = false;
  const behavior = {
    offline: false, readError: false, select: true, unselect: true,
    afterNextAdd: undefined as ((name: string) => void) | undefined,
  };
  const calls = { add: 0, select: 0 };
  function online() { if (behavior.offline) throw new Error('Whistle offline'); }
  const api: WhistleApi = {
    network: { getStatus: async () => { online(); return { version: '2.10.12', port: 8899 }; } },
    isEnabledHTTPS: async () => true,
    rules: {
      getStatus: async () => {
        online();
        return { multiSelect, disabled, list: [...files].map(([name, v]) => ({ name, selected: v.selected })) };
      },
      get: async name => {
        online();
        if (behavior.readError) { behavior.readError = false; throw new Error('rule readback failed'); }
        const entry = files.get(name);
        return entry ? { ...entry } : null;
      },
      add: async (name, value, selected) => {
        calls.add++;
        if (fail) throw new Error('write failed');
        files.set(name, { value, selected: Boolean((behavior.select && selected) || files.get(name)?.selected) });
        const after = behavior.afterNextAdd;
        behavior.afterNextAdd = undefined;
        after?.(name);
      },
      select: async name => {
        calls.select++;
        const v = files.get(name);
        if (!v || !behavior.select) return false;
        v.selected = true; return true;
      },
      unselect: async name => { const v = files.get(name); if (v && behavior.unselect) v.selected = false; return !!v; },
      setMultiSelect: async value => { multiSelect = value; },
      turnOn: async () => { disabled = false; }
    }
  };
  const access: WhistleAccess = { find: async () => '/test/w2', resolve: async () => ({ path: '/test/w2', api }), start: async () => {} };
  return { files, access, behavior, calls, setMulti: (v: boolean) => { multiSelect = v; }, setDisabled: (v: boolean) => { disabled = v; }, setFail: (v: boolean) => { fail = v; } };
}
describe('managed Whistle synchronization', () => {
  let root: string, store: DataStore, controller: SyncController, engine: ReturnType<typeof fake>;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'mock-sync-')); store = new DataStore(root); engine = fake(); controller = new SyncController(store, engine.access); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  async function active() { const data = await store.load(); data.projects[0].endpoints[0].enabled = true; await controller.saveDraft(data); return data; }
  it('applies and disables only its own file, leaving existing selected rules intact', async () => {
    await active(); const result = await controller.apply();
    expect(result.status.syncState).toBe('synced');
    expect(engine.calls.select).toBe(0);
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
    await expect(controller.restore()).rejects.toThrow(/外部|冲突/);
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
  it('restores the applied rules and fixtures without replacing the saved draft', async () => {
    await active();
    const applied = (await controller.apply()).data.lastApplied!;
    const [fixture] = await readdir(join(root, 'fixtures'));
    await rm(join(root, 'fixtures', fixture));
    await controller.disable();

    const draft = await store.load();
    const endpoint = draft.projects[0].endpoints[0];
    endpoint.scenarios[0].body = '{unfinished';
    endpoint.scenarios.push({ ...endpoint.scenarios[0], id: 'draft-scene', name: '新场景' });
    draft.projects.push({ id: 'draft-project', name: '新项目', description: '', endpoints: [], presets: [] });
    await controller.saveDraft(draft);

    const restored = await controller.restore();
    expect(restored.data.projects).toEqual(draft.projects);
    expect((await store.load()).projects).toEqual(draft.projects);
    expect(restored.data.lastApplied?.projects).toEqual(applied.projects);
    expect(engine.files.get(applied.ruleName)).toEqual({ value: applied.rules, selected: true });
    await store.verifyFixtures({ ...draft, projects: applied.projects });
    expect(restored.status.syncState).toBe('pending');

    await controller.saveDraft({ ...draft, projects: applied.projects });
    expect((await controller.restore()).status.syncState).toBe('synced');
  });

  it.each([
    [undefined, '127.0.0.1:39001'],
    ['0.0.0.0', '127.0.0.1:39001'],
    ['::', '[::1]:39001'],
    ['0:0:0:0:0:0:0:0', '[::1]:39001'],
    ['127.0.0.2', '127.0.0.2:39001'],
    ['fe80::2', '[fe80::2]:39001'],
    ['[::1]', '[::1]:39001'],
  ])('reports a usable address for resolved host %s', async (host, address) => {
    engine.access.endpoint = async () => ({ host, port: 39001 });
    expect(await controller.status()).toMatchObject({ running: true, host: host ?? '127.0.0.1', port: 39001, address });
  });

  it.each([
    { before: '::1', other: '127.0.0.1', legacy: false },
    { before: '127.0.0.1', other: '::1', legacy: true },
  ])('requires the previous listening host for recovery (legacy: $legacy)', async ({ before, other, legacy }) => {
    let host = before;
    engine.access.endpoint = async () => ({ host, port: 8899 });
    const data = await active();
    engine.behavior.afterNextAdd = () => { engine.behavior.offline = true; };
    await expect(controller.apply()).rejects.toThrow();
    engine.behavior.offline = false;

    if (legacy) {
      const path = join(root, 'sync.pending.json');
      const journal = JSON.parse(await readFile(path, 'utf8'));
      delete journal.host;
      await writeFile(path, JSON.stringify(journal));
    }
    const reopened = new SyncController(new DataStore(root), engine.access);
    const name = controller.ruleName(data);
    host = other;
    expect(await reopened.status()).toMatchObject({ syncState: 'conflict', canRecover: false });
    await expect(reopened.restore()).rejects.toThrow(/其他 Whistle/);
    expect(engine.files.get(name)?.selected).toBe(true);
    host = before;
    expect((await reopened.restore()).status.syncState).toBe('disabled');
  });

  it('rejects an oversized applied snapshot before writing a Whistle rule', async () => {
    const data = await active();
    const scenarios = data.projects[0].endpoints[0].scenarios;
    scenarios.push(...Array.from({ length: 10 }, (_, i) => ({
      ...scenarios[0], id: 'large-' + i, body: JSON.stringify('a'.repeat(1_800_000)),
    })));
    await controller.saveDraft(data);
    await expect(controller.apply()).rejects.toThrow(/32 MiB/);
    expect(engine.calls.add).toBe(0);
    expect((await store.load()).lastApplied).toBeUndefined();
  });

  it('rolls back a live replacement when its readback fails', async () => {
    await active();
    const result = await controller.apply();
    const old = result.data.lastApplied!;
    const draft = await store.load();
    draft.projects[0].endpoints[0].scenarios[0].body = '{"changed":true}';
    await controller.saveDraft(draft);
    engine.behavior.afterNextAdd = () => { engine.behavior.readError = true; };
    await expect(controller.apply()).rejects.toThrow(/readback/);
    expect(engine.files.get(old.ruleName)).toEqual({ value: old.rules, selected: true });
    expect((await store.load()).lastApplied).toEqual(old);
    expect((await controller.status()).syncState).toBe('pending');
  });

  it('rolls back a live replacement when the snapshot cannot be saved', async () => {
    await active();
    const first = await controller.apply();
    const draft = await store.load();
    draft.projects[0].endpoints[0].scenarios[0].body = '{"changed":true}';
    await controller.saveDraft(draft);
    vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('local disk failed'));
    await expect(controller.apply()).rejects.toThrow(/local disk failed/);
    const old = first.data.lastApplied!;
    expect(engine.files.get(old.ruleName)).toEqual({ value: old.rules, selected: true });
    expect((await store.load()).lastApplied).toEqual(old);
  });

  it('keeps a verified rule when a save error arrives after the snapshot was published', async () => {
    await active();
    const realSave = store.save.bind(store);
    vi.spyOn(store, 'save').mockImplementationOnce(async (next) => {
      await realSave(next);
      throw new Error('disk acknowledgement failed');
    });
    const applied = await controller.apply();
    expect(applied.status.syncState).toBe('synced');
    expect((await store.load()).lastApplied).toEqual(applied.data.lastApplied);
    expect(engine.files.get(applied.data.lastApplied!.ruleName)?.selected).toBe(true);
  });

  it('recovers a partial first apply after restarting without a last applied snapshot', async () => {
    const data = await active();
    const name = controller.ruleName(data);
    engine.behavior.afterNextAdd = () => { engine.behavior.offline = true; };
    await expect(controller.apply()).rejects.toThrow();
    expect(engine.files.get(name)?.selected).toBe(true);
    engine.behavior.offline = false;
    const reopened = new SyncController(new DataStore(root), engine.access);
    expect((await reopened.status()).canRecover).toBe(true);
    expect((await reopened.load()).lastApplied).toBeUndefined();
    const recovered = await reopened.restore();
    expect(recovered.status.syncState).toBe('disabled');
    expect(engine.files.get(name)?.selected).toBe(false);
    expect((await reopened.apply()).status.syncState).toBe('synced');
    expect(engine.files.get('existing')?.selected).toBe(true);
  });

  it('preserves an external rule edit after a failed write and through restart', async () => {
    const data = await active();
    const name = controller.ruleName(data);
    engine.behavior.afterNextAdd = () => {
      engine.files.set(name, { value: '# external edit during apply', selected: true });
      throw new Error('write interrupted');
    };
    await expect(controller.apply()).rejects.toThrow();
    const reopened = new SyncController(new DataStore(root), engine.access);
    const status = await reopened.status();
    expect(status.syncState).toBe('conflict');
    expect(status.canRecover).toBe(false);
    await expect(reopened.restore()).rejects.toThrow(/外部|冲突/);
    expect(engine.files.get(name)).toEqual({ value: '# external edit during apply', selected: true });
  });

  it('rejects recovery if Whistle did not select the managed file', async () => {
    await active();
    const applied = await controller.apply();
    await controller.disable();
    engine.behavior.select = false;
    await expect(controller.restore()).rejects.toThrow(/恢复|确认/);
    expect(engine.files.get(applied.data.lastApplied!.ruleName)?.selected).toBe(false);
    expect((await store.load()).lastApplied).toEqual(applied.data.lastApplied);
  });

  it.each(['global rules', 'multi-select'] as const)('verifies %s after recovery writes', async (feature) => {
    await active();
    const applied = await controller.apply();
    await controller.disable();
    engine.behavior.afterNextAdd = () => {
      if (feature === 'global rules') engine.setDisabled(true);
      else engine.setMulti(false);
    };
    await expect(controller.restore()).rejects.toThrow(/确认/);
    expect(engine.files.get(applied.data.lastApplied!.ruleName)?.selected).toBe(false);
    expect((await store.load()).lastApplied).toEqual(applied.data.lastApplied);
    expect(engine.files.get('existing')?.selected).toBe(true);
  });

  it('verifies that disable actually unselected the managed rule', async () => {
    await active();
    const result = await controller.apply();
    engine.behavior.unselect = false;
    await expect(controller.disable()).rejects.toThrow(/停止|确认/);
    expect(engine.files.get(result.data.lastApplied!.ruleName)?.selected).toBe(true);
  });

  it('ignores executable-path and installation changes from draft saves', async () => {
    const initial = await store.load();
    const stale = { ...initial, installationId: 'different-installation',
      settings: { ...initial.settings, w2Path: '/renderer/w2' } };
    stale.projects[0].name = 'Updated project';
    const saved = await controller.saveDraft(stale);
    expect(saved.installationId).toBe(initial.installationId);
    expect(saved.settings).toEqual({ engineMode: 'builtin' });
    expect(saved.projects[0].name).toBe('Updated project');
  });
});

describe('built-in Whistle migration', () => {
  let root: string, store: DataStore, controller: SyncController, engine: ReturnType<typeof fake>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mock-sync-engine-'));
    store = new DataStore(root);
    engine = fake();
    const requireBuiltin = (selector: string) => {
      if (selector !== '@builtin') throw new Error('Unexpected engine selector: ' + selector);
    };
    controller = new SyncController(store, {
      find: async selector => { requireBuiltin(selector); return '@builtin'; },
      resolve: async selector => { requireBuiltin(selector); return { ...await engine.access.resolve(selector), path: '@builtin' }; },
      endpoint: async selector => { requireBuiltin(selector); return { port: 8899 }; },
      start: async selector => { requireBuiltin(selector); },
    });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('uses the built-in engine for every connection operation on an upgraded profile', async () => {
    const data = await store.load();
    await writeFile(join(root, 'data.json'), JSON.stringify({ ...data, settings: { w2Path: '/old/w2' } }));
    expect(await controller.startWhistle()).toMatchObject({ engineMode: 'builtin', running: true, port: 8899 });
    await controller.enableRules();
    await controller.enableMultiSelect();
    expect((await controller.apply()).status.syncState).toBe('synced');
  });

  it('archives an external journal without applying its rule or the previously applied snapshot', async () => {
    const { data } = await controller.apply();
    const name = controller.ruleName(data);
    engine.files.delete(name);
    await writeFile(join(root, 'data.json'), JSON.stringify({ ...data, settings: { w2Path: '/old/w2' } }));
    const journal = JSON.stringify({
      schemaVersion: 1,
      ruleName: name, w2Path: '/old/w2', host: '127.0.0.1', port: 8899,
      beforeValue: null, beforeSelected: false, nextDigest: 'a'.repeat(64), nextAt: '2026-01-01T00:00:00.000Z',
    });
    await writeFile(join(root, 'sync.pending.json'), journal);
    expect(await controller.status()).toMatchObject({ engineMode: 'builtin', syncState: 'disabled' });
    expect(await store.pendingSync()).toBeNull();
    const archive = (await readdir(root)).find(file => file.startsWith('sync.pending.json.external-'));
    expect(archive).toBeDefined();
    expect(await readFile(join(root, archive!), 'utf8')).toBe(journal);
    expect(engine.files.has(name)).toBe(false);
    expect((await store.load()).lastApplied).toEqual(data.lastApplied);
    expect((await controller.restore()).status.syncState).toBe('synced');
  });
});
