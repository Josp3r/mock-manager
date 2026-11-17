import { ExternalLink, FolderOpen, RefreshCw, Unplug } from 'lucide-react';
import type { ReactNode } from 'react';
import { timeLabel } from './model';
import { Button, Dialog, Notice } from './ui';
import type { useWorkspace } from './workspace';

export function Settings({ workspace, close, restore, dataOnly }: {
  workspace: ReturnType<typeof useWorkspace>; close: () => void; restore: () => void; dataOnly: boolean;
}) {
  const {
    status, statusError, busy, commandError, clearCommandError, notice, clearNotice, data,
    refresh, chooseW2, start, enableMultiSelect, enableRules, openWhistle, openDataFolder,
    importBackup, exportBackup,
  } = workspace;

  const path = status?.w2Path || data?.settings.w2Path;
  return <Dialog title={dataOnly ? '数据与备份' : '连接设置'} close={close} className="settings-dialog">
    <div className="dialog__body settings-body">
      {commandError && <Notice error close={clearCommandError}>{commandError}</Notice>}
      {notice && <Notice close={clearNotice}>{notice}</Notice>}
      {!dataOnly && statusError && <Notice error>{statusError}</Notice>}
      {!dataOnly && status?.error && <Notice error>{status.error}</Notice>}
      {!dataOnly && <section className="settings-section">
        <h3>Whistle</h3>
        <Setting name="连接状态"
          value={!status ? '正在检测…' : status.running ? `运行中${status.version ? `（${status.version}）` : ''}` : status.installed ? '未运行' : '未找到 w2'}>
          <Button onClick={() => void refresh()} disabled={!!busy}><RefreshCw size={14} aria-hidden="true" /> 刷新</Button>
          {status?.installed && !status.running && <Button onClick={start} disabled={!!busy}>启动 Whistle</Button>}
        </Setting>
        <Setting name="w2 路径" value={path ? <code className="setting-path">{path}</code> : '自动检测'}>
          <Button onClick={chooseW2} disabled={!!busy}>选择 w2</Button>
        </Setting>
        <Setting name="代理端口与 HTTPS" value={status?.running
          ? `${status.port ? `127.0.0.1:${status.port}` : '端口未知'}，HTTPS 解密${status.httpsEnabled ? '已开启' : '未开启'}`
          : '连接后可查看'}>
          <Button onClick={openWhistle} disabled={!status?.port || !!busy}><ExternalLink size={14} aria-hidden="true" /> 打开 Whistle</Button>
        </Setting>
        <p className="muted settings-note">请在系统或浏览器配置 Whistle 代理。拦截 HTTPS 时，还需在 Whistle 安装并信任根证书、开启 HTTPS 解密。</p>
        <Setting name="多选规则"
          value={status?.multiSelect === undefined ? '连接后可查看' : status.multiSelect ? '已开启' : '应用前需开启，以保留已有规则的选中状态。'}>
          {status?.running && status.multiSelect === false && <Button onClick={enableMultiSelect} disabled={!!busy}>开启多选规则</Button>}
        </Setting>
        <Setting name="全局规则"
          value={status?.rulesDisabled === undefined ? '连接后可查看' : status.rulesDisabled ? '已关闭，开启后会恢复所有已选中的 Whistle 规则。' : '已开启'}>
          {status?.running && status.rulesDisabled && <Button onClick={enableRules} disabled={!!busy}>启用全局规则</Button>}
        </Setting>
        <Setting name="专属规则"
          value={<>{status?.ruleName ? <code className="setting-path">{status.ruleName}</code> : '连接后可查看'}
            {data?.lastApplied && <span>上次应用 {timeLabel(data.lastApplied.at)}</span>}</>}>
          {status?.canRecover && <Button onClick={restore} disabled={!!busy || !status.running}>恢复专属规则</Button>}
        </Setting>
      </section>}
      <section className="settings-section">
        {!dataOnly && <h3>数据与备份</h3>}
        <Setting name="项目备份" value="备份包含项目、接口和场景。导入项目的接口默认停用。">
          <Button onClick={importBackup} disabled={!!busy}>导入备份</Button>
          <Button onClick={exportBackup} disabled={!!busy}>导出备份</Button>
        </Setting>
        <Setting name="本地存储" value="草稿自动保存到应用数据目录。">
          <Button onClick={openDataFolder} disabled={!!busy}><FolderOpen size={14} aria-hidden="true" /> 打开数据目录</Button>
        </Setting>
      </section>
    </div>
    <footer className="dialog__footer">
      {busy && <span className="settings-busy" role="status"><Unplug size={14} aria-hidden="true" />{busy}…</span>}
      <Button onClick={close}>完成</Button>
    </footer>
  </Dialog>;
}

function Setting({ name, value, children }: { name: string; value: ReactNode; children?: ReactNode }) {
  return <div className="setting">
    <div className="setting__description"><span>{name}</span><div className="setting__value">{value}</div></div>
    <div className="setting__actions">{children}</div>
  </div>;
}
