import { Download, ExternalLink, FolderOpen, RefreshCw, Unplug } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { timeLabel } from './model';
import { Button, Dialog, Notice, Switch } from './ui';
import type { useWorkspace } from './workspace';

export function Settings({ workspace, close, restore, dataOnly }: {
  workspace: ReturnType<typeof useWorkspace>; close: () => void; restore: () => void; dataOnly: boolean;
}) {
  const {
    status, statusError, busy, commandError, clearCommandError, notice, clearNotice, data,
    refresh, start, testConnection, connectionTest, exportCertificate,
    enableMultiSelect, enableRules, openWhistle, openDataFolder,
    importBackup, exportBackup,
    systemProxy, systemProxyError, setSystemProxy, releaseSystemProxy,
  } = workspace;
  const [confirmRelease, setConfirmRelease] = useState(false);
  const proxyCopy = !systemProxy ? '正在读取 macOS 代理设置…' : !systemProxy.supported ? '系统代理开关仅支持 macOS。'
    : systemProxy.state === 'on' ? `已接管 HTTP/HTTPS → ${systemProxy.address}`
    : systemProxy.state === 'changed' ? '配置已变更或操作未完成，可尝试关闭开关恢复。'
    : systemProxy.state === 'external' ? '当前使用外部配置；开启后会保存原配置。'
    : systemProxy.state === 'error' ? '暂时无法确认系统代理状态。' : '未由本应用接管。';

  const proxyMoved = !!systemProxy?.managed && !!status?.running && !!systemProxy.address && status.address !== systemProxy.address;
  const engineStatus = statusError ? '状态读取失败'
    : !status ? '正在检测…'
    : status.running ? `运行中${status.version ? ` · ${status.version}` : ''}` : '未运行';
  return <Dialog title={dataOnly ? '数据与备份' : '连接设置'} close={close} className="settings-dialog">
    <div className="dialog__body settings-body">
      {commandError && <Notice error close={clearCommandError}>{commandError}</Notice>}
      {notice && <Notice close={clearNotice}>{notice}</Notice>}
      {!dataOnly && statusError && <Notice error>{statusError}</Notice>}
      {!dataOnly && status?.error && <Notice error>{status.error}</Notice>}
      {!dataOnly && <section className="settings-section" aria-labelledby="connection-setup">
        <h3 id="connection-setup">代理配置指南</h3>
        <Setting name="应用内置 Whistle" value={<>
          <div className="engine-state" role="status">
            <span>{engineStatus}</span>
            {status?.running && status.address && !statusError && <code>{status.address}</code>}
          </div>
          <span>打开应用时自动启动。关闭窗口后继续运行。</span>
        </>}>
          <Button onClick={() => void refresh()} disabled={!!busy}><RefreshCw size={14} aria-hidden="true" /> 刷新</Button>
          {(statusError || status && !status.running) && <Button onClick={start} disabled={!!busy}>重试启动</Button>}
          {status?.running && status.address && !statusError && <Button onClick={openWhistle} disabled={!!busy}>
            <ExternalLink size={14} aria-hidden="true" /> 打开 Whistle
          </Button>}
        </Setting>
        <Setting name="HTTPS 根证书" value={<>
          <span>在 macOS 上双击导出的 .crt 文件，添加到「登录」钥匙串。打开证书的「信任」选项，选择「始终信任」，然后重启浏览器。</span>
          {status?.running && status.httpsEnabled !== undefined && <span>
            Whistle 的 HTTPS 解密{status.httpsEnabled ? '已开启' : '未开启，请在 Whistle 中开启'}。证书信任状态请在钥匙串访问中确认。
          </span>}
        </>}>
          <Button onClick={exportCertificate} disabled={!status?.running || !!statusError || !!busy}>
            <Download size={14} aria-hidden="true" /> 导出根证书
          </Button>
        </Setting>
        <Setting name="系统代理" value={<>
          <span role="status">{proxyCopy}</span>
          {!!systemProxy?.services.length && <span>{systemProxy.services.join('、')}</span>}
        </>}>
          <Switch label="系统代理" checked={!!systemProxy?.managed}
            disabled={!!busy || !systemProxy?.supported || (!systemProxy.managed && (!status?.running || !!statusError || systemProxy.state === 'error' || !!systemProxyError))}
            change={setSystemProxy} />
        </Setting>
        {systemProxyError && <Notice error>{systemProxyError}</Notice>}
        {systemProxy?.managed && status && !status.running && <Notice error>Whistle 未运行，系统代理可能影响联网。请关闭系统代理开关，恢复原配置。</Notice>}
        {proxyMoved && <Notice error>Whistle 地址已变化。请先关闭系统代理恢复原配置，再重新开启以使用新地址。</Notice>}
        {systemProxy?.message && <p className="muted settings-note">{systemProxy.message}</p>}
        {systemProxy?.managed && systemProxy.state === 'changed' && <div className="proxy-recovery">
          {!confirmRelease ? <Button onClick={() => setConfirmRelease(true)} disabled={!!busy}>保留当前设置</Button> : <>
            <p>保留当前系统代理并结束接管？这不会恢复开启前的配置；原配置备份仍会保留。</p>
            <div><Button onClick={() => setConfirmRelease(false)} disabled={!!busy}>取消</Button>
              <Button onClick={() => { setConfirmRelease(false); releaseSystemProxy(); }} disabled={!!busy}>确认保留</Button></div>
          </>}
        </div>}
        <p className="muted settings-note">开启系统代理后，浏览器请选择使用系统代理，避免扩展覆盖。关闭开关或退出应用时会恢复本应用接管前的配置。macOS 可能要求授权，恢复失败时应用会暂停退出。</p>
        <Setting name="代理连接测试" value={<>
          <span>向本地服务发出一条经过内置 Whistle 的 HTTP 请求。浏览器是否使用系统代理、HTTPS 证书是否受信任，请在浏览器中确认。</span>
          {status?.running && !statusError && connectionTest && <span
            className={`connection-test${connectionTest.ok ? '' : ' connection-test--error'}`}
            role={connectionTest.ok ? 'status' : 'alert'}>{connectionTest.message}</span>}
        </>}>
          <Button onClick={testConnection} disabled={!status?.running || !!statusError || !!busy}>测试连接</Button>
        </Setting>
      </section>}
      {!dataOnly && <section className="settings-section">
        <h3>规则管理</h3>
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
