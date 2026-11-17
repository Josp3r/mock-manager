import {
  Braces, Check, CircleAlert, Clock3, Code2, Download, FileJson, ListFilter, Pencil, Plus, Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode, type UIEvent } from 'react';
import type { Condition, Endpoint, Project, Scenario } from '../shared/types';
import { maxResponseLength, moduleName } from './model';
import { Button, Disclosure, Field, IconButton, Method, Switch, type FormSpec } from './ui';

interface EditorProps {
  project: Project;
  endpoint: Endpoint;
  busy: boolean;
  update: (update: (endpoint: Endpoint) => Endpoint) => void;
  editEndpoint: () => void;
  removeEndpoint: () => void;
  addScenario: () => void;
  editScenario: (scenario: Scenario) => void;
  removeScenario: (scenario: Scenario) => void;
  prompt: (spec: FormSpec) => void;
  importJson: () => Promise<string | null>;
}

export function EndpointEditor(props: EditorProps) {
  const { endpoint, busy, update } = props;
  const scenario = endpoint.scenarios.find(item => item.id === endpoint.activeScenarioId) ?? endpoint.scenarios[0];
  const conditionCount = endpoint.query.length + endpoint.headers.length;
  const tabs = useRef(new Map<string, HTMLButtonElement>());

  function selectScenario(id: string) {
    update(current => ({ ...current, activeScenarioId: id }));
  }

  function updateScenario(patch: Partial<Scenario>) {
    update(current => ({
      ...current,
      scenarios: current.scenarios.map(item => item.id === scenario.id ? { ...item, ...patch } : item),
    }));
  }

  return <section className="endpoint-editor" aria-label="接口编辑器">
    <header className="endpoint-editor__heading">
      <div className="detail-crumb">
        <span>{props.project.name}</span><span aria-hidden="true">/</span><span>{moduleName(endpoint.module)}</span>
      </div>
      <div className="detail-title">
        <h1>{endpoint.name}</h1>
        <div className="detail-actions">
          <Switch checked={endpoint.enabled} label="启用接口" disabled={busy} change={enabled => update(current => ({ ...current, enabled }))} />
          <IconButton label="编辑接口" onClick={props.editEndpoint} disabled={busy}><Pencil size={15} aria-hidden="true" /></IconButton>
          <IconButton label="删除接口" onClick={props.removeEndpoint} disabled={busy}><Trash2 size={15} aria-hidden="true" /></IconButton>
        </div>
      </div>
      <div className="request-url">
        <Method method={endpoint.method} />
        <code title={endpoint.url}>{endpoint.url || '未填写请求 URL'}</code>
      </div>
    </header>

    <div className="endpoint-editor__content">
      <Disclosure label="请求匹配条件" summary={conditionCount ? `${conditionCount} 条` : '无附加条件'}>
        <p className="muted">请求必须满足下面的全部条件。键和值按相等匹配。</p>
        <ConditionList label="Query" values={endpoint.query} disabled={busy}
          change={query => update(current => ({ ...current, query }))} />
        <ConditionList label="Header" values={endpoint.headers} disabled={busy}
          change={headers => update(current => ({ ...current, headers }))} />
      </Disclosure>

      <section className="response" aria-labelledby="response-heading">
        <header className="response__heading">
          <h2 id="response-heading">响应场景</h2>
          <span className="muted">应用后切换</span>
        </header>
        <div className="response__scene">
          <div className="scene-tabs" role="tablist" aria-label="响应场景">
            {endpoint.scenarios.map((item, index) => (
              <button type="button" key={item.id} role="tab" aria-selected={scenario?.id === item.id}
                id={`scenario-${item.id}`} aria-controls="scenario-editor"
                ref={node => { if (node) tabs.current.set(item.id, node); else tabs.current.delete(item.id); }}
                tabIndex={scenario?.id === item.id ? 0 : -1} disabled={busy} title={item.name}
                onClick={() => selectScenario(item.id)}
                onKeyDown={event => {
                  const length = endpoint.scenarios.length;
                  const targets: Record<string, number> = {
                    ArrowRight: (index + 1) % length, ArrowLeft: (index + length - 1) % length,
                    Home: 0, End: length - 1,
                  };
                  const next = targets[event.key];
                  if (next === undefined) return;
                  event.preventDefault();
                  const target = endpoint.scenarios[next].id;
                  selectScenario(target);
                  tabs.current.get(target)?.focus();
                }}>
                <FileJson size={14} aria-hidden="true" /><span>{item.name}</span>
              </button>
            ))}
          </div>
          <IconButton label="新增场景" title={endpoint.scenarios.length >= 128 ? '每个接口最多 128 个场景' : '新增场景'}
            onClick={props.addScenario} disabled={busy || endpoint.scenarios.length >= 128}><Plus size={16} aria-hidden="true" /></IconButton>
          {scenario && <>
            <IconButton label="重命名场景" onClick={() => props.editScenario(scenario)} disabled={busy}><Pencil size={14} aria-hidden="true" /></IconButton>
            <IconButton label="删除场景" title={endpoint.scenarios.length === 1 ? '至少保留一个场景' : '删除场景'}
              onClick={() => props.removeScenario(scenario)} disabled={busy || endpoint.scenarios.length === 1}><Trash2 size={14} aria-hidden="true" /></IconButton>
          </>}
        </div>
        {scenario && <div className="scene-panel" role="tabpanel" id="scenario-editor" aria-labelledby={`scenario-${scenario.id}`} key={scenario.id}>
          <div className="response-options">
            <div className="status-control">
              <span className="option-icon"><Code2 size={15} aria-hidden="true" /></span>
              <NumberField label="HTTP 状态码" min={200} max={599} value={scenario.status} disabled={busy}
                change={status => updateScenario({ status })} />
            </div>
            <div className="status-control">
              <span className="option-icon"><Clock3 size={15} aria-hidden="true" /></span>
              <NumberField label="延迟" min={0} max={60_000} value={scenario.delay} disabled={busy}
                change={delay => updateScenario({ delay })} unit="ms" />
            </div>
          </div>
          <JsonEditor value={scenario.body} disabled={busy}
            change={body => updateScenario({ body })}
            importJson={async () => {
              const body = await props.importJson();
              if (body !== null) updateScenario({ body });
            }} />
          <ResponseHeaders headers={scenario.headers} disabled={busy} prompt={props.prompt}
            change={headers => updateScenario({ headers })} />
        </div>}
      </section>
    </div>
  </section>;
}

