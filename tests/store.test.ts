import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configurationHash } from '../src/core/model';
import { DataStore } from '../src/main/store';

const directories: string[] = [];

async function temporaryStore() {
  const root = await mkdtemp(join(tmpdir(), 'Whistle Mock #'));
  directories.push(root);
  return { root, store: new DataStore(root) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('DataStore', () => {
  it('never reuses the fixture path when an applied response’s body changes', async () => {
    const { store } = await temporaryStore();
    const data = await store.load();
    const endpoint = data.projects[0].endpoints[0];
    endpoint.enabled = true;
    const scenario = endpoint.scenarios.find((entry) => entry.id === endpoint.activeScenarioId)!;
    const oldBody = scenario.body;
    const initial = (await store.writeFixtures(data))(endpoint.id, scenario.id, scenario.body);
    await store.verifyFixtures(data);
    const draft = structuredClone(data);
    draft.projects[0].endpoints[0].scenarios.find((entry) => entry.id === scenario.id)!.body = '{"changed": true}';
    await store.save(draft);
    const nextBody = draft.projects[0].endpoints[0].scenarios.find((entry) => entry.id === scenario.id)!.body;
    const next = (await store.writeFixtures(draft))(endpoint.id, scenario.id, nextBody);
    expect(isAbsolute(initial)).toBe(true);
    expect(next).not.toBe(initial);
    expect(await readFile(initial, 'utf8')).toBe(oldBody);
    expect(await readFile(next, 'utf8')).toBe(nextBody);
    await writeFile(initial, '{"tampered": true}');
    await expect(store.verifyFixtures(data)).rejects.toThrow(/fixture|快照|响应/);
    await expect(store.writeFixtures(data)).rejects.toThrow(/fixture|快照|响应/);
    expect(await readFile(initial, 'utf8')).toBe('{"tampered": true}');
    await store.repairFixtures(data);
    await store.verifyFixtures(data);
    expect(await readFile(initial, 'utf8')).toBe(oldBody);
  });

  it('restores the last valid revision when the primary metadata gets corrupted', async () => {
    const { root, store } = await temporaryStore();
    const first = await store.load();
    first.projects[0].name = 'First valid revision';
    await store.save(first);
    const second = structuredClone(first);
    second.projects[0].name = 'Second valid revision';
    await store.save(second);
    await writeFile(join(root, 'data.json'), '{broken');
    expect(await new DataStore(root).load()).toEqual(first);
    expect(await new DataStore(root).load()).toEqual(first);
  });

  it('persists invalid JSON drafts without changing the last applied snapshot', async () => {
    const { root, store } = await temporaryStore();
    const data = await store.load();
    data.lastApplied = {
      projects: structuredClone(data.projects), at: '2026-11-17T00:00:00.000Z', rules: '# managed', ruleName: 'managed-demo',
      hash: configurationHash(data.projects),
    };
    data.projects[0].endpoints[0].scenarios[0].body = '{unfinished';
    await store.save(data);
    expect(await new DataStore(root).load()).toEqual(data);
  });

  it('exports no machine or activation state and imports additively with remapped IDs', async () => {
    const { store } = await temporaryStore();
    const original = await store.load();
    const project = original.projects[0];
    const endpoint = project.endpoints[0];
    endpoint.enabled = true;
    project.presets = [{
      id: 'sample-preset', name: 'Sample preset',
      selections: { [endpoint.id]: { enabled: true, scenarioId: endpoint.activeScenarioId } },
    }];
    original.lastApplied = {
      projects: structuredClone(original.projects), at: '2026-11-17T00:00:00.000Z', rules: '# managed', ruleName: 'managed-demo',
      hash: configurationHash(original.projects),
    };
    await store.save(original);
    const backup = await store.exportBackup();
    expect(Object.keys(backup).sort()).toEqual(['projects', 'schemaVersion']);
    expect(backup.projects[0].endpoints[0].enabled).toBe(false);

    const merged = await store.importBackup({ ...original, projects: original.projects });
    expect(merged.installationId).toBe(original.installationId);
    expect(merged.settings).toEqual(original.settings);
    expect(merged.lastApplied).toEqual(original.lastApplied);
    expect(merged.projects[0]).toEqual(project);
    const copy = merged.projects[1];
    const copyEndpoint = copy.endpoints[0];
    expect(copy.id).not.toBe(project.id);
    expect(copyEndpoint.id).not.toBe(endpoint.id);
    expect(copyEndpoint.scenarios[0].id).not.toBe(endpoint.scenarios[0].id);
    expect(copyEndpoint.enabled).toBe(false);
    expect(copyEndpoint.scenarios.some((item) => item.id === copyEndpoint.activeScenarioId)).toBe(true);
    expect(copy.presets[0].id).not.toBe(project.presets[0].id);
    expect(copy.presets[0].selections).toEqual({
      [copyEndpoint.id]: { enabled: true, scenarioId: copyEndpoint.activeScenarioId },
    });
  });

  it('rejects malformed backup references without mutating saved projects', async () => {
    const { store } = await temporaryStore();
    const initial = await store.load();
    const bad = await store.exportBackup();
    bad.projects[0].endpoints[0].activeScenarioId = '../random-file';
    await expect(store.importBackup(bad)).rejects.toThrow();
    expect(await store.load()).toEqual(initial);
  });
});
