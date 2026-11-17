import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppData, ConnectionStatus, DesktopBridge, Project, SystemProxyStatus } from '../shared/types';
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
  const [systemProxy, setSystemProxyStatus] = useState<SystemProxyStatus>();
  const [systemProxyError, setSystemProxyError] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('clean');
  const [saveError, setSaveError] = useState('');
  const [busy, setBusy] = useState('');
  const [commandError, setCommandError] = useState('');
  const [notice, setNotice] = useState('');
  const [connectionTest, setConnectionTest] = useState<Awaited<ReturnType<DesktopBridge['testConnection']>>>();

  const draft = useRef<AppData | undefined>(undefined);
  const revision = useRef(0);
  const savedRevision = useRef(0);
  const saveOperation = useRef<Promise<void> | undefined>(undefined);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const command = useRef(false);
  const preparingQuit = useRef(false);
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
    const [connection, proxy] = await Promise.allSettled([bridge.status(), bridge.systemProxyStatus()]);
    if (request !== statusRequest.current) return;
    if (connection.status === 'fulfilled') receiveStatus(connection.value);
    else setStatusError(messageFrom(connection.reason));
    if (proxy.status === 'fulfilled') {
      setSystemProxyStatus(proxy.value);
      setSystemProxyError('');
    } else setSystemProxyError(messageFrom(proxy.reason));
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
    const flushBeforeClose = async () => {
      do {
        await flush();
      } while (savedRevision.current !== revision.current);
    };
    const unsubscribePrepareQuit = bridge.onPrepareQuit(async () => {
      preparingQuit.current = true;
      try {
        await flushBeforeClose();
      } finally {
        preparingQuit.current = false;
      }
    });
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
          await flushBeforeClose();
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
    return () => {
      unsubscribePrepareQuit();
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [bridge, flush]);

  const edit = useCallback((update: (current: AppData) => AppData) => {
    if (!draft.current || command.current || preparingQuit.current) return;
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
    if (!bridge || command.current || preparingQuit.current) return;
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
    data, loadError, load, status, statusError, systemProxy, systemProxyError, refresh, saveState, saveError, flush,
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
    start: () => void run('正在启动内置 Whistle', api => {
      setConnectionTest(undefined);
      return api.startWhistle();
    }, receiveStatus),
    testConnection: () => void run('正在发送代理测试请求', api => {
      setConnectionTest(undefined);
      return api.testConnection();
    }, setConnectionTest),
    connectionTest,
    exportCertificate: () => void run('正在导出根证书', api => api.exportCertificate(), exported => {
      setNotice(exported ? '根证书已导出。请在钥匙串访问中安装并信任它。' : '已取消导出根证书。');
    }),
    enableMultiSelect: () => void run('正在开启多选', api => api.enableMultiSelect(), receiveStatus),
    enableRules: () => void run('正在启用规则', api => api.enableRules(), receiveStatus),
    setSystemProxy: (enabled: boolean) => void run(enabled ? '正在设置系统代理，请完成系统授权' : '正在恢复原代理，请完成系统授权',
      api => api.setSystemProxy(enabled), value => {
        setSystemProxyStatus(value);
        setSystemProxyError('');
        if (value.state === 'error' || !value.supported || (enabled ? value.state !== 'on' : value.managed)) {
          setCommandError(value.message || '系统代理设置未完成，请检查状态后重试。');
        } else setNotice(enabled ? '已将系统 HTTP/HTTPS 代理指向 Whistle。' : '已恢复开启前的系统代理设置。');
      }),
    releaseSystemProxy: () => void run('正在保留当前设置', api => api.releaseSystemProxy(), value => {
      setSystemProxyStatus(value);
      setSystemProxyError('');
      if (value.managed || value.state === 'error') setCommandError(value.message || '系统代理状态已变化，请刷新后重试。');
      else setNotice('已保留当前系统设置并结束接管。原配置备份仍保存在应用数据目录。');
    }),
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
