import { useLanguage } from './i18n';
import { t, getLocale } from '../shared/i18n';
import {
  Activity, ChevronRight, CircleAlert, CloudOff, Database, Folder, FolderOpen, Folders,
  Layers3, LayoutList, Pencil, Plus, Power, Save, Search, Settings2, Trash2, X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import brandMark from '../../assets/brand-mark.png';
import type { Endpoint, HttpMethod, Preset, Project, Scenario } from '../shared/types';
import { EndpointEditor } from './EndpointEditor';
import { deleteEndpoint, deleteScenario, makeScenario, methods, moduleName, readUrl, saveEndpoint, timeLabel } from './model';
import { Settings } from './Settings';
import { Button, Dialog, Field, FormDialog, IconButton, Method, Notice, readField, requiredField, Switch, type FormSpec } from './ui';
import { useWorkspace } from './workspace';

interface View {
  project: string | null;
  module: string | null;
  endpoint: string | null;
  search: string;
}

type Panel = 'settings' | 'backup' | 'presets';
type Overlay = Panel | { spec: FormSpec; returnTo?: Panel } | null;

function initialView(): View {
  const params = new URLSearchParams(window.location.hash.slice(1));
  return { project: params.get('p'), module: params.get('m'), endpoint: params.get('e'), search: params.get('q') ?? '' };
}

export function App() {
  useLanguage();
  const workspace = useWorkspace();
  const { data, status, busy, edit, editProject } = workspace;
  const working = !!busy;
  const [view, setView] = useState(initialView);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const showingSettings = overlay === 'settings' || overlay === 'backup';

  useEffect(() => {
    const params = new URLSearchParams();
    if (view.project) params.set('p', view.project);
    if (view.module !== null) params.set('m', view.module);
    if (view.endpoint) params.set('e', view.endpoint);
    if (view.search) params.set('q', view.search);
    const hash = params.size ? `#${params.toString()}` : '';
    if (window.location.hash !== hash) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
  }, [view]);

  const project = data?.projects.find(item => item.id === view.project) ?? data?.projects[0];
  const moduleCounts = new Map<string, number>();
  for (const endpoint of project?.endpoints ?? []) {
    moduleCounts.set(endpoint.module, (moduleCounts.get(endpoint.module) ?? 0) + 1);
  }
  const modules = [...moduleCounts.keys()].sort((left, right) => moduleName(left).localeCompare(moduleName(right), getLocale()));
  const module = view.module !== null && moduleCounts.has(view.module) ? view.module : null;
  const search = view.search.trim().toLowerCase();
  const moduleEndpoints = project?.endpoints.filter(item => module === null || item.module === module) ?? [];
  const visibleEndpoints = moduleEndpoints.filter(endpoint =>
    !search || [endpoint.name, endpoint.url, endpoint.method, moduleName(endpoint.module)].some(value => value.toLowerCase().includes(search)));
  const endpoint = visibleEndpoints.find(item => item.id === view.endpoint) ?? visibleEndpoints[0];
  const enabledCount = project?.endpoints.filter(item => item.enabled).length ?? 0;

  const showForm = (spec: FormSpec, returnTo?: Panel) => setOverlay({ spec, returnTo });
  const closeOverlay = () => setOverlay(null);

  function projectForm(current?: Project) {
    showForm({
      title: current ? t('编辑项目', 'Edit project') : t('新建项目', 'New project'),
      submit: current ? t('保存项目', 'Save project') : t('创建项目', 'Create project'),
      children: <>
        <Field label={t('项目名称', 'Project name')}><input name="name" defaultValue={current?.name} required maxLength={160} placeholder={t('例如，商品服务', 'For example, Product service')} /></Field>
        <Field label={t('项目描述', 'Project description')}><textarea name="description" defaultValue={current?.description} maxLength={4096} rows={3} placeholder={t('选填', 'Optional')} /></Field>
      </>,
      action: form => {
        const name = requiredField(form, 'name', t('项目名称', 'Project name'));
        const description = readField(form, 'description');
        if (current) {
          editProject(current.id, project => ({ ...project, name, description }));
          return;
        }
        const id = crypto.randomUUID();
        edit(data => ({ ...data, projects: [...data.projects, { id, name, description, endpoints: [], presets: [] }] }));
        setView({ project: id, module: null, endpoint: null, search: '' });
      },
    });
  }

  function removeProject(current: Project) {
    showForm({
      title: t('删除项目', 'Delete project'),
      submit: t('删除项目', 'Delete project'),
      description: t('删除「{name}」及其接口和项目预设。Mock 规则将在下次应用时更新。', 'Delete “{name}”, its endpoints, and project presets. Mock rules will update the next time you apply changes.', { name: current.name }),
      danger: true,
      action: () => {
        edit(data => ({ ...data, projects: data.projects.filter(item => item.id !== current.id) }));
        setView({ project: null, module: null, endpoint: null, search: '' });
      },
    });
  }

  function endpointForm(project: Project, current?: Endpoint) {
    showForm({
      title: current ? t('编辑接口', 'Edit endpoint') : t('新建接口', 'New endpoint'),
      submit: current ? t('保存接口', 'Save endpoint') : t('创建接口', 'Create endpoint'),
      children: <>
        <Field label={t('接口名称', 'Endpoint name')}><input name="name" defaultValue={current?.name} required maxLength={160} placeholder={t('例如，商品列表', 'For example, Product list')} /></Field>
        <div className="request-fields">
          <Field label={t('请求方法', 'Request method')}>
            <select name="method" defaultValue={current?.method ?? 'GET'}>{methods.map(method => <option key={method}>{method}</option>)}</select>
          </Field>
          <Field label={t('模块', 'Module')}>
            <input name="module" defaultValue={current?.module ?? module ?? ''} maxLength={160} list="module-options" placeholder={t('选填', 'Optional')} />
            <datalist id="module-options">{modules.filter(Boolean).map(name => <option key={name} value={name} />)}</datalist>
          </Field>
        </div>
        <Field label={t('请求 URL', 'Request URL')} hint={t('URL 中的查询参数会转换为 Query 条件。', 'Query parameters in the URL become query matching conditions.')}>
          <input name="url" defaultValue={current?.url} required maxLength={4096} placeholder="https://api.example.com/v1/items" spellCheck={false} />
        </Field>
      </>,
      action: form => {
        const name = requiredField(form, 'name', t('接口名称', 'Endpoint name'));
        const { url, query } = readUrl(readField(form, 'url'));
        const nextModule = readField(form, 'module');
        const method = readField(form, 'method') as HttpMethod;
        const id = current?.id ?? crypto.randomUUID();
        let next: Endpoint;
        if (current) {
          const additions = query.filter(row => !current.query.some(item => item.key === row.key && item.value === row.value));
          next = { ...current, name, module: nextModule, url, method, query: [...current.query, ...additions] };
        } else {
          const scenario = makeScenario(t('默认响应', 'Default response'));
          next = { id, name, module: nextModule, url, method, enabled: false, activeScenarioId: scenario.id, query, headers: [], scenarios: [scenario] };
        }
        if (next.query.length > 24) throw new Error(t('每个接口最多可保存 24 个 Query 条件。', 'An endpoint can have up to 24 query conditions.'));
        editProject(project.id, item => saveEndpoint(item, next));
        setView({ project: project.id, module: module === null ? null : nextModule, endpoint: id, search: '' });
      },
    });
  }

  function updateEndpoint(project: Project, endpoint: Endpoint, update: (item: Endpoint) => Endpoint) {
    editProject(project.id, current => {
      const latest = current.endpoints.find(item => item.id === endpoint.id);
      return latest ? saveEndpoint(current, update(latest)) : current;
    });
  }

  function removeEndpoint(project: Project, endpoint: Endpoint) {
    showForm({
      title: t('删除接口', 'Delete endpoint'),
      submit: t('删除接口', 'Delete endpoint'),
      description: t('删除「{name}」、响应场景及其在项目预设中的记录。', 'Delete “{name}”, its response scenarios, and its entries in project presets.', { name: endpoint.name }),
      danger: true,
      action: () => {
        editProject(project.id, item => deleteEndpoint(item, endpoint.id));
        setView(current => ({ ...current, endpoint: null }));
      },
    });
  }

  function scenarioForm(project: Project, endpoint: Endpoint, current?: Scenario) {
    showForm({
      title: current ? t('重命名场景', 'Rename scenario') : t('新增场景', 'Add scenario'),
      submit: current ? t('保存场景', 'Save scenario') : t('创建场景', 'Create scenario'),
      children: <Field label={t('场景名称', 'Scenario name')}>
        <input name="name" defaultValue={current?.name} required maxLength={160} placeholder={t('例如，空列表', 'For example, Empty list')} />
      </Field>,
      action: form => {
        const name = requiredField(form, 'name', t('场景名称', 'Scenario name'));
        updateEndpoint(project, endpoint, latest => {
          if (current) {
            return { ...latest, scenarios: latest.scenarios.map(item => item.id === current.id ? { ...item, name } : item) };
          }
          const scenario = makeScenario(name);
          return { ...latest, scenarios: [...latest.scenarios, scenario], activeScenarioId: scenario.id };
        });
      },
    });
  }

  function removeScenario(project: Project, endpoint: Endpoint, scenario: Scenario) {
    showForm({
      title: t('删除场景', 'Delete scenario'),
      submit: t('删除场景', 'Delete scenario'),
      description: t('删除「{name}」。引用这个场景的项目预设将改用接口的第一个场景。', 'Delete “{name}”. Project presets that use it will switch to this endpoint’s first scenario.', { name: scenario.name }),
      danger: true,
      action: () => editProject(project.id, current => deleteScenario(current, endpoint, scenario)),
    });
  }

  function presetForm(project: Project, current?: Preset) {
    showForm({
      title: current ? t('重命名预设', 'Rename preset') : t('保存为预设', 'Save as preset'),
      submit: current ? t('保存名称', 'Save name') : t('保存预设', 'Save preset'),
      description: current ? undefined : t('记录当前项目各接口的启用状态和选中的响应场景。', 'Save each endpoint’s enabled state and selected response scenario for this project.'),
      children: <Field label={t('预设名称', 'Preset name')}>
        <input name="name" defaultValue={current?.name} required maxLength={160} placeholder={t('例如，商品接口联调', 'For example, Product integration')} />
      </Field>,
      action: form => {
        const name = requiredField(form, 'name', t('预设名称', 'Preset name'));
        editProject(project.id, latest => {
          const presets = current
            ? latest.presets.map(item => item.id === current.id ? { ...item, name } : item)
            : [...latest.presets, { id: crypto.randomUUID(), name, selections: capturePreset(latest) }];
          return { ...latest, presets };
        });
      },
    }, 'presets');
  }

  function removePreset(project: Project, preset: Preset) {
    showForm({
      title: t('删除预设', 'Delete preset'),
      submit: t('删除预设', 'Delete preset'),
      description: t('删除保存的项目预设「{name}」。', 'Delete the saved project preset “{name}”.', { name: preset.name }),
      danger: true,
      action: () => editProject(project.id, latest => ({ ...latest, presets: latest.presets.filter(item => item.id !== preset.id) })),
    }, 'presets');
  }

  function replacePreset(project: Project, preset: Preset) {
    showForm({
      title: t('更新预设', 'Update preset'),
      submit: t('更新预设', 'Update preset'),
      description: t('使用当前接口的启用状态和选中的场景更新「{name}」。', 'Update “{name}” with the current endpoint states and selected scenarios.', { name: preset.name }),
      action: () => editProject(project.id, latest => ({
        ...latest,
        presets: latest.presets.map(item => item.id === preset.id ? { ...item, selections: capturePreset(latest) } : item),
      })),
    }, 'presets');
  }

  function loadPreset(project: Project, preset: Preset) {
    editProject(project.id, latest => ({
      ...latest,
      endpoints: latest.endpoints.map(item => {
        const saved = preset.selections[item.id];
        return saved && item.scenarios.some(scenario => scenario.id === saved.scenarioId)
          ? { ...item, enabled: saved.enabled, activeScenarioId: saved.scenarioId }
          : item;
      }),
    }));
    closeOverlay();
  }

  function restore() {
    showForm({
      title: t('恢复专属规则', 'Restore managed rules'),
      submit: t('恢复', 'Restore'),
      description: t('恢复本地引擎中的专属规则和上次应用的响应。当前草稿会保留，未应用的更改仍需手动应用。', 'Restore this app’s rules and the last applied responses in the local engine. Your current draft is kept; pending changes still need to be applied.'),
      danger: true,
      action: workspace.restore,
    }, 'settings');
  }

  const localChanges = !!data?.lastApplied && JSON.stringify(data.projects) !== JSON.stringify(data.lastApplied.projects);
  const sync = connectionCopy(status, !!data?.lastApplied, localChanges, !!workspace.statusError);
  const saveText = { clean: t('草稿已保存', 'Draft saved'), pending: t('待保存', 'Unsaved'), saving: t('保存中…', 'Saving…'), error: t('保存失败', 'Save failed') }[workspace.saveState];
  const engineConnected = status?.running && !workspace.statusError;
  const proxyConnected = engineConnected && workspace.systemProxy?.state === 'on'
    && workspace.systemProxy.address === status.address && !workspace.systemProxyError;
  const proxy = workspace.systemProxy;
  // Ownership stays checked until restoration succeeds, including an interrupted
  // operation. Its warning affordance distinguishes that from a healthy proxy.
  const proxyNeedsAttention = !!workspace.systemProxyError || proxy?.state === 'error'
    || (!!proxy?.managed && !proxyConnected);
  const proxyDisabled = working || !proxy?.supported
    || (!proxy.managed && (!engineConnected || proxy.state === 'error' || !!workspace.systemProxyError));
  const proxyHint = !proxy ? t('正在读取系统代理状态', 'Reading system proxy status')
    : !proxy.supported ? t('系统代理开关仅支持 macOS', 'System proxy control is available on macOS only')
    : proxyNeedsAttention ? t('系统代理需要处理；关闭开关可尝试恢复原配置，或打开设置查看详情', 'System proxy needs attention. Turn it off to try restoring the original settings, or open Settings for details.')
    : proxy.managed ? t('本应用已接管系统代理；关闭后恢复原配置', 'This app manages the system proxy. Turn it off to restore the original settings.')
    : t('开启后保存原配置，并将系统 HTTP/HTTPS 代理指向本地引擎', 'Save the original settings and route the system HTTP/HTTPS proxy through the local engine.');

  return <div className="app">
    <header className="topbar">
      <div className="brand">
        <div className="brand__icon"><img className="brand__mark" src={brandMark} alt="" /></div>
        <span className="brand__name">Mock Manager</span>
      </div>
      <div className="topbar__commands">
        {data && <span className={`save-state${workspace.saveError ? ' save-state--error' : ''}`} role="status">
          <Save size={15} aria-hidden="true" /> {saveText}
        </span>}
        <Button kind="quiet" className={`connection connection--${sync.tone}`} onClick={() => setOverlay('settings')} title={t('查看 Mock 规则应用状态', 'View mock rule status')}>
          <span className="connection__dot" aria-hidden="true" />
          {sync.label}
        </Button>
        <span className="topbar__rule" aria-hidden="true" />
        <div className={`topbar__proxy${proxyNeedsAttention ? ' topbar__proxy--attention' : ''}`} title={proxyHint}>
          <Switch label={t('系统代理', 'System proxy')} checked={!!proxy?.managed} disabled={proxyDisabled} change={workspace.setSystemProxy} />
          {proxyNeedsAttention && <Button kind="quiet" className="proxy-attention" onClick={() => setOverlay('settings')}>
            <CircleAlert size={14} aria-hidden="true" /> {t('待处理', 'Needs attention')}
          </Button>}
        </div>
        <span className="topbar__rule" aria-hidden="true" />
        <IconButton label={t('连接设置', 'Connection settings')} onClick={() => setOverlay('settings')}><Settings2 size={18} aria-hidden="true" /></IconButton>
        <Button kind="primary" disabled={!data || working} onClick={workspace.apply}>
          {busy === '正在应用' ? t('正在应用…', 'Applying…') : t('应用更改', 'Apply changes')}
        </Button>
      </div>
    </header>

    {workspace.saveError && <Notice error>
      <span>{t('草稿保存失败。', 'Could not save draft. ')}{workspace.saveError}</span>
      <Button onClick={() => void workspace.flush().catch(() => {})} disabled={working || workspace.saveState === 'saving'}>{t('重试保存', 'Retry save')}</Button>
    </Notice>}
    {!showingSettings && workspace.commandError && <Notice error close={workspace.clearCommandError}>{workspace.commandError}</Notice>}
    {!showingSettings && workspace.notice && <Notice close={workspace.clearNotice}>{workspace.notice}</Notice>}
    <main className="workbench">
      <nav className="sidebar" aria-label={t('项目与模块', 'Projects and modules')}>
        <div className="sidebar__heading">
          <h2>{t('项目', 'Projects')}</h2>
          <IconButton label={t('新建项目', 'New project')} disabled={!data || working} onClick={() => projectForm()}><Plus size={18} aria-hidden="true" /></IconButton>
        </div>
        <div className="sidebar__scroll">
          {data?.projects.map(item => <button type="button" className="nav-row" key={item.id}
            aria-current={project?.id === item.id ? 'true' : undefined} title={item.name}
            onClick={() => setView({ project: item.id, module: null, endpoint: null, search: '' })}>
            {project?.id === item.id ? <FolderOpen size={16} aria-hidden="true" /> : <Folder size={16} aria-hidden="true" />}
            <span>{item.name}</span>
            {project?.id === item.id && <ChevronRight size={14} aria-hidden="true" />}
          </button>)}
          {!data && !workspace.loadError && <div className="skeleton skeleton--nav" aria-hidden="true" />}
          {data && data.projects.length === 0 && <p className="sidebar__empty">{t('还没有项目', 'No projects yet')}</p>}
          {project && <>
            <div className="sidebar__heading sidebar__heading--modules"><h2>{t('模块', 'Modules')}</h2></div>
            <button type="button" className="nav-row nav-row--module" aria-current={module === null ? 'true' : undefined}
              onClick={() => setView(current => ({ ...current, module: null, endpoint: null }))}>
              <LayoutList size={15} aria-hidden="true" /><span>{t('全部接口', 'All endpoints')}</span><small>{project.endpoints.length}</small>
            </button>
            {modules.map(name => <button type="button" className="nav-row nav-row--module" key={name}
              aria-current={module === name ? 'true' : undefined} title={moduleName(name)}
              onClick={() => setView(current => ({ ...current, module: name, endpoint: null }))}>
              <Layers3 size={15} aria-hidden="true" /><span>{moduleName(name)}</span><small>{moduleCounts.get(name)}</small>
            </button>)}
          </>}
        </div>
        <div className="sidebar__footer">
          <Button kind="quiet" onClick={() => setOverlay('backup')}><Database size={16} aria-hidden="true" /> {t('数据与备份', 'Data & backups')}</Button>
          <Button kind="quiet" className="sidebar__setup" onClick={() => setOverlay('settings')}>
            <Settings2 size={16} aria-hidden="true" /> {t('设置', 'Settings')}
          </Button>
        </div>
      </nav>

      <section className="requests" aria-label={t('接口列表', 'Endpoint list')}>
        <header className="requests__header">
          <div className="request-heading">
            <h2>{t('接口', 'Endpoints')}</h2>
            {project && <div className="request-heading__tools">
              <IconButton label={t('项目预设', 'Project presets')} disabled={working} onClick={() => setOverlay('presets')}><Layers3 size={15} aria-hidden="true" /></IconButton>
              <IconButton label={t('编辑项目', 'Edit project')} disabled={working} onClick={() => projectForm(project)}><Pencil size={14} aria-hidden="true" /></IconButton>
              <IconButton label={t('删除项目', 'Delete project')} disabled={working} onClick={() => removeProject(project)}><Trash2 size={14} aria-hidden="true" /></IconButton>
              <IconButton label={t('新建接口', 'New endpoint')} disabled={working} onClick={() => endpointForm(project)}><Plus size={19} aria-hidden="true" /></IconButton>
            </div>}
          </div>
          {project?.description && <p className="project-description" title={project.description}>{project.description}</p>}
          <div className="search">
            <Search size={16} aria-hidden="true" />
            <input type="search" aria-label={t('搜索接口', 'Search endpoints')} placeholder={t('搜索接口', 'Search endpoints')} value={view.search}
              disabled={!project} onChange={event => setView(current => ({ ...current, search: event.target.value }))} />
            {view.search && <IconButton label={t('清空搜索', 'Clear search')} onClick={() => setView(current => ({ ...current, search: '' }))}>
              <X size={14} aria-hidden="true" />
            </IconButton>}
          </div>
        </header>

        {project && <div className="requests__summary">
          <span>{module === null ? t('全部接口', 'All endpoints') : moduleName(module)}</span>
          <span>{t('{count} 个接口', visibleEndpoints.length === 1 ? '{count} endpoint' : '{count} endpoints', { count: visibleEndpoints.length })}</span>
        </div>}
        <div className="requests__scroll">
          {visibleEndpoints.length > 0 && <ul className="endpoint-list">
            {visibleEndpoints.map(item => (
              <li key={item.id} className="endpoint-item" data-selected={endpoint?.id === item.id || undefined}
                data-enabled={item.enabled}>
                <button type="button" className="endpoint-row"
                  aria-current={endpoint?.id === item.id ? 'true' : undefined}
                  onClick={() => setView(current => ({ ...current, endpoint: item.id }))}>
                  <Method method={item.method} />
                  <span className="endpoint-row__content">
                    <strong title={item.name}>{item.name}</strong>
                    <code className="endpoint-row__url" title={item.url}>{requestPath(item.url)}</code>
                  </span>
                </button>
                <div className="endpoint-item__switch" title={t('接口草稿的启用状态，应用后生效', 'Endpoint’s draft enabled state. Takes effect after Apply.')}>
                  <Switch label={t('启用接口 {name}', 'Enable endpoint {name}', { name: item.name })} checked={item.enabled} disabled={working}
                    change={enabled => project && updateEndpoint(project, item, current => ({ ...current, enabled }))} />
                </div>
              </li>
            ))}
          </ul>}
          {project && !visibleEndpoints.length && <div className="list-empty">
            {search ? <Search size={21} aria-hidden="true" /> : <LayoutList size={21} aria-hidden="true" />}
            <strong>{search ? t('没有匹配的接口', 'No matching endpoints') : t('还没有接口', 'No endpoints yet')}</strong>
            <span>{search ? t('试试接口名称、路径或请求方法。', 'Try an endpoint name, path, or HTTP method.') : t('新建接口以配置请求和响应。', 'Create an endpoint to configure its request and responses.')}</span>
          </div>}
          {!project && data && <div className="list-empty">
            <Folders size={21} aria-hidden="true" />
            <strong>{t('先创建一个项目', 'Create a project first')}</strong>
            <span>{t('按服务或应用组织接口。', 'Organize endpoints by service or application.')}</span>
          </div>}
          {!data && !workspace.loadError && <div className="skeleton-stack" aria-hidden="true">
            <div className="skeleton" /><div className="skeleton" /><div className="skeleton" />
          </div>}
        </div>
      </section>

      {endpoint && project
        ? <EndpointEditor key={endpoint.id} project={project} endpoint={endpoint} busy={working}
            update={update => updateEndpoint(project, endpoint, update)}
            editEndpoint={() => endpointForm(project, endpoint)} removeEndpoint={() => removeEndpoint(project, endpoint)}
            addScenario={() => scenarioForm(project, endpoint)}
            editScenario={item => scenarioForm(project, endpoint, item)}
            removeScenario={item => removeScenario(project, endpoint, item)}
            prompt={showForm} importJson={workspace.importResponse} />
        : <div className="blank-detail">
            {workspace.loadError ? <div className="blank-detail__content" role="alert">
              <CircleAlert size={26} aria-hidden="true" />
              <h1>{t('无法打开工作台', 'Could not open workspace')}</h1><p>{workspace.loadError}</p>
              <Button onClick={() => void workspace.load()}>{t('重新加载', 'Reload')}</Button>
            </div> : !data ? <div className="blank-detail__content" role="status">
              <Activity size={26} aria-hidden="true" /><h1>{t('正在读取工作台…', 'Loading workspace…')}</h1>
            </div> : <div className="blank-detail__content">
              <span className="blank-detail__glyph"><img src={brandMark} alt="" /></span>
              <h1>{search ? t('没有可编辑的接口', 'No endpoint to edit') : t('接口编辑器', 'Endpoint editor')}</h1>
              <p>{search ? t('清空搜索或更换关键词后选择接口。', 'Clear the search or try another keyword, then select an endpoint.') : project ? t('新建一个接口以编辑请求匹配和响应场景。', 'Create an endpoint to edit request matching and response scenarios.') : t('创建项目与接口后，在这里编辑响应。', 'Create a project and an endpoint, then edit responses here.')}</p>
              {search && <Button onClick={() => setView(current => ({ ...current, search: '' }))}>{t('清空筛选', 'Clear filters')}</Button>}
            </div>}
          </div>}
    </main>

    <footer className="statusbar" aria-label={t('工作台状态', 'Workspace status')}>
      <div className="statusbar__area">
        {engineConnected
          ? <><span className="engine-dot" aria-hidden="true" /><span>{t('本地引擎运行中', 'Local engine running')}</span>{status.address && <code className="statusbar__address">{status.address}</code>}</>
          : <><CloudOff size={14} aria-hidden="true" /><span>{workspace.statusError ? t('连接检测失败', 'Connection check failed') : status ? t('本地引擎未运行', 'Local engine stopped') : t('正在检测本地引擎', 'Checking local engine')}</span></>}
        {project && <span className="statusbar__split">{enabledCount} / {project.endpoints.length} {t('接口启用', project.endpoints.length === 1 ? 'endpoint enabled' : 'endpoints enabled')}</span>}
      </div>
      <div className="statusbar__area">
        {workspace.systemProxy?.managed && <Button kind="quiet" onClick={() => setOverlay('settings')} disabled={working}>
          {proxyConnected ? t('系统代理已接管', 'System proxy managed') : t('系统代理待处理', 'Proxy needs attention')}
        </Button>}
        {data?.lastApplied && <span>{t('上次应用', 'Last applied')} {timeLabel(data.lastApplied.at)}</span>}
        {status?.managedSelected && <Button kind="quiet" onClick={workspace.disable} disabled={working} title={t('只停用本应用的专属规则', 'Disable only the rules managed by this app')}>
          <Power size={14} aria-hidden="true" /> {busy === '正在停用' ? t('正在停用…', 'Disabling…') : t('停用 Mock', 'Disable mocks')}
        </Button>}
      </div>
    </footer>

    {showingSettings && <Settings workspace={workspace} close={closeOverlay} restore={restore} dataOnly={overlay === 'backup'} />}
    {overlay === 'presets' && project && <Dialog title={t('项目预设', 'Project presets')} close={closeOverlay} className="presets-dialog">
      <div className="dialog__body">
        {project.presets.length ? <ul className="preset-list">
          {project.presets.map(preset => <li key={preset.id} className="preset-row">
            <div className="preset-row__title"><Layers3 size={17} aria-hidden="true" /><span>{preset.name}</span></div>
            <Button disabled={working} onClick={() => loadPreset(project, preset)} aria-label={t('加载预设 {name}', 'Load preset {name}', { name: preset.name })}>{t('加载', 'Load')}</Button>
            <Button kind="quiet" disabled={working} onClick={() => replacePreset(project, preset)} aria-label={t('更新预设 {name}', 'Update preset {name}', { name: preset.name })}>{t('更新', 'Update')}</Button>
            <IconButton label={t('重命名预设 {name}', 'Rename preset {name}', { name: preset.name })} disabled={working} onClick={() => presetForm(project, preset)}><Pencil size={14} aria-hidden="true" /></IconButton>
            <IconButton label={t('删除预设 {name}', 'Delete preset {name}', { name: preset.name })} disabled={working} onClick={() => removePreset(project, preset)}><Trash2 size={14} aria-hidden="true" /></IconButton>
          </li>)}
        </ul> : <p className="muted">{t('还没有预设。保存当前接口的启用状态和响应场景，以便之后切换。', 'No presets yet. Save the current endpoint states and response scenarios to switch back to them later.')}</p>}
      </div>
      <footer className="dialog__footer">
        <Button onClick={closeOverlay}>{t('关闭', 'Close')}</Button>
        <Button kind="primary" disabled={working} onClick={() => presetForm(project)}>{t('保存为预设', 'Save as preset')}</Button>
      </footer>
    </Dialog>}
    {overlay && typeof overlay === 'object' && <FormDialog key={overlay.spec.title} spec={overlay.spec} close={() => setOverlay(overlay.returnTo ?? null)} />}
  </div>;
}

function capturePreset(project: Project): Preset['selections'] {
  return Object.fromEntries(project.endpoints.map(item => [item.id, { enabled: item.enabled, scenarioId: item.activeScenarioId }]));
}

function requestPath(url: string) {
  if (!url) return t('未填写请求 URL', 'Request URL not set');
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}

function connectionCopy(
  status: ReturnType<typeof useWorkspace>['status'], everApplied: boolean, localChanges: boolean, failed: boolean,
) {
  if (failed) return { label: t('检测失败', 'Check failed'), tone: 'error' };
  if (!status) return { label: t('连接检测中', 'Checking connection'), tone: 'idle' };
  switch (status.syncState) {
    case 'offline': return { label: t('引擎未运行', 'Engine stopped'), tone: 'idle' };
    case 'conflict': return { label: t('规则冲突', 'Rule conflict'), tone: 'error' };
    case 'disabled':
      return { label: status.rulesDisabled ? t('全局规则关闭', 'Global rules off') : everApplied ? t('Mock 已停用', 'Mocks disabled') : t('尚未应用', 'Not applied'), tone: 'idle' };
    case 'pending': return { label: t('待应用', 'Pending changes'), tone: 'pending' };
    case 'synced': return localChanges ? { label: t('待应用', 'Pending changes'), tone: 'pending' } : { label: t('已同步', 'Applied'), tone: 'good' };
  }
}
