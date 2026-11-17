import type { AppData, ApplyResult, ConnectionStatus } from '../shared/types';
import { compileRules, configurationHash } from '../core/compiler';
import { validateForApply } from '../core/model';
import { DataStore } from './store';
import { compatibleVersion, ruleValue, type WhistleAccess, type WhistleApi } from './whistle';

export class SyncController {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly store: DataStore, readonly access: WhistleAccess) {}
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation); this.queue = next.catch(() => undefined); return next;
  }
  ruleName(data: AppData) { return `MockManager-${data.installationId}`; }
  load() { return this.serial(() => this.store.load()); }
  saveDraft(input: AppData) {
    return this.serial(async () => {
      const current = await this.store.load();
      return this.store.save({...input, installationId:current.installationId, schemaVersion:1, lastApplied:current.lastApplied});
    });
  }
  status() { return this.serial(() => this.statusNow()); }
  private async statusNow(): Promise<ConnectionStatus> {
    const data = await this.store.load();
    const state: ConnectionStatus = { installed:false, running:false, w2Path:data.settings.w2Path, syncState:'offline', ruleName:this.ruleName(data), lastAppliedAt:data.lastApplied?.at };
    try {
      state.w2Path = await this.access.find(data.settings.w2Path); state.installed = true;
      const {api} = await this.access.resolve(state.w2Path);
      const meta = await api.network.getStatus();
      if (!compatibleVersion(meta.version)) throw new Error('Whistle 版本过低，请升级至 2.10.7 或更新版本。');
      state.running = true; state.version = meta.version; state.port = meta.port || 8899;
      const [rules, https, managed] = await Promise.all([api.rules.getStatus(), api.isEnabledHTTPS(), api.rules.get(state.ruleName!)]);
      const existing = ruleValue(managed);
      state.multiSelect = rules.multiSelect; state.rulesDisabled = rules.disabled; state.httpsEnabled = https;
      state.managedSelected = !!rules.list.find(r => r.name === state.ruleName)?.selected;
      if (existing && (!data.lastApplied || existing.value !== data.lastApplied.rules)) {
        state.syncState = 'conflict'; state.error = '专属规则在 Whistle 中被外部修改，请先处理冲突。';
      } else if (!existing || !state.managedSelected || rules.disabled) state.syncState = 'disabled';
      else if (data.lastApplied?.hash !== configurationHash(data.projects)) state.syncState = 'pending';
      else {
        try { await this.store.verifyFixtures({...data, projects:data.lastApplied.projects}); state.syncState = 'synced'; }
        catch { state.syncState = 'conflict'; state.error = '已应用的响应文件缺失或被修改，请恢复上次应用。'; }
      }
      return state;
    } catch (error) { state.error = error instanceof Error ? error.message : String(error); return state; }
  }
  private async ready(data: AppData): Promise<WhistleApi> {
    const {api} = await this.access.resolve(data.settings.w2Path);
    const meta = await api.network.getStatus();
    if (!compatibleVersion(meta.version)) throw new Error('Whistle 版本过低，请升级至 2.10.7 或更新版本。');
    const rules = await api.rules.getStatus();
    if (!rules.multiSelect) throw new Error('请先在连接设置中启用多选模式，避免停用你已有的规则。');
    if (rules.disabled) throw new Error('Whistle 全局规则已关闭，请先在连接设置中启用。');
    const existing = ruleValue(await api.rules.get(this.ruleName(data)));
    if (existing && (!data.lastApplied || existing.value !== data.lastApplied.rules)) throw new Error('专属规则存在外部修改冲突。请在 Whistle 中恢复该规则后重试，或先导出备份。');
    return api;
  }
  apply() { return this.serial(() => this.applyNow()); }
  private async applyNow(): Promise<ApplyResult> {
    const data = await this.store.load(); validateForApply(data);
    const api = await this.ready(data);
    const fixture = await this.store.writeFixtures(data);
    const rules = compileRules(data, fixture);
    const name = this.ruleName(data);
    await api.rules.add(name, rules, true);
    const selected = await api.rules.select(name);
    const verify = ruleValue(await api.rules.get(name));
    const state = await api.rules.getStatus();
    if (!selected || verify?.value !== rules || !state.list.some(r => r.name === name && r.selected)) throw new Error('Whistle 未确认应用成功。请检查连接后恢复上次应用或重试。');
    const saved = await this.store.save({...data, lastApplied:{hash:configurationHash(data.projects), at:new Date().toISOString(), ruleName:name, rules, projects:structuredClone(data.projects)}});
    return { data:saved, status:await this.statusNow() };
  }
  disable() { return this.serial(async () => {
    const data = await this.store.load(); const {api} = await this.access.resolve(data.settings.w2Path);
    await api.rules.unselect(this.ruleName(data)); return this.statusNow();
  }); }
  restore() { return this.serial(async () => {
    const data = await this.store.load();
    if (!data.lastApplied) throw new Error('还没有可以恢复的已应用配置。');
    const {api} = await this.access.resolve(data.settings.w2Path);
    const state = await api.rules.getStatus();
    if (!state.multiSelect || state.disabled) throw new Error('请先启用 Whistle 多选模式和全局规则。');
    // Explicit recovery is allowed to repair a partially written managed file.
    const snapshot = structuredClone(data.lastApplied);
    const recovery = {...data, projects:snapshot.projects};
    validateForApply(recovery);
    const fixture = await this.store.repairFixtures(recovery);
    const rules = compileRules(recovery, fixture);
    await api.rules.add(this.ruleName(data), rules, true);
    await api.rules.select(this.ruleName(data));
    const verify = ruleValue(await api.rules.get(this.ruleName(data)));
    if (verify?.value !== rules) throw new Error('恢复失败：Whistle 规则校验不一致。');
    const saved = await this.store.save({...recovery, lastApplied:{...snapshot,rules,at:new Date().toISOString()}});
    return {data:saved, status:await this.statusNow()};
  }); }
  startWhistle() { return this.serial(async () => { const data = await this.store.load(); await this.access.start(data.settings.w2Path); return this.statusNow(); }); }
  enableMultiSelect() { return this.serial(async () => { const data = await this.store.load(); const {api} = await this.access.resolve(data.settings.w2Path); await api.rules.setMultiSelect(true); return this.statusNow(); }); }
  enableRules() { return this.serial(async () => { const data = await this.store.load(); const {api} = await this.access.resolve(data.settings.w2Path); await api.rules.turnOn(); return this.statusNow(); }); }
  importBackup(input: unknown) { return this.serial(() => this.store.importBackup(input)); }
  exportBackup() { return this.serial(() => this.store.exportBackup()); }
}