function NumberField({ label, min, max, value, change, disabled, unit }: {
  label: string; min: number; max: number; value: number;
  change: (value: number) => void; disabled: boolean; unit?: string;
}) {
  const [editing, setEditing] = useState<string>();
  const valid = editing === undefined || (/^\d+$/.test(editing) && Number(editing) >= min && Number(editing) <= max);
  return <label className="number-field">
    <span>{label}</span>
    <input type="number" min={min} max={max} step={1} value={editing ?? value} aria-label={label} aria-invalid={!valid}
      title={valid ? undefined : `请输入 ${min} 到 ${max} 之间的整数`}
      disabled={disabled} onBlur={() => { setEditing(undefined); }} onChange={event => {
        const text = event.target.value;
        setEditing(text);
        const next = event.target.valueAsNumber;
        if (Number.isInteger(next) && next >= min && next <= max) change(next);
      }} />
    {unit && <small>{unit}</small>}
    {!valid && <CircleAlert size={14} className="number-field__error" aria-label={`允许范围 ${min} 到 ${max}`} />}
  </label>;
}

function ConditionList({ label, values, change, disabled }: {
  label: string; values: Condition[]; change: (values: Condition[]) => void; disabled: boolean;
}) {
  return <div className="condition-list">
    <div className="condition-list__heading">
      <h3>{label}</h3>
      <Button kind="quiet" disabled={disabled || values.length >= 24} title={values.length >= 24 ? '每类条件最多 24 条' : undefined}
        onClick={() => change([...values, { key: '', value: '' }])}>
        <Plus size={14} aria-hidden="true" /> 添加 {label}
      </Button>
    </div>
    {values.map((row, index) => (
      <div className="condition-row" key={index}>
        <input value={row.key} aria-label={`${label} 键 ${index + 1}`} maxLength={256} placeholder="键" disabled={disabled}
          onChange={event => change(values.map((item, i) => i === index ? { ...item, key: event.target.value } : item))} />
        <span aria-hidden="true">=</span>
        <input value={row.value} aria-label={`${label} 值 ${index + 1}`} maxLength={1024} placeholder="值" disabled={disabled}
          onChange={event => change(values.map((item, i) => i === index ? { ...item, value: event.target.value } : item))} />
        <IconButton label={`删除 ${label} 条件 ${index + 1}`} disabled={disabled}
          onClick={() => change(values.filter((_, i) => i !== index))}><Trash2 size={14} aria-hidden="true" /></IconButton>
      </div>
    ))}
  </div>;
}

