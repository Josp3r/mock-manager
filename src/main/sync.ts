import { createHash } from 'node:crypto';
import type { AppData, AppliedSnapshot, ApplyResult, ConnectionStatus } from '../shared/types';
import { compileRules, configurationHash } from '../core/compiler';
import { validateForApply } from '../core/model';
import { DataStore, type PendingSync } from './store';
import { compatibleVersion, ruleValue, whistleAddress, WHISTLE_LOOPBACK, type WhistleAccess, type WhistleApi } from './whistle';

type ConnectedWhistle = { api: WhistleApi; path: string; host: string; port: number; address: string; version: string };
type Managed = {
  value: string | null;
  selected: boolean;
  multiSelect: boolean;
  disabled: boolean;
};

const EXTERNAL_CONFLICT = '专属规则在 Whistle 中被外部修改。请在 Whistle 中处理冲突后重试。';
const DIFFERENT_WHISTLE = '上次同步使用了其他 Whistle 路径或代理地址，请连接该实例后处理恢复。';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertActivationAllowed(managed: Managed): void {
  if (!managed.multiSelect) throw new Error('请先在连接设置中启用多选模式，避免停用你已有的规则。');
  if (managed.disabled) throw new Error('Whistle 全局规则已关闭，请先在连接设置中启用。');
}

async function readManaged(api: WhistleApi, name: string): Promise<Managed> {
  const [raw, status] = await Promise.all([api.rules.get(name), api.rules.getStatus()]);
  const value = ruleValue(raw)?.value ?? null;
  const selected = status.list.some((record) => record.name === name && record.selected);
  if ((raw && typeof raw !== 'string' && raw.selected !== selected) || (value === null && selected)) {
    throw new Error('两次 Whistle 规则读取结果不一致，请重试。');
  }
  return { value, selected, multiSelect: status.multiSelect, disabled: status.disabled };
}

function inactiveMarker(name: string): string {
  return '# Whistle Mock Manager: ' + name + ' inactive\n';
}

function owned(data: AppData, name: string, value: string | null): boolean {
  return value === null || (data.lastApplied
    ? data.lastApplied.ruleName === name && data.lastApplied.rules === value
    : value === inactiveMarker(name));
}

function committed(data: AppData, intent: PendingSync): boolean {
  return data.lastApplied?.ruleName === intent.ruleName && data.lastApplied.at === intent.nextAt
    && digest(data.lastApplied.rules) === intent.nextDigest;
}

function sameConnection(connection: ConnectedWhistle, intent: PendingSync): boolean {
  return connection.path === intent.w2Path && connection.port === intent.port
    && connection.host === (intent.host ?? WHISTLE_LOOPBACK);
}

function knownPendingValue(managed: Managed, intent: PendingSync): boolean {
  const { value } = managed;
  return value === null || value === intent.beforeValue || digest(value) === intent.nextDigest
    || (intent.beforeValue === null && value === inactiveMarker(intent.ruleName));
}

