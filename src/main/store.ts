import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { activeRoutes, createInitialData, validateData, validateProjects } from '../core/model';
import type { FixturePath } from '../core/compiler';
import type { AppData, Project } from '../shared/types';

export interface ProjectBackup {
  schemaVersion: 1;
  projects: Project[];
}

export interface PendingSync {
  ruleName: string;
  w2Path: string;
  host?: string; // Absent in journals written before host detection.
  port: number;
  beforeValue: string | null;
  beforeSelected: boolean;
  nextDigest: string;
  nextAt: string;
}

export const MAX_DATA_BYTES = 32 * 1024 * 1024;

function isError(error: unknown, ...codes: string[]): boolean {
  return error instanceof Error && codes.includes((error as NodeJS.ErrnoException).code ?? '');
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await directory.sync();
  } catch (error) {
    // Some filesystems cannot sync a directory handle.
    if (!isError(error, 'EINVAL', 'ENOTSUP')) throw error;
  } finally {
    await directory.close();
  }
}

async function putFile(path: string, content: string | Buffer, replace: boolean): Promise<void> {
  const temp = path + '.' + randomUUID() + '.tmp';
  const file = await open(temp, 'wx', 0o600);
  try {
    try {
      await file.writeFile(content);
      await file.sync();
    } finally {
      await file.close();
    }
    // Rename publishes complete replacement metadata. A hard link publishes
    // new immutable fixture bytes only if no file already has that address.
    if (replace) await rename(temp, path);
    else await link(temp, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temp, { force: true });
  }
}

class InvalidFile extends Error {}

async function getFile(path: string, maxSize: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxSize) throw new InvalidFile('文件格式或大小无效');
    return await file.readFile();
  } finally {
    await file.close();
  }
}

type Stored = { data?: undefined; broken: boolean } | { data: AppData; broken: false };

async function readMetadata(path: string): Promise<Stored> {
  let content: Buffer;
  try {
    content = await getFile(path, MAX_DATA_BYTES);
  } catch (error) {
    if (isError(error, 'ENOENT')) return { broken: false };
    if (error instanceof InvalidFile || isError(error, 'ELOOP')) return { broken: true };
    throw error;
  }
  try {
    return { data: validateData(JSON.parse(content.toString('utf8'))), broken: false };
  } catch {
    return { broken: true };
  }
}

function metadataBytes(data: AppData): string {
  const content = JSON.stringify(data, null, 2) + '\n';
  if (Buffer.byteLength(content) > MAX_DATA_BYTES) throw new Error('本地配置超过 32 MiB');
  return content;
}

function cloneImported(project: Project): Project {
  const endpoints = new Map<string, { id: string; scenarioIds: Map<string, string> }>();
  const importedEndpoints = project.endpoints.map((endpoint) => {
    const id = randomUUID();
    const scenarioIds = new Map(endpoint.scenarios.map((item) => [item.id, randomUUID()]));
    endpoints.set(endpoint.id, { id, scenarioIds });
    return {
      ...endpoint,
      id,
      enabled: false,
      activeScenarioId: scenarioIds.get(endpoint.activeScenarioId)!,
      scenarios: endpoint.scenarios.map((scenario) => ({ ...scenario, id: scenarioIds.get(scenario.id)! })),
    };
  });
  return {
    ...project,
    id: randomUUID(),
    endpoints: importedEndpoints,
    presets: project.presets.map((preset) => ({
      ...preset,
      id: randomUUID(),
      selections: Object.fromEntries(Object.entries(preset.selections).map(([endpointId, selection]) => {
        const replacement = endpoints.get(endpointId)!;
        return [replacement.id, { enabled: selection.enabled, scenarioId: replacement.scenarioIds.get(selection.scenarioId)! }];
      })),
    })),
  };
}

class InvalidFixture extends Error {
  constructor(path: string, detail: string) {
    super(`响应文件（fixture）${detail}：${path}`);
  }
}

async function fixtureMatches(path: string, expected: Buffer): Promise<boolean> {
  try {
    return expected.equals(await getFile(path, expected.length));
  } catch (error) {
    if (isError(error, 'ENOENT')) return false;
    if (error instanceof InvalidFile || isError(error, 'ELOOP')) throw new InvalidFixture(path, '校验失败');
    throw error;
  }
}

export class DataStore {
  readonly root: string;
  private readonly primary: string;
  private readonly recovery: string;
  private readonly fixtureRoot: string;
  private readonly pending: string;
  private tail = Promise.resolve();

