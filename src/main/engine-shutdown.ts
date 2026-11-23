import type { SystemProxyStatus } from '../shared/types';
import { t } from '../shared/i18n';

export async function shutdownEngine(
  proxy: { status(): Promise<SystemProxyStatus>; disable(): Promise<SystemProxyStatus> },
  engine: { stop(): Promise<void> },
): Promise<void> {
  const status = await proxy.status();
  if (status.managed) {
    const restored = await proxy.disable();
    if (restored.managed || restored.state === 'error') {
      throw new Error(restored.message || t('未能恢复系统代理。应用将保持运行，请在连接设置中处理后再退出。', 'Could not restore the system proxy. The app will stay open. Resolve this in connection settings before quitting.'));
    }
  }
  await engine.stop();
}