export class SyncController {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly store: DataStore, readonly access: WhistleAccess) {}

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  ruleName(data: AppData): string {
    return 'MockManager-' + data.installationId;
  }

  load(): Promise<AppData> {
    return this.serial(() => this.store.load());
  }

  saveDraft(input: AppData): Promise<AppData> {
    return this.serial(async () => {
      const current = await this.store.load();
      return this.store.save({ ...current, projects: input?.projects });
    });
  }

  updateW2Path(w2Path: string): Promise<AppData> {
    return this.serial(async () => {
      const current = await this.store.load();
      return this.store.save({ ...current, settings: { w2Path } });
    });
  }

  status(): Promise<ConnectionStatus> {
    return this.serial(() => this.statusNow());
  }

  private async connect(data: AppData): Promise<ConnectedWhistle> {
    const { path, api } = await this.access.resolve(data.settings.w2Path);
    const meta = await api.network.getStatus();
    if (!compatibleVersion(meta.version)) throw new Error('Whistle 版本过低，请升级至 2.10.7 或更新版本。');
    const endpoint = await this.access.endpoint?.(data.settings.w2Path);
    const port = endpoint?.port ?? meta.port;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('无法确认 Whistle 的实际代理端口。');
    }
    const host = endpoint?.host?.trim() || WHISTLE_LOOPBACK;
    return { api, path, host, port, address: whistleAddress(host, port), version: meta.version };
  }

  private async statusNow(): Promise<ConnectionStatus> {
    const data = await this.store.load();
    const name = this.ruleName(data);
    const state: ConnectionStatus = {
      installed: false, running: false, w2Path: data.settings.w2Path, syncState: 'offline',
      ruleName: name, lastAppliedAt: data.lastApplied?.at, canRecover: false,
    };
    try {
      state.w2Path = await this.access.find(data.settings.w2Path);
      state.installed = true;
      const connection = await this.connect(data);
      state.running = true;
      state.version = connection.version;
      state.host = connection.host;
      state.port = connection.port;
      state.address = connection.address;
      const [view, https, intent] = await Promise.all([
        readManaged(connection.api, name), connection.api.isEnabledHTTPS(), this.store.pendingSync(),
      ]);
      state.multiSelect = view.multiSelect;
      state.rulesDisabled = view.disabled;
      state.httpsEnabled = https;
      state.managedSelected = view.selected;
      if (intent && !committed(data, intent)) {
        state.syncState = 'conflict';
        if (intent.ruleName !== name || !sameConnection(connection, intent)) {
          state.error = DIFFERENT_WHISTLE;
        } else if (!knownPendingValue(view, intent)) {
          state.error = EXTERNAL_CONFLICT;
        } else {
          state.canRecover = true;
          state.error = '上次同步中断。可恢复中断前的规则，或重新应用草稿。';
        }
      } else if (!owned(data, name, view.value)) {
        state.syncState = 'conflict';
        state.error = EXTERNAL_CONFLICT;
      } else {
        state.canRecover = !!data.lastApplied && view.multiSelect && !view.disabled;
        if (view.value === null || !view.selected || view.disabled || !data.lastApplied) state.syncState = 'disabled';
        else {
          try {
            await this.store.verifyFixtures({ ...data, projects: data.lastApplied.projects });
            state.syncState = data.lastApplied.hash === configurationHash(data.projects) ? 'synced' : 'pending';
          } catch {
            state.syncState = 'conflict';
            state.error = '已应用的响应文件缺失或被修改，请恢复上次应用。';
          }
        }
      }
    } catch (error) {
      state.error = message(error);
    }
    return state;
  }

  private async stopSelected(api: WhistleApi, name: string): Promise<Managed> {
    await api.rules.unselect(name);
    const stopped = await readManaged(api, name);
    if (stopped.selected) throw new Error('Whistle 未确认停止专属规则。');
    return stopped;
  }

  private async recoverInterrupted(data: AppData, connection: ConnectedWhistle): Promise<Managed> {
    const name = this.ruleName(data);
    const api = connection.api;
    const intent = await this.store.pendingSync();
    const view = await readManaged(api, name);
    if (!intent) return view;
    if (committed(data, intent)) {
      await this.store.clearSync();
      return view;
    }
    if (intent.ruleName !== name || !sameConnection(connection, intent)) {
      throw new Error(DIFFERENT_WHISTLE);
    }
    if (!knownPendingValue(view, intent)) throw new Error(EXTERNAL_CONFLICT);

    // A missing file or text other than the attempted write does not show that
    // an app write reached Whistle. Preserve current selection in that case.
    let restored = view;
    if (view.value !== null && digest(view.value) === intent.nextDigest &&
      (view.value !== intent.beforeValue || view.selected !== intent.beforeSelected)) {
      if (intent.beforeSelected) {
        if (!view.multiSelect) {
          if (view.selected) await this.stopSelected(api, name);
          throw new Error('已中断的同步需要先恢复 Whistle 多选模式。');
        }
        await api.rules.add(name, intent.beforeValue!, true);
      } else {
        const unselected = view.selected ? await this.stopSelected(api, name) : view;
        if (!knownPendingValue(unselected, intent)) throw new Error(EXTERNAL_CONFLICT);
        if (unselected.value !== null) {
          const previous = intent.beforeValue ?? inactiveMarker(name);
          if (unselected.value !== previous) await api.rules.add(name, previous, false);
        }
      }
      restored = await readManaged(api, name);
      if (restored.value !== null &&
        (restored.value !== (intent.beforeValue ?? inactiveMarker(name)) || restored.selected !== intent.beforeSelected)) {
        throw new Error('Whistle 未确认恢复中断前的规则。');
      }
      if (restored.value === null && intent.beforeSelected) throw new Error('Whistle 未确认恢复中断前的规则。');
    }
    await this.store.clearSync();
    return restored;
  }

  private async applyTransition(
    previous: AppData, next: AppData, connection: ConnectedWhistle, before: Managed,
  ): Promise<ApplyResult> {
    const snapshot = next.lastApplied!;
    const name = snapshot.ruleName;
    const api = connection.api;
    const intent: PendingSync = {
      ruleName: name,
      w2Path: connection.path,
      host: connection.host,
      port: connection.port,
      beforeValue: before.value,
      beforeSelected: before.selected,
      nextDigest: digest(snapshot.rules),
      nextAt: snapshot.at,
    };
    await this.store.beginSync(intent, next);

    let attempted = false;
    let saved: AppData;
    try {
      const current = await readManaged(api, name);
      assertActivationAllowed(current);
      if (current.value !== before.value || current.selected !== before.selected) {
        throw new Error('专属规则在同步前发生变化，请刷新状态后重试。');
      }
      attempted = true;
      // The Whistle API adds and selects in one call. Read both back before
      // publishing the local snapshot so a silent failure remains recoverable.
      await api.rules.add(name, snapshot.rules, true);
      const verify = await readManaged(api, name);
      if (verify.value !== snapshot.rules || !verify.selected || !verify.multiSelect || verify.disabled) {
        throw new Error('Whistle 未确认专属规则生效，请检查多选模式和全局规则。');
      }
      saved = await this.store.save(next);
    } catch (error) {
      try {
        if (!attempted) {
          await this.store.clearSync();
        } else {
          const latest = await this.store.load();
          if (committed(latest, intent)) {
            // A filesystem error after a successful rename can reach save().
            // The verified snapshot already committed, so keep it in Whistle.
            await this.store.clearSync().catch(() => {});
            return { data: latest, status: await this.statusNow() };
          }
          await this.recoverInterrupted(previous, connection);
        }
      } catch (recoveryError) {
        throw new Error(message(error) + '。同步中断，恢复尚未完成：' + message(recoveryError), { cause: error });
      }
      throw error;
    }
    // A stale journal left after a successful commit is recognized by the
    // snapshot timestamp and digest on the next status check or operation.
    await this.store.clearSync().catch(() => {});
    return { data: saved, status: await this.statusNow() };
  }

  private snapshot(data: AppData, rules: string): AppliedSnapshot {
    const previous = data.lastApplied ? Date.parse(data.lastApplied.at) + 1 : 0;
    return {
      hash: configurationHash(data.projects),
      at: new Date(Math.max(Date.now(), previous)).toISOString(),
      ruleName: this.ruleName(data),
      rules,
      projects: data.projects,
    };
  }

  apply(): Promise<ApplyResult> {
    return this.serial(async () => {
      const data = await this.store.load();
      validateForApply(data);
      const connection = await this.connect(data);
      const before = await this.recoverInterrupted(data, connection);
      assertActivationAllowed(before);
      if (!owned(data, this.ruleName(data), before.value)) throw new Error(EXTERNAL_CONFLICT);
      const fixture = await this.store.writeFixtures(data);
      const lastApplied = this.snapshot(data, compileRules(data, fixture));
      return this.applyTransition(data, { ...data, lastApplied }, connection, before);
    });
  }

  disable(): Promise<ConnectionStatus> {
    return this.serial(async () => {
      const data = await this.store.load();
      const name = this.ruleName(data);
      const connection = await this.connect(data);
      const intent = await this.store.pendingSync();
      const view = await readManaged(connection.api, name);
      if (view.selected) {
        const knownAttempt = intent && intent.ruleName === name && !committed(data, intent)
          && sameConnection(connection, intent) && knownPendingValue(view, intent);
        if (!knownAttempt && !owned(data, name, view.value)) throw new Error(EXTERNAL_CONFLICT);
        await this.stopSelected(connection.api, name);
      }
      return this.statusNow();
    });
  }

  restore(): Promise<ApplyResult> {
    return this.serial(async () => {
      const data = await this.store.load();
      const connection = await this.connect(data);
      const intent = await this.store.pendingSync();
      const before = await this.recoverInterrupted(data, connection);
      const name = this.ruleName(data);
      if (!owned(data, name, before.value)) throw new Error(EXTERNAL_CONFLICT);
      if (!data.lastApplied) {
        if (intent) return { data, status: await this.statusNow() };
        throw new Error('还没有可以恢复的已应用配置。');
      }
      assertActivationAllowed(before);
      const recovery = { ...data, projects: data.lastApplied.projects };
      validateForApply(recovery);
      const fixture = await this.store.repairFixtures(recovery);
      const lastApplied = this.snapshot(recovery, compileRules(recovery, fixture));
      return this.applyTransition(data, { ...data, lastApplied }, connection, before);
    });
  }

  startWhistle(): Promise<ConnectionStatus> {
    return this.serial(async () => {
      const data = await this.store.load();
      await this.access.start(data.settings.w2Path);
      return this.statusNow();
    });
  }

  enableMultiSelect(): Promise<ConnectionStatus> {
    return this.serial(async () => {
      const data = await this.store.load();
      const { api } = await this.access.resolve(data.settings.w2Path);
      await api.rules.setMultiSelect(true);
      return this.statusNow();
    });
  }

  enableRules(): Promise<ConnectionStatus> {
    return this.serial(async () => {
      const data = await this.store.load();
      const { api } = await this.access.resolve(data.settings.w2Path);
      await api.rules.turnOn();
      return this.statusNow();
    });
  }

  importBackup(input: unknown): Promise<AppData> {
    return this.serial(() => this.store.importBackup(input));
  }

  exportBackup() {
    return this.serial(() => this.store.exportBackup());
  }
}