function ResponseHeaders({ headers, change, disabled, prompt }: {
  headers: Record<string, string>; change: (headers: Record<string, string>) => void;
  disabled: boolean; prompt: (form: FormSpec) => void;
}) {
  function editHeader(previous = '') {
    prompt({
      title: previous ? '编辑响应头' : '添加响应头',
      submit: previous ? '保存响应头' : '添加响应头',
      children: <>
        <Field label="响应头名称"><input name="header" defaultValue={previous} required maxLength={256} placeholder="X-Mock-Source" /></Field>
        <Field label="响应头值"><input name="value" defaultValue={headers[previous] ?? ''} maxLength={8192} placeholder="local" /></Field>
      </>,
      action: form => {
        const name = String(form.get('header') ?? '').trim();
        if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(name)) {
          throw new Error('请输入有效的 HTTP 响应头名称。');
        }
        if (Object.keys(headers).some(key => key !== previous && key.toLowerCase() === name.toLowerCase())) {
          throw new Error('已存在同名响应头。');
        }
        const next = Object.entries(headers).filter(([key]) => key !== previous);
        change(Object.fromEntries([...next, [name, String(form.get('value') ?? '')]]));
      },
    });
  }

  const headerRows = Object.entries(headers);
  return <Disclosure label="响应头" summary={headerRows.length ? `${headerRows.length} 条` : '默认 application/json'}>
    {headerRows.map(([key, value]) => <div className="header-row" key={key}>
      <code title={key}>{key}</code>
      <code title={value}>{value}</code>
      <IconButton label={`编辑响应头 ${key}`} disabled={disabled} onClick={() => editHeader(key)}><Pencil size={14} aria-hidden="true" /></IconButton>
      <IconButton label={`删除响应头 ${key}`} disabled={disabled}
        onClick={() => change(Object.fromEntries(headerRows.filter(([item]) => item !== key)))}><Trash2 size={14} aria-hidden="true" /></IconButton>
    </div>)}
    <Button kind="quiet" disabled={disabled || headerRows.length >= 48} title={headerRows.length >= 48 ? '每个场景最多 48 个响应头' : undefined}
      onClick={() => editHeader()}><Plus size={14} aria-hidden="true" /> 添加响应头</Button>
  </Disclosure>;
}

const jsonToken = /("(?:\\.|[^"\\])*"(?:\s*:)?|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\b(?:true|false|null)\b)/g;

function paintJson(text: string): ReactNode[] {
  const spans: ReactNode[] = [];
  let start = 0;
  for (const match of text.matchAll(jsonToken)) {
    const index = match.index;
    const token = match[0];
    if (index > start) spans.push(text.slice(start, index));
    let color = 'literal';
    if (token.startsWith('"')) color = token.endsWith(':') ? 'key' : 'string';
    spans.push(<span className={`json-token--${color}`} key={index}>{token}</span>);
    start = index + token.length;
  }
  spans.push(text.slice(start));
  return spans;
}

