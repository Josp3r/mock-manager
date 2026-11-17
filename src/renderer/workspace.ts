import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppData, ConnectionStatus, DesktopBridge, Project } from '../shared/types';
import { maxResponseLength } from './model';

type SaveState = 'clean' | 'pending' | 'saving' | 'error';

export function messageFrom(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  return error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

export function useWorkspace() {
  const bridge = window.mockManager as DesktopBridge | undefined;
  const [data, setData] = useState<AppData>();
  const [loadError, setLoadError] = useState('');
  const [status, setStatus] = useState<ConnectionStatus>();
  const [statusError, setStatusError] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('clean');
  const [saveError, setSaveError] = useState('');
  const [busy, setBusy] = useState('');
  const [commandError, setCommandError] = useState('');
  const [notice, setNotice] = useState('');

  const draft = useRef<AppData | undefined>(undefined);
  const revision = useRef(0);
  const savedRevision = useRef(0);
  const saveOperation = useRef<Promise<void> | undefined>(undefined);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const command = useRef(false);
  const statusRequest = useRef(0);

  const publish = useCallback((next: AppData) => {
    draft.current = next;
    setData(next);
  }, []);

  const accept = useCallback((next: AppData) => {
    savedRevision.current = revision.current;
    publish(next);
    setSaveState('clean');
    setSaveError('');
  }, [publish]);

  const load = useCallback(async () => {
    setLoadError('');
    if (!bridge) {
      setLoadError('请在 Whistle Mock Manager 桌面应用中打开工作台。');
      return;
    }
    try {
      accept(await bridge.load());
    } catch (error) {
      setLoadError(messageFrom(error));
    }
  }, [accept, bridge]);

  const receiveStatus = useCallback((next: ConnectionStatus) => {
    statusRequest.current += 1;
    setStatus(next);
    setStatusError('');
  }, []);

  const refresh = useCallback(async () => {
    if (!bridge || command.current) return;
    const request = ++statusRequest.current;
    try {
      const next = await bridge.status();
      if (request === statusRequest.current) receiveStatus(next);
    } catch (error) {
      if (request === statusRequest.current) setStatusError(messageFrom(error));
    }
  }, [bridge, receiveStatus]);

  useEffect(() => {
    void load();
    void refresh();
    const timer = setInterval(() => void refresh(), 8_000);
    return () => { clearInterval(timer); clearTimeout(saveTimer.current); };
  }, [load, refresh]);

  const flush = useCallback(() => {
    clearTimeout(saveTimer.current);
    if (saveOperation.current) return saveOperation.current;
    if (!bridge || savedRevision.current === revision.current) return Promise.resolve();

    const operation = (async () => {
      setSaveState('saving');
      try {
        while (draft.current && savedRevision.current !== revision.current) {
          const sentRevision = revision.current;
          const saved = await bridge.save(draft.current);
          savedRevision.current = sentRevision;
          if (revision.current === sentRevision) publish(saved);
        }
        setSaveError('');
        setSaveState('clean');
      } catch (error) {
        setSaveError(messageFrom(error));
        setSaveState('error');
        throw error;
      }
    })();
    saveOperation.current = operation;
    const clearOperation = () => { saveOperation.current = undefined; };
    void operation.then(clearOperation, clearOperation);
    return operation;
  }, [bridge, publish]);

  useEffect(() => {
    if (!bridge) return;
    let closing = false;
    let permitClose = false;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (permitClose) {
        permitClose = false;
        return;
      }
      if (savedRevision.current === revision.current && !saveOperation.current) return;
      event.preventDefault();
      event.returnValue = false;
      if (closing) return;
      closing = true;
      void (async () => {
        try {
          do {
            await flush();
          } while (savedRevision.current !== revision.current);
          permitClose = true;
          window.close();
        } catch {
          // The failed save is surfaced in the workbench and can be retried.
        } finally {
          closing = false;
        }
      })();
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [bridge, flush]);

  const edit = useCallback((update: (current: AppData) => AppData) => {
    if (!draft.current || command.current) return;
    const next = update(draft.current);
    if (next === draft.current) return;
    revision.current += 1;
    publish(next);
    setSaveState('pending');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flush().catch(() => {}), 300);
  }, [flush, publish]);

  const editProject = (id: string, update: (project: Project) => Project) =>
    edit(current => ({
      ...current,
      projects: current.projects.map(project => project.id === id ? update(project) : project),
    }));

  async function run<T>(
    label: string,
    action: (api: DesktopBridge) => Promise<T>,
    onResult?: (value: T) => void,
    saveDraft = false,
  ) {
    if (!bridge || command.current) return;
    command.current = true;
    statusRequest.current += 1;
    setBusy(label);
    setCommandError('');
    setNotice('');
    try {
      if (saveDraft) await flush();
      const result = await action(bridge);
      onResult?.(result);
    } catch (error) {
      setCommandError(messageFrom(error));
    } finally {
      command.current = false;
      setBusy('');
      void refresh();
    }
  }

  return {
    data, loadError, load, status, statusError, refresh, saveState, saveError, flush,
    busy, commandError, clearCommandError: () => setCommandError(''),
    notice, clearNotice: () => setNotice(''), edit, editProject,
    apply: () => void run('正在应用', api => api.apply(), value => {
      accept(value.data);
      receiveStatus(value.status);
    }, true),
    disable: () => void run('正在停用', api => api.disable(), receiveStatus),
    restore: () => void run('正在恢复', api => api.restore(), value => {
      accept(value.data);
      receiveStatus(value.status);
    }, true),
    start: () => void run('正在启动', api => api.startWhistle(), receiveStatus, true),
    enableMultiSelect: () => void run('正在开启多选', api => api.enableMultiSelect(), receiveStatus),
    enableRules: () => void run('正在启用规则', api => api.enableRules(), receiveStatus),
    chooseW2: () => void run('正在选择 w2', api => api.chooseW2(), path => {
      if (path && draft.current) {
        accept({ ...draft.current, settings: { ...draft.current.settings, w2Path: path } });
      }
    }, true),
    importBackup: () => void run('正在导入备份', api => api.importBackup(), value => {
      if (value) {
        accept(value);
        setNotice('已导入备份。导入的接口默认停用。');
      }
    }, true),
    exportBackup: () => void run('正在导出备份', api => api.exportBackup(), value => {
      if (value) setNotice('备份已导出。');
    }, true),
    importResponse: async () => {
      if (!bridge) return null;
      let body: string | null = null;
      await run('正在导入 JSON', async api => {
        const value = await api.importResponse();
        if (value && value.length > maxResponseLength) throw new Error('响应正文最多可以包含 200 万个字符。');
        return value;
      }, value => { body = value; });
      return body;
    },
    openWhistle: () => void run('正在打开 Whistle', api => api.openWhistle()),
    openDataFolder: () => void run('正在打开数据目录', api => api.openDataFolder()),
  };
}