  constructor(root: string) {
    this.root = resolve(root);
    this.primary = join(this.root, 'data.json');
    this.recovery = join(this.root, 'data.previous.json');
    this.fixtureRoot = join(this.root, 'fixtures');
    this.pending = join(this.root, 'sync.pending.json');
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run);
    this.tail = result.then(() => {}, () => {});
    return result;
  }

  private async loadData(): Promise<AppData> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const primary = await readMetadata(this.primary);
    if (primary.data) return primary.data;
    const recovery = await readMetadata(this.recovery);
    if (recovery.data) {
      if (primary.broken) await rename(this.primary, this.primary + '.corrupt-' + randomUUID());
      await putFile(this.primary, metadataBytes(recovery.data), true);
      return recovery.data;
    }
    if (primary.broken || recovery.broken) throw new Error('本地配置损坏且无法从上一版本恢复。原文件已保留。');
    const data = createInitialData();
    const content = metadataBytes(data);
    await putFile(this.recovery, content, true);
    await putFile(this.primary, content, true);
    return data;
  }

  private async persist(data: AppData, previous: AppData): Promise<AppData> {
    const next = validateData(data);
    const content = metadataBytes(next);
    await putFile(this.recovery, metadataBytes(previous), true);
    await putFile(this.primary, content, true);
    return next;
  }

  load(): Promise<AppData> {
    return this.enqueue(() => this.loadData());
  }

  save(data: AppData): Promise<AppData> {
    return this.enqueue(async () => this.persist(data, await this.loadData()));
  }

  beginSync(intent: PendingSync, next: AppData): Promise<void> {
    return this.enqueue(async () => {
      // Use the same validation and serializer as save() before touching Whistle.
      metadataBytes(validateData(next));
      const content = JSON.stringify({ schemaVersion: 1, ...intent });
      if (Buffer.byteLength(content) > MAX_DATA_BYTES) throw new Error('同步记录超过 32 MiB');
      await putFile(this.pending, content, false);
    });
  }

  pendingSync(): Promise<PendingSync | null> {
    return this.enqueue(async () => {
      try {
        const entry = JSON.parse((await getFile(this.pending, MAX_DATA_BYTES)).toString('utf8'));
        if (!entry || entry.schemaVersion !== 1 || typeof entry.ruleName !== 'string' ||
          !/^MockManager-[a-z\d][a-z\d_-]{0,79}$/i.test(entry.ruleName) ||
          typeof entry.w2Path !== 'string' || entry.w2Path.length > 4096 ||
          (entry.host !== undefined && (typeof entry.host !== 'string' || !entry.host || entry.host.length > 255)) ||
          !Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535 ||
          (entry.beforeValue !== null && (typeof entry.beforeValue !== 'string' || entry.beforeValue.length > 8_000_000)) ||
          typeof entry.beforeSelected !== 'boolean' ||
          (entry.beforeValue === null && entry.beforeSelected) ||
          typeof entry.nextDigest !== 'string' || !/^[0-9a-f]{64}$/.test(entry.nextDigest) ||
          typeof entry.nextAt !== 'string' || !Number.isFinite(Date.parse(entry.nextAt))) {
          throw new InvalidFile('同步记录格式无效');
        }
        return entry as PendingSync;
      } catch (error) {
        if (isError(error, 'ENOENT')) return null;
        throw new Error('无法读取同步恢复记录。请检查本地数据文件。', { cause: error });
      }
    });
  }

  clearSync(): Promise<void> {
    return this.enqueue(async () => {
      await rm(this.pending, { force: true });
      await syncDirectory(this.root);
    });
  }

  exportBackup(): Promise<ProjectBackup> {
    return this.enqueue(async () => {
      const { projects } = await this.loadData();
      return {
        schemaVersion: 1,
        projects: projects.map((project) => ({
          ...project,
          endpoints: project.endpoints.map((endpoint) => ({ ...endpoint, enabled: false })),
        })),
      };
    });
  }

  importBackup(input: unknown): Promise<AppData> {
    return this.enqueue(async () => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('备份格式无效');
      const backup = input as Record<string, unknown>;
      if (backup.schemaVersion !== 1) throw new Error('不支持的备份版本');
      const imported = validateProjects(backup.projects).map(cloneImported);
      const previous = await this.loadData();
      return this.persist({ ...previous, projects: [...previous.projects, ...imported] }, previous);
    });
  }

  writeFixtures(data: AppData): Promise<FixturePath> {
    return this.enqueue(() => this.prepareFixtures(data, 'create'));
  }

  verifyFixtures(data: AppData): Promise<void> {
    return this.enqueue(async () => { await this.prepareFixtures(data, 'verify'); });
  }

  repairFixtures(data: AppData): Promise<FixturePath> {
    return this.enqueue(() => this.prepareFixtures(data, 'repair'));
  }

  private async prepareFixtures(data: AppData, action: 'create' | 'verify' | 'repair'): Promise<FixturePath> {
    const routes = activeRoutes(data);
    const files = new Map<string, string>();
    const verified = new Set<string>();
    if (routes.length) {
      if (action !== 'verify') await mkdir(this.fixtureRoot, { recursive: true, mode: 0o700 });
      try {
        if (!(await lstat(this.fixtureRoot)).isDirectory()) throw new InvalidFixture(this.fixtureRoot, '目录无效');
      } catch (error) {
        if (isError(error, 'ENOENT')) throw new InvalidFixture(this.fixtureRoot, '目录不存在');
        throw error;
      }
    }
    const key = (endpointId: string, scenarioId: string, digest: string) => [endpointId, scenarioId, digest].join(':');
    const sha = (content: Buffer | string) => createHash('sha256').update(content).digest('hex');
    for (const { endpoint, scenario } of routes) {
      const expected = Buffer.from(scenario.body, 'utf8');
      const digest = sha(expected);
      const path = join(this.fixtureRoot, `fixture-${digest}.json`);
      if (!verified.has(path)) {
        let valid: boolean;
        try {
          valid = await fixtureMatches(path, expected);
        } catch (error) {
          if (action !== 'repair' || !(error instanceof InvalidFixture)) throw error;
          valid = false;
        }
        if (!valid && action === 'verify') throw new InvalidFixture(path, '缺失或校验失败');
        if (!valid && action === 'repair') await putFile(path, expected, true);
        if (!valid && action === 'create') {
          try {
            await putFile(path, expected, false);
          } catch (error) {
            if (!isError(error, 'EEXIST')) throw error;
            if (!(await fixtureMatches(path, expected))) throw new InvalidFixture(path, '已存在但校验失败');
          }
        }
        verified.add(path);
      }
      files.set(key(endpoint.id, scenario.id, digest), path);
    }
    return (endpointId, scenarioId, body) => {
      const path = files.get(key(endpointId, scenarioId, sha(body)));
      if (!path) throw new Error('响应文件（fixture）不在当前快照内');
      return path;
    };
  }
}