function JsonEditor({ value, disabled, change, importJson }: {
  value: string; disabled: boolean; change: (value: string) => void; importJson: () => Promise<void>;
}) {
  const highlighted = useMemo(() => value.length <= 60_000 ? paintJson(value) : null, [value]);
  const lines = useMemo(() => value.split('\n').length, [value]);
  const parseError = useMemo(() => {
    try {
      JSON.parse(value);
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : 'JSON 格式有误';
    }
  }, [value]);
  const gutter = useRef<HTMLDivElement>(null);
  const ink = useRef<HTMLPreElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [metrics, setMetrics] = useState({ height: 400, lineHeight: 22 });
  const [formatError, setFormatError] = useState('');

  const syncScroll = (event: UIEvent<HTMLTextAreaElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
    if (ink.current) {
      ink.current.scrollTop = event.currentTarget.scrollTop;
      ink.current.scrollLeft = event.currentTarget.scrollLeft;
    }
  };

  useEffect(() => {
    const element = gutter.current;
    if (!element) return;
    const observe = new ResizeObserver(() => setMetrics({
      height: element.clientHeight,
      lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
    }));
    observe.observe(element);
    return () => observe.disconnect();
  }, []);

  const firstLine = Math.min(lines - 1, Math.floor(scrollTop / metrics.lineHeight));
  const visibleLines = Math.min(lines - firstLine, Math.ceil(metrics.height / metrics.lineHeight) + 1);
  const error = parseError ? 'JSON 格式有误' : formatError;

  return <section className="json-editor" aria-label="JSON 响应体编辑器">
    <header className="json-editor__bar">
      <span className="file-label"><Braces size={15} aria-hidden="true" /> 响应体</span>
      <div className="json-editor__commands">
        <Button kind="quiet" disabled={disabled} onClick={() => void importJson()}>
          <Download size={14} aria-hidden="true" /> 导入 JSON
        </Button>
        <Button kind="quiet" disabled={!!parseError || disabled} title={parseError ? '请先修正 JSON 格式' : undefined}
          onClick={() => {
            try {
              const formatted = JSON.stringify(JSON.parse(value), null, 2);
              if (formatted.length > maxResponseLength) {
                setFormatError('格式化后的正文超过 200 万个字符');
                return;
              }
              setFormatError('');
              change(formatted);
            } catch {
              setFormatError('无法格式化此响应体，请检查 JSON 的嵌套层级');
            }
          }}>
          <ListFilter size={15} aria-hidden="true" /> 格式化
        </Button>
      </div>
    </header>
    <div className="json-editor__surface">
      <div className="json-editor__gutter" ref={gutter} aria-hidden="true">
        <div style={{ transform: `translateY(-${scrollTop % metrics.lineHeight}px)` }}>
          {Array.from({ length: visibleLines }, (_, index) => <div key={index}>{firstLine + index + 1}</div>)}
        </div>
      </div>
      {highlighted && <pre className="json-editor__ink" aria-hidden="true" ref={ink}>{highlighted}{'\n'}</pre>}
      <textarea className={highlighted ? 'json-editor__input json-editor__input--highlighted' : 'json-editor__input'}
        aria-label="响应体 JSON" aria-invalid={!!parseError} aria-describedby="json-validity"
        value={value} wrap="off" spellCheck={false} readOnly={disabled} maxLength={maxResponseLength}
        onChange={event => { setFormatError(''); change(event.target.value); }} onScroll={syncScroll} />
    </div>
    <footer className="json-editor__footer">
      <span id="json-validity" className={error ? 'json-invalid' : 'json-valid'} title={parseError || undefined}>
        {error ? <CircleAlert size={13} aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
        {error || 'JSON 有效'}
      </span>
      <span>{lines.toLocaleString('zh-CN')} 行</span>
    </footer>
  </section>;
}
