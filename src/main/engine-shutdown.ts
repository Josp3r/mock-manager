import type { SystemProxyStatus } from '../shared/types';

export async function shutdownEngine(
  proxy: { status(): Promise<SystemProxyStatus>; disable(): Promise<SystemProxyStatus> },
  engine: { stop(): Promise<void> },
): Promise<void> {
  const status = await proxy.status();
  if (status.managed) {
    const restored = await proxy.disable();
    if (restored.managed || restored.state === 'error') {
      throw new Error(restored.message || '未能恢复系统代理。应用将保持运行，请在连接设置中处理后再退出。');
    }
  }
  await engine.stop();
}
