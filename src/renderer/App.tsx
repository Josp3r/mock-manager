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
  const modules = [...moduleCounts.keys()].sort((left, right) => moduleName(left).localeCompare(moduleName(right), 'zh-CN'));
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
      title: current ? '编辑项目' : '新建项目',
      submit: current ? '保存项目' : '创建项目',
      children: <>
        <Field label="项目名称"><input name="name" defaultValue={current?.name} required maxLength={160} placeholder="例如，商品服务" /></Field>
        <Field label="项目描述"><textarea name="description" defaultValue={current?.description} maxLength={4096} rows={3} placeholder="选填" /></Field>
      </>,
      action: form => {
        const name = requiredField(form, 'name', '项目名称');
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
      title: '删除项目',
      submit: '删除项目',
      description: `删除「${current.name}」及其接口和项目预设。Mock 规则将在下次应用时更新。`,
      danger: true,
      action: () => {
        edit(data => ({ ...data, projects: data.projects.filter(item => item.id !== current.id) }));
        setView({ project: null, module: null, endpoint: null, search: '' });
      },
    });
  }

  function endpointForm(project: Project, current?: Endpoint) {
    showForm({
      title: current ? '编辑接口' : '新建接口',
      submit: current ? '保存接口' : '创建接口',
      children: <>
        <Field label="接口名称"><input name="name" defaultValue={current?.name} required maxLength={160} placeholder="例如，商品列表" /></Field>
        <div className="request-fields">
          <Field label="请求方法">
            <select name="method" defaultValue={current?.method ?? 'GET'}>{methods.map(method => <option key={method}>{method}</option>)}</select>
          </Field>
          <Field label="模块">
            <input name="module" defaultValue={current?.module ?? module ?? ''} maxLength={160} list="module-options" placeholder="选填" />
            <datalist id="module-options">{modules.filter(Boolean).map(name => <option key={name} value={name} />)}</datalist>
          </Field>
        </div>
        <Field label="请求 URL" hint="URL 中的查询参数会转换为 Query 条件。">
          <input name="url" defaultValue={current?.url} required maxLength={4096} placeholder="https://api.example.com/v1/items" spellCheck={false} />
        </Field>
      </>,
      action: form => {
        const name = requiredField(form, 'name', '接口名称');
        const { url, query } = readUrl(readField(form, 'url'));
        const nextModule = readField(form, 'module');
        const method = readField(form, 'method') as HttpMethod;
        const id = current?.id ?? crypto.randomUUID();
        let next: Endpoint;
        if (current) {
          const additions = query.filter(row => !current.query.some(item => item.key === row.key && item.value === row.value));
          next = { ...current, name, module: nextModule, url, method, query: [...current.query, ...additions] };
        } else {
          const scenario = makeScenario('默认响应');
          next = { id, name, module: nextModule, url, method, enabled: false, activeScenarioId: scenario.id, query, headers: [], scenarios: [scenario] };
        }
        if (next.query.length > 24) throw new Error('每个接口最多可保存 24 个 Query 条件。');
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
      title: '删除接口',
      submit: '删除接口',
      description: `删除「${endpoint.name}」、响应场景及其在项目预设中的记录。`,
      danger: true,
      action: () => {
        editProject(project.id, item => deleteEndpoint(item, endpoint.id));
        setView(current => ({ ...current, endpoint: null }));
      },
    });
  }

  function scenarioForm(project: Project, endpoint: Endpoint, current?: Scenario) {
    showForm({
      title: current ? '重命名场景' : '新增场景',
      submit: current ? '保存场景' : '创建场景',
      children: <Field label="场景名称">
        <input name="name" defaultValue={current?.name} required maxLength={160} placeholder="例如，空列表" />
      </Field>,
      action: form => {
        const name = requiredField(form, 'name', '场景名称');
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
      title: '删除场景',
      submit: '删除场景',
      description: `删除「${scenario.name}」。引用这个场景的项目预设将改用接口的第一个场景。`,
      danger: true,
      action: () => editProject(project.id, current => deleteScenario(current, endpoint, scenario)),
    });
  }

  function presetForm(project: Project, current?: Preset) {
    showForm({
      title: current ? '重命名预设' : '保存为预设',
      submit: current ? '保存名称' : '保存预设',
      description: current ? undefined : '记录当前项目各接口的启用状态和选中的响应场景。',
      children: <Field label="预设名称">
        <input name="name" defaultValue={current?.name} required maxLength={160} placeholder="例如，商品接口联调" />
      </Field>,
      action: form => {
        const name = requiredField(form, 'name', '预设名称');
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
      title: '删除预设',
      submit: '删除预设',
      description: `删除保存的项目预设「${preset.name}」。`,
      danger: true,
      action: () => editProject(project.id, latest => ({ ...latest, presets: latest.presets.filter(item => item.id !== preset.id) })),
    }, 'presets');
  }

  function replacePreset(project: Project, preset: Preset) {
    showForm({
      title: '更新预设',
      submit: '更新预设',
      description: `使用当前接口的启用状态和选中的场景更新「${preset.name}」。`,
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
      title: '恢复专属规则',
      submit: '恢复',
      description: '恢复本地引擎中的专属规则和上次应用的响应。当前草稿会保留，未应用的更改仍需手动应用。',
      danger: true,
      action: workspace.restore,
    }, 'settings');
  }

  const localChanges = !!data?.lastApplied && JSON.stringify(data.projects) !== JSON.stringify(data.lastApplied.projects);
  const sync = connectionCopy(status, !!data?.lastApplied, localChanges, !!workspace.statusError);
  const saveText = { clean: '草稿已保存', pending: '待保存', saving: '保存中…', error: '保存失败' }[workspace.saveState];
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
  const proxyHint = !proxy ? '正在读取系统代理状态'
    : !proxy.supported ? '系统代理开关仅支持 macOS'
    : proxyNeedsAttention ? '系统代理需要处理；关闭开关可尝试恢复原配置，或打开设置查看详情'
    : proxy.managed ? '本应用已接管系统代理；关闭后恢复原配置'
    : '开启后保存原配置，并将系统 HTTP/HTTPS 代理指向本地引擎';

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
        <Button kind="quiet" className={`connection connection--${sync.tone}`} onClick={() => setOverlay('settings')} title="查看 Mock 规则应用状态">
          <span className="connection__dot" aria-hidden="true" />
          {sync.label}
        </Button>
        <span className="topbar__rule" aria-hidden="true" />
        <div className={`topbar__proxy${proxyNeedsAttention ? ' topbar__proxy--attention' : ''}`} title={proxyHint}>
          <Switch label="系统代理" checked={!!proxy?.managed} disabled={proxyDisabled} change={workspace.setSystemProxy} />
          {proxyNeedsAttention && <Button kind="quiet" className="proxy-attention" onClick={() => setOverlay('settings')}>
            <CircleAlert size={14} aria-hidden="true" /> 待处理
          </Button>}
        </div>
        <span className="topbar__rule" aria-hidden="true" />
        <IconButton label="连接设置" onClick={() => setOverlay('settings')}><Settings2 size={18} aria-hidden="true" /></IconButton>
        <Button kind="primary" disabled={!data || working} onClick={workspace.apply}>
          {busy === '正在应用' ? '正在应用…' : '应用更改'}
        </Button>
      </div>
    </header>

    {workspace.saveError && <Notice error>
      <span>草稿保存失败。{workspace.saveError}</span>
      <Button onClick={() => void workspace.flush().catch(() => {})} disabled={working || workspace.saveState === 'saving'}>重试保存</Button>
    </Notice>}
    {!showingSettings && workspace.commandError && <Notice error close={workspace.clearCommandError}>{workspace.commandError}</Notice>}
    {!showingSettings && workspace.notice && <Notice close={workspace.clearNotice}>{workspace.notice}</Notice>}
    <main className="workbench">
      <nav className="sidebar" aria-label="项目与模块">
        <div className="sidebar__heading">
          <h2>项目</h2>
          <IconButton label="新建项目" disabled={!data || working} onClick={() => projectForm()}><Plus size={18} aria-hidden="true" /></IconButton>
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
          {data && data.projects.length === 0 && <p className="sidebar__empty">还没有项目</p>}
          {project && <>
            <div className="sidebar__heading sidebar__heading--modules"><h2>模块</h2></div>
            <button type="button" className="nav-row nav-row--module" aria-current={module === null ? 'true' : undefined}
              onClick={() => setView(current => ({ ...current, module: null, endpoint: null }))}>
              <LayoutList size={15} aria-hidden="true" /><span>全部接口</span><small>{project.endpoints.length}</small>
            </button>
            {modules.map(name => <button type="button" className="nav-row nav-row--module" key={name}
              aria-current={module === name ? 'true' : undefined} title={moduleName(name)}
              onClick={() => setView(current => ({ ...current, module: name, endpoint: null }))}>
              <Layers3 size={15} aria-hidden="true" /><span>{moduleName(name)}</span><small>{moduleCounts.get(name)}</small>
            </button>)}
          </>}
        </div>
        <div className="sidebar__footer">
          <Button kind="quiet" onClick={() => setOverlay('backup')}><Database size={16} aria-hidden="true" /> 数据与备份</Button>
          <Button kind="quiet" className="sidebar__setup" onClick={() => setOverlay('settings')}>
            <Settings2 size={16} aria-hidden="true" /> 设置
          </Button>
        </div>
      </nav>

      <section className="requests" aria-label="接口列表">
        <header className="requests__header">
          <div className="request-heading">
            <h2>接口</h2>
            {project && <div className="request-heading__tools">
              <IconButton label="项目预设" disabled={working} onClick={() => setOverlay('presets')}><Layers3 size={15} aria-hidden="true" /></IconButton>
              <IconButton label="编辑项目" disabled={working} onClick={() => projectForm(project)}><Pencil size={14} aria-hidden="true" /></IconButton>
              <IconButton label="删除项目" disabled={working} onClick={() => removeProject(project)}><Trash2 size={14} aria-hidden="true" /></IconButton>
              <IconButton label="新建接口" disabled={working} onClick={() => endpointForm(project)}><Plus size={19} aria-hidden="true" /></IconButton>
            </div>}
          </div>
          {project?.description && <p className="project-description" title={project.description}>{project.description}</p>}
          <div className="search">
            <Search size={16} aria-hidden="true" />
            <input type="search" aria-label="搜索接口" placeholder="搜索接口" value={view.search}
              disabled={!project} onChange={event => setView(current => ({ ...current, search: event.target.value }))} />
            {view.search && <IconButton label="清空搜索" onClick={() => setView(current => ({ ...current, search: '' }))}>
              <X size={14} aria-hidden="true" />
            </IconButton>}
          </div>
        </header>

        {project && <div className="requests__summary">
          <span>{module === null ? '全部接口' : moduleName(module)}</span><span>{visibleEndpoints.length} 个接口</span>
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
                <div className="endpoint-item__switch" title="接口草稿的启用状态，应用后生效">
                  <Switch label={`启用接口 ${item.name}`} checked={item.enabled} disabled={working}
                    change={enabled => project && updateEndpoint(project, item, current => ({ ...current, enabled }))} />
                </div>
              </li>
            ))}
          </ul>}
          {project && !visibleEndpoints.length && <div className="list-empty">
            {search ? <Search size={21} aria-hidden="true" /> : <LayoutList size={21} aria-hidden="true" />}
            <strong>{search ? '没有匹配的接口' : '还没有接口'}</strong>
            <span>{search ? '试试接口名称、路径或请求方法。' : '新建接口以配置请求和响应。'}</span>
          </div>}
          {!project && data && <div className="list-empty">
            <Folders size={21} aria-hidden="true" />
            <strong>先创建一个项目</strong>
            <span>按服务或应用组织接口。</span>
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
              <h1>无法打开工作台</h1><p>{workspace.loadError}</p>
              <Button onClick={() => void workspace.load()}>重新加载</Button>
            </div> : !data ? <div className="blank-detail__content" role="status">
              <Activity size={26} aria-hidden="true" /><h1>正在读取工作台…</h1>
            </div> : <div className="blank-detail__content">
              <span className="blank-detail__glyph"><img src={brandMark} alt="" /></span>
              <h1>{search ? '没有可编辑的接口' : '接口编辑器'}</h1>
              <p>{search ? '清空搜索或更换关键词后选择接口。' : project ? '新建一个接口以编辑请求匹配和响应场景。' : '创建项目与接口后，在这里编辑响应。'}</p>
              {search && <Button onClick={() => setView(current => ({ ...current, search: '' }))}>清空筛选</Button>}
            </div>}
          </div>}
    </main>

    <footer className="statusbar" aria-label="工作台状态">
      <div className="statusbar__area">
        {engineConnected
          ? <><span className="engine-dot" aria-hidden="true" /><span>本地引擎运行中</span>{status.address && <code className="statusbar__address">{status.address}</code>}</>
          : <><CloudOff size={14} aria-hidden="true" /><span>{workspace.statusError ? '连接检测失败' : status ? '本地引擎未运行' : '正在检测本地引擎'}</span></>}
        {project && <span className="statusbar__split">{enabledCount} / {project.endpoints.length} 接口启用</span>}
      </div>
      <div className="statusbar__area">
        {workspace.systemProxy?.managed && <Button kind="quiet" onClick={() => setOverlay('settings')} disabled={working}>
          {proxyConnected ? '系统代理已接管' : '系统代理待处理'}
        </Button>}
        {data?.lastApplied && <span>上次应用 {timeLabel(data.lastApplied.at)}</span>}
        {status?.managedSelected && <Button kind="quiet" onClick={workspace.disable} disabled={working} title="只停用本应用的专属规则">
          <Power size={14} aria-hidden="true" /> {busy === '正在停用' ? '正在停用…' : '停用 Mock'}
        </Button>}
      </div>
    </footer>

    {showingSettings && <Settings workspace={workspace} close={closeOverlay} restore={restore} dataOnly={overlay === 'backup'} />}
    {overlay === 'presets' && project && <Dialog title="项目预设" close={closeOverlay} className="presets-dialog">
      <div className="dialog__body">
        {project.presets.length ? <ul className="preset-list">
          {project.presets.map(preset => <li key={preset.id} className="preset-row">
            <div className="preset-row__title"><Layers3 size={17} aria-hidden="true" /><span>{preset.name}</span></div>
            <Button disabled={working} onClick={() => loadPreset(project, preset)} aria-label={`加载预设 ${preset.name}`}>加载</Button>
            <Button kind="quiet" disabled={working} onClick={() => replacePreset(project, preset)} aria-label={`更新预设 ${preset.name}`}>更新</Button>
            <IconButton label={`重命名预设 ${preset.name}`} disabled={working} onClick={() => presetForm(project, preset)}><Pencil size={14} aria-hidden="true" /></IconButton>
            <IconButton label={`删除预设 ${preset.name}`} disabled={working} onClick={() => removePreset(project, preset)}><Trash2 size={14} aria-hidden="true" /></IconButton>
          </li>)}
        </ul> : <p className="muted">还没有预设。保存当前接口的启用状态和响应场景，以便之后切换。</p>}
      </div>
      <footer className="dialog__footer">
        <Button onClick={closeOverlay}>关闭</Button>
        <Button kind="primary" disabled={working} onClick={() => presetForm(project)}>保存为预设</Button>
      </footer>
    </Dialog>}
    {overlay && typeof overlay === 'object' && <FormDialog key={overlay.spec.title} spec={overlay.spec} close={() => setOverlay(overlay.returnTo ?? null)} />}
  </div>;
}

function capturePreset(project: Project): Preset['selections'] {
  return Object.fromEntries(project.endpoints.map(item => [item.id, { enabled: item.enabled, scenarioId: item.activeScenarioId }]));
}

function requestPath(url: string) {
  if (!url) return '未填写请求 URL';
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
  if (failed) return { label: '检测失败', tone: 'error' };
  if (!status) return { label: '连接检测中', tone: 'idle' };
  switch (status.syncState) {
    case 'offline': return { label: '引擎未运行', tone: 'idle' };
    case 'conflict': return { label: '规则冲突', tone: 'error' };
    case 'disabled':
      return { label: status.rulesDisabled ? '全局规则关闭' : everApplied ? 'Mock 已停用' : '尚未应用', tone: 'idle' };
    case 'pending': return { label: '待应用', tone: 'pending' };
    case 'synced': return localChanges ? { label: '待应用', tone: 'pending' } : { label: '已同步', tone: 'good' };
  }
}
