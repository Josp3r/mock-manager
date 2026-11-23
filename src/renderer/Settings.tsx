import { proxyTestSuccessMessage } from '../shared/proxy-messages';
import { Download, FolderOpen, RefreshCw, Unplug } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { getLocale, t } from '../shared/i18n';
import { changeLanguage, useLanguage } from './i18n';
import { timeLabel } from './model';
import { Button, Dialog, Notice, Switch } from './ui';
import { messageFrom, type useWorkspace } from './workspace';

export function Settings({ workspace, close, restore, dataOnly }: {
  workspace: ReturnType<typeof useWorkspace>; close: () => void; restore: () => void; dataOnly: boolean;
}) {
  const {
    status, statusError, busy, busyLabel, commandError, clearCommandError, notice, clearNotice, data,
    refresh, start, testConnection, connectionTest, exportCertificate,
    enableMultiSelect, enableRules, openDataFolder,
    importBackup, exportBackup,
    systemProxy, systemProxyError, setSystemProxy, releaseSystemProxy,
  } = workspace;
  const language = useLanguage();
  const mac = window.mockManager?.platform === 'darwin';
  const windows = window.mockManager?.platform === 'win32';
  const [languageSaving, setLanguageSaving] = useState(false);
  const [languageError, setLanguageError] = useState('');
  const [confirmRelease, setConfirmRelease] = useState(false);
  const proxyCopy = !systemProxy ? t('正在读取系统代理设置…', 'Reading system proxy settings…')
    : !systemProxy.supported ? t('系统代理开关支持 macOS 和 Windows。', 'System proxy control is available on macOS and Windows.')
    : systemProxy.state === 'on' ? t('已接管 HTTP/HTTPS → {address}', 'Managing HTTP/HTTPS → {address}', { address: systemProxy.address ?? '' })
    : systemProxy.state === 'changed' ? t('配置已变更或操作未完成，可尝试关闭开关恢复。', 'Settings changed or an operation is incomplete. Turn off the switch to try restoring them.')
    : systemProxy.state === 'external' ? t('当前使用外部配置；开启后会保存原配置。', 'Using external settings. Turning this on saves the current configuration.')
    : systemProxy.state === 'error' ? t('暂时无法确认系统代理状态。', 'Unable to confirm the system proxy status.')
    : t('未由本应用接管。', 'Not managed by this app.');

  const proxyMoved = !!systemProxy?.managed && !!status?.running && !!systemProxy.address && status.address !== systemProxy.address;
  const engineStatus = statusError ? t('状态读取失败', 'Unable to read status')
    : !status ? t('正在检测…', 'Checking…')
    : status.running ? `${t('运行中', 'Running')}${status.version ? ` · ${status.version}` : ''}` : t('未运行', 'Stopped');
  return <Dialog title={dataOnly ? t('数据与备份', 'Data & backups') : t('连接设置', 'Connection settings')} close={close} className="settings-dialog">
    <div className="dialog__body settings-body">
      {commandError && <Notice error close={clearCommandError}>{commandError}</Notice>}
      {notice && <Notice close={clearNotice}>{notice}</Notice>}
      {!dataOnly && <section className="settings-section" aria-labelledby="language-settings">
        <h3 id="language-settings">{t('语言', 'Language')}</h3>
        <Setting name={t('显示语言', 'Display language')} value={t('立即生效，并在下次打开时保留。', 'Changes apply immediately and are remembered next time.')}>
          <select className="language-select" aria-label={t('语言', 'Language')} value={language.preference}
            disabled={!!busy || languageSaving} onChange={event => {
              const preference = event.target.value as typeof language.preference;
              setLanguageSaving(true);
              setLanguageError('');
              void changeLanguage(preference).then(() => refresh()).catch((error: unknown) => {
                setLanguageError(messageFrom(error));
              }).finally(() => setLanguageSaving(false));
            }}>
            <option value="system">{t('跟随系统', 'System default')}</option>
            <option value="zh-CN">简体中文</option>
            <option value="en">English</option>
          </select>
        </Setting>
        {languageError && <Notice error>{languageError}</Notice>}
      </section>}
      {!dataOnly && statusError && <Notice error>{statusError}</Notice>}
      {!dataOnly && status?.error && <Notice error>{status.error}</Notice>}
      {!dataOnly && <section className="settings-section" aria-labelledby="connection-setup">
        <h3 id="connection-setup">{t('代理配置指南', 'Proxy setup')}</h3>
        <Setting name={t('本地代理引擎', 'Local proxy engine')} value={<>
          <div className="engine-state" role="status">
            <span>{engineStatus}</span>
            {status?.running && status.address && !statusError && <code>{status.address}</code>}
          </div>
          <span>{mac ? t('打开应用时自动启动。关闭窗口后继续运行。', 'Starts with the app and keeps running when the window is closed.')
            : t('打开应用时自动启动。关闭应用时恢复系统代理并停止引擎。', 'Starts with the app. Closing the app restores the system proxy and stops the engine.')}</span>
        </>}>
          <Button onClick={() => void refresh()} disabled={!!busy}><RefreshCw size={14} aria-hidden="true" /> {t('刷新', 'Refresh')}</Button>
          {(statusError || status && !status.running) && <Button onClick={start} disabled={!!busy}>{t('重试启动', 'Retry start')}</Button>}
        </Setting>
        <Setting name={t('HTTPS 根证书', 'HTTPS root certificate')} value={<>
          <span>{mac ? t('在 macOS 上双击导出的 .crt 文件，添加到「登录」钥匙串。打开证书的「信任」选项，选择「始终信任」，然后重启浏览器。', 'On macOS, open the exported .crt file and add it to the login keychain. Open its Trust settings, choose Always Trust, then restart your browser.')
            : windows ? t('双击导出的 .crt 文件，选择「安装证书」→「当前用户」，将证书放入「受信任的根证书颁发机构」，然后重启浏览器。', 'Open the exported .crt file, choose Install Certificate → Current User, and place it in Trusted Root Certification Authorities. Then restart your browser.')
            : t('将导出的公开根证书导入系统或浏览器的受信任证书存储，然后重启浏览器。', 'Import the exported public root certificate into your system or browser trust store, then restart the browser.')}</span>
          {status?.running && status.httpsEnabled !== undefined && <span>
            {status.httpsEnabled
              ? t('HTTPS 解密已开启。请在系统证书管理器中确认信任状态。', 'HTTPS decryption is enabled. Check trust in your system certificate manager.')
              : t('HTTPS 解密未开启。请在系统证书管理器中确认信任状态。', 'HTTPS decryption is disabled. Check trust in your system certificate manager.')}
          </span>}
        </>}>
          <Button onClick={exportCertificate} disabled={!status?.running || !!statusError || !!busy}>
            <Download size={14} aria-hidden="true" /> {t('导出根证书', 'Export certificate')}
          </Button>
        </Setting>
        <Setting name={t('系统代理', 'System proxy')} value={<>
          <span role="status">{proxyCopy}</span>
          {!!systemProxy?.services.length && <span>{new Intl.ListFormat(getLocale(), { style: 'short', type: 'conjunction' }).format(systemProxy.services)}</span>}
        </>}>
          <Switch label={t('系统代理', 'System proxy')} checked={!!systemProxy?.managed}
            disabled={!!busy || !systemProxy?.supported || (!systemProxy.managed && (!status?.running || !!statusError || systemProxy.state === 'error' || !!systemProxyError))}
            change={setSystemProxy} />
        </Setting>
        {systemProxyError && <Notice error>{systemProxyError}</Notice>}
        {systemProxy?.managed && status && !status.running && <Notice error>{t('本地代理引擎未运行，系统代理可能影响联网。请关闭系统代理开关，恢复原配置。', 'The local engine is stopped, so the system proxy may interrupt your connection. Turn off the system proxy to restore the previous settings.')}</Notice>}
        {proxyMoved && <Notice error>{t('本地代理地址已变化。请先关闭系统代理恢复原配置，再重新开启以使用新地址。', 'The local proxy address changed. Turn the system proxy off to restore the previous settings, then turn it on again to use the new address.')}</Notice>}
        {systemProxy?.message && <p className="muted settings-note">{systemProxy.message}</p>}
        {systemProxy?.managed && systemProxy.state === 'changed' && <div className="proxy-recovery">
          {!confirmRelease ? <Button onClick={() => setConfirmRelease(true)} disabled={!!busy}>{t('保留当前设置', 'Keep current settings')}</Button> : <>
            <p>{t('保留当前系统代理并结束接管？这不会恢复开启前的配置；原配置备份仍会保留。', 'Keep the current system proxy and stop managing it? The previous configuration will not be restored, but its backup will be kept.')}</p>
            <div><Button onClick={() => setConfirmRelease(false)} disabled={!!busy}>{t('取消', 'Cancel')}</Button>
              <Button onClick={() => { setConfirmRelease(false); releaseSystemProxy(); }} disabled={!!busy}>{t('确认保留', 'Confirm keep')}</Button></div>
          </>}
        </div>}
        <p className="muted settings-note">{t('开启系统代理后，浏览器请选择使用系统代理，避免扩展覆盖。关闭开关或退出应用时会恢复本应用接管前的配置；恢复失败时应用会暂停退出。', 'Set your browser to use the system proxy and make sure extensions do not override it. Turning this off or quitting the app restores the previous settings; if restoration fails, the app stays open.')}
          {' '}{mac ? t('macOS 可能要求授权。', 'macOS may request authorization.')
            : windows ? t('Windows 仅管理当前用户的系统 Internet 代理，使用独立代理配置的应用不受此开关控制。', 'On Windows, this manages the current user’s system Internet proxy. Apps with their own proxy settings are unaffected.') : ''}</p>
        <Setting name={t('代理连接测试', 'Proxy connection test')} value={<>
          <span>{t('向本地服务发出一条经过本地代理引擎的 HTTP 请求。浏览器是否使用系统代理、HTTPS 证书是否受信任，请在浏览器中确认。', 'Sends an HTTP request through the local proxy to a local service. Check browser routing and HTTPS certificate trust separately in your browser.')}</span>
          {status?.running && !statusError && connectionTest && <span
            className={`connection-test${connectionTest.ok ? '' : ' connection-test--error'}`}
            role={connectionTest.ok ? 'status' : 'alert'}>{connectionTest.ok ? proxyTestSuccessMessage() : connectionTest.message}</span>}
        </>}>
          <Button onClick={testConnection} disabled={!status?.running || !!statusError || !!busy}>{t('测试连接', 'Test connection')}</Button>
        </Setting>
      </section>}
      {!dataOnly && <section className="settings-section">
        <h3>{t('规则管理', 'Rule management')}</h3>
        <Setting name={t('多选规则', 'Multiple rule sets')}
          value={status?.multiSelect === undefined ? t('连接后可查看', 'Available when connected') : status.multiSelect ? t('已开启', 'Enabled') : t('应用前需开启，以保留已有规则的选中状态。', 'Enable before applying to preserve other selected rule sets.')}>
          {status?.running && status.multiSelect === false && <Button onClick={enableMultiSelect} disabled={!!busy}>{t('开启多选规则', 'Enable multiple rule sets')}</Button>}
        </Setting>
        <Setting name={t('全局规则', 'Global rules')}
          value={status?.rulesDisabled === undefined ? t('连接后可查看', 'Available when connected') : status.rulesDisabled ? t('已关闭，开启后会恢复所有已选中的 Mock 规则。', 'Disabled. Enabling restores all selected Mock rules.') : t('已开启', 'Enabled')}>
          {status?.running && status.rulesDisabled && <Button onClick={enableRules} disabled={!!busy}>{t('启用全局规则', 'Enable global rules')}</Button>}
        </Setting>
        <Setting name={t('专属规则', 'Managed rule set')}
          value={<>{status?.ruleName ? <code className="setting-path">{status.ruleName}</code> : t('连接后可查看', 'Available when connected')}
            {data?.lastApplied && <span>{t('上次应用 {time}', 'Last applied {time}', { time: timeLabel(data.lastApplied.at) })}</span>}</>}>
          {status?.canRecover && <Button onClick={restore} disabled={!!busy || !status.running}>{t('恢复专属规则', 'Restore managed rules')}</Button>}
        </Setting>
      </section>}
      <section className="settings-section">
        {!dataOnly && <h3>{t('数据与备份', 'Data & backups')}</h3>}
        <Setting name={t('项目备份', 'Project backup')} value={t('备份包含项目、接口和场景。导入项目的接口默认停用。', 'Backups include projects, endpoints, and scenarios. Imported endpoints are disabled by default.')}>
          <Button onClick={importBackup} disabled={!!busy}>{t('导入备份', 'Import backup')}</Button>
          <Button onClick={exportBackup} disabled={!!busy}>{t('导出备份', 'Export backup')}</Button>
        </Setting>
        <Setting name={t('本地存储', 'Local storage')} value={t('草稿自动保存到应用数据目录。', 'Drafts are automatically saved in the app data folder.')}>
          <Button onClick={openDataFolder} disabled={!!busy}><FolderOpen size={14} aria-hidden="true" /> {t('打开数据目录', 'Open data folder')}</Button>
        </Setting>
      </section>
    </div>
    <footer className="dialog__footer">
      {busy && <span className="settings-busy" role="status"><Unplug size={14} aria-hidden="true" />{busyLabel}…</span>}
      <Button onClick={close}>{t('完成', 'Done')}</Button>
    </footer>
  </Dialog>;
}

function Setting({ name, value, children }: { name: string; value: ReactNode; children?: ReactNode }) {
  return <div className="setting">
    <div className="setting__description"><span>{name}</span><div className="setting__value">{value}</div></div>
    <div className="setting__actions">{children}</div>
  </div>;
}
