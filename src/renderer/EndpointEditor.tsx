import {
  Braces, Check, CircleAlert, Download, FileJson, ListFilter, Pencil, Plus, Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode, type UIEvent } from 'react';
import type { Condition, Endpoint, Project, Scenario } from '../shared/types';
import { getLocale, t } from '../shared/i18n';
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

  return <section className="endpoint-editor" aria-label={t('接口编辑器', 'Endpoint editor')}>
    <header className="endpoint-editor__heading">
      <div className="detail-crumb">
        <span>{props.project.name}</span><span aria-hidden="true">/</span><span>{moduleName(endpoint.module)}</span>
      </div>
      <div className="detail-title">
        <h1>{endpoint.name}</h1>
        <div className="detail-actions">
          <Switch checked={endpoint.enabled} label={t('启用接口', 'Enable endpoint')} disabled={busy} change={enabled => update(current => ({ ...current, enabled }))} />
          <IconButton label={t('编辑接口', 'Edit endpoint')} onClick={props.editEndpoint} disabled={busy}><Pencil size={15} aria-hidden="true" /></IconButton>
          <IconButton label={t('删除接口', 'Delete endpoint')} onClick={props.removeEndpoint} disabled={busy}><Trash2 size={15} aria-hidden="true" /></IconButton>
        </div>
      </div>
      <div className="request-url">
        <Method method={endpoint.method} />
        <code title={endpoint.url}>{endpoint.url || t('未填写请求 URL', 'No request URL')}</code>
      </div>
    </header>

    <div className="endpoint-editor__content">
      <Disclosure label={t('请求匹配条件', 'Request matching')} summary={conditionCount ? t('{count} 条', conditionCount === 1 ? '{count} condition' : '{count} conditions', { count: conditionCount }) : t('无附加条件', 'No extra conditions')}>
        <p className="muted">{t('请求必须满足下面的全部条件。键和值按相等匹配。', 'Requests must match every condition below. Keys and values use exact matching.')}</p>
        <ConditionList label="Query" values={endpoint.query} disabled={busy}
          change={query => update(current => ({ ...current, query }))} />
        <ConditionList label="Header" values={endpoint.headers} disabled={busy}
          change={headers => update(current => ({ ...current, headers }))} />
      </Disclosure>

      <section className="response" aria-labelledby="response-heading">
        <header className="response__heading">
          <h2 id="response-heading">{t('响应场景', 'Response scenarios')}</h2>
          <span className="muted">{t('应用后生效', 'Takes effect after Apply')}</span>
        </header>
        <div className="response__scene">
          <div className="scene-tabs" role="tablist" aria-label={t('响应场景', 'Response scenarios')}>
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
          <IconButton label={t('新增场景', 'Add scenario')} title={endpoint.scenarios.length >= 128 ? t('每个接口最多 128 个场景', 'Up to 128 scenarios per endpoint') : t('新增场景', 'Add scenario')}
            onClick={props.addScenario} disabled={busy || endpoint.scenarios.length >= 128}><Plus size={16} aria-hidden="true" /></IconButton>
          {scenario && <>
            <IconButton label={t('重命名场景', 'Rename scenario')} onClick={() => props.editScenario(scenario)} disabled={busy}><Pencil size={14} aria-hidden="true" /></IconButton>
            <IconButton label={t('删除场景', 'Delete scenario')} title={endpoint.scenarios.length === 1 ? t('至少保留一个场景', 'Keep at least one scenario') : t('删除场景', 'Delete scenario')}
              onClick={() => props.removeScenario(scenario)} disabled={busy || endpoint.scenarios.length === 1}><Trash2 size={14} aria-hidden="true" /></IconButton>
          </>}
        </div>
        {scenario && <div className="scene-panel" role="tabpanel" id="scenario-editor" aria-labelledby={`scenario-${scenario.id}`} key={scenario.id}>
          <div className="response-options">
            <div className="status-control">
              <NumberField label={t('状态码', 'Status')} min={200} max={599} value={scenario.status} disabled={busy}
                change={status => updateScenario({ status })} />
            </div>
            <div className="status-control">
              <NumberField label={t('延迟', 'Delay')} min={0} max={60_000} value={scenario.delay} disabled={busy}
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
      title={valid ? undefined : t('请输入 {min} 到 {max} 之间的整数', 'Enter a whole number from {min} to {max}', { min, max })}
      disabled={disabled} onBlur={() => { setEditing(undefined); }} onChange={event => {
        const text = event.target.value;
        setEditing(text);
        const next = event.target.valueAsNumber;
        if (Number.isInteger(next) && next >= min && next <= max) change(next);
      }} />
    {unit && <small>{unit}</small>}
    {!valid && <CircleAlert size={14} className="number-field__error" aria-label={t('允许范围 {min} 到 {max}', 'Allowed range: {min} to {max}', { min, max })} />}
  </label>;
}

function ConditionList({ label, values, change, disabled }: {
  label: string; values: Condition[]; change: (values: Condition[]) => void; disabled: boolean;
}) {
  return <div className="condition-list">
    <div className="condition-list__heading">
      <h3>{label}</h3>
      <Button kind="quiet" disabled={disabled || values.length >= 24} title={values.length >= 24 ? t('每类条件最多 24 条', 'Up to 24 conditions of each type') : undefined}
        onClick={() => change([...values, { key: '', value: '' }])}>
        <Plus size={14} aria-hidden="true" /> {t('添加 {label}', 'Add {label}', { label })}
      </Button>
    </div>
    {values.map((row, index) => (
      <div className="condition-row" key={index}>
        <input value={row.key} aria-label={t('{label} 键 {index}', '{label} key {index}', { label, index: index + 1 })} maxLength={256} placeholder={t('键', 'Key')} disabled={disabled}
          onChange={event => change(values.map((item, i) => i === index ? { ...item, key: event.target.value } : item))} />
        <span aria-hidden="true">=</span>
        <input value={row.value} aria-label={t('{label} 值 {index}', '{label} value {index}', { label, index: index + 1 })} maxLength={1024} placeholder={t('值', 'Value')} disabled={disabled}
          onChange={event => change(values.map((item, i) => i === index ? { ...item, value: event.target.value } : item))} />
        <IconButton label={t('删除 {label} 条件 {index}', 'Remove {label} condition {index}', { label, index: index + 1 })} disabled={disabled}
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
      title: previous ? t('编辑响应头', 'Edit response header') : t('添加响应头', 'Add response header'),
      submit: previous ? t('保存响应头', 'Save response header') : t('添加响应头', 'Add response header'),
      children: <>
        <Field label={t('响应头名称', 'Header name')}><input name="header" defaultValue={previous} required maxLength={256} placeholder="X-Mock-Source" /></Field>
        <Field label={t('响应头值', 'Header value')}><input name="value" defaultValue={headers[previous] ?? ''} maxLength={8192} placeholder="local" /></Field>
      </>,
      action: form => {
        const name = String(form.get('header') ?? '').trim();
        if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(name)) {
          throw new Error(t('请输入有效的 HTTP 响应头名称。', 'Enter a valid HTTP header name.'));
        }
        if (Object.keys(headers).some(key => key !== previous && key.toLowerCase() === name.toLowerCase())) {
          throw new Error(t('已存在同名响应头。', 'A header with this name already exists.'));
        }
        const next = Object.entries(headers).filter(([key]) => key !== previous);
        change(Object.fromEntries([...next, [name, String(form.get('value') ?? '')]]));
      },
    });
  }

  const headerRows = Object.entries(headers);
  return <Disclosure label={t('响应头', 'Response headers')} summary={headerRows.length ? t('{count} 条', headerRows.length === 1 ? '{count} header' : '{count} headers', { count: headerRows.length }) : t('默认 application/json', 'Default: application/json')}>
    {headerRows.map(([key, value]) => <div className="header-row" key={key}>
      <code title={key}>{key}</code>
      <code title={value}>{value}</code>
      <IconButton label={t('编辑响应头 {key}', 'Edit response header {key}', { key })} disabled={disabled} onClick={() => editHeader(key)}><Pencil size={14} aria-hidden="true" /></IconButton>
      <IconButton label={t('删除响应头 {key}', 'Delete response header {key}', { key })} disabled={disabled}
        onClick={() => change(Object.fromEntries(headerRows.filter(([item]) => item !== key)))}><Trash2 size={14} aria-hidden="true" /></IconButton>
    </div>)}
    <Button kind="quiet" disabled={disabled || headerRows.length >= 48} title={headerRows.length >= 48 ? t('每个场景最多 48 个响应头', 'Up to 48 headers per scenario') : undefined}
      onClick={() => editHeader()}><Plus size={14} aria-hidden="true" /> {t('添加响应头', 'Add response header')}</Button>
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
      return error instanceof Error ? error.message : t('JSON 格式有误', 'Invalid JSON');
    }
  }, [value]);
  const gutter = useRef<HTMLDivElement>(null);
  const ink = useRef<HTMLPreElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [metrics, setMetrics] = useState({ height: 400, lineHeight: 22 });
  const [formatError, setFormatError] = useState<'' | 'too-large' | 'nesting'>('');

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
  const error = parseError ? t('JSON 格式有误', 'Invalid JSON')
    : formatError === 'too-large' ? t('格式化后的正文超过 200 万个字符', 'The formatted body exceeds 2 million characters')
    : formatError === 'nesting' ? t('无法格式化此响应体，请检查 JSON 的嵌套层级', 'Unable to format this response. Check the JSON nesting depth.') : '';

  return <section className="json-editor" aria-label={t('JSON 响应体编辑器', 'JSON response editor')}>
    <header className="json-editor__bar">
      <span className="file-label"><Braces size={15} aria-hidden="true" /> {t('响应体', 'Response body')}</span>
      <div className="json-editor__commands">
        <Button kind="quiet" disabled={disabled} onClick={() => void importJson()}>
          <Download size={14} aria-hidden="true" /> {t('导入 JSON', 'Import JSON')}
        </Button>
        <Button kind="quiet" disabled={!!parseError || disabled} title={parseError ? t('请先修正 JSON 格式', 'Fix the JSON syntax first') : undefined}
          onClick={() => {
            try {
              const formatted = JSON.stringify(JSON.parse(value), null, 2);
              if (formatted.length > maxResponseLength) {
                setFormatError('too-large');
                return;
              }
              setFormatError('');
              change(formatted);
            } catch {
              setFormatError('nesting');
            }
          }}>
          <ListFilter size={15} aria-hidden="true" /> {t('格式化', 'Format')}
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
        aria-label={t('响应体 JSON', 'Response JSON')} aria-invalid={!!parseError} aria-describedby="json-validity"
        value={value} wrap="off" spellCheck={false} readOnly={disabled} maxLength={maxResponseLength}
        onChange={event => { setFormatError(''); change(event.target.value); }} onScroll={syncScroll} />
    </div>
    <footer className="json-editor__footer">
      <span id="json-validity" className={error ? 'json-invalid' : 'json-valid'} title={parseError || undefined}>
        {error ? <CircleAlert size={13} aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
        {error || t('JSON 有效', 'Valid JSON')}
      </span>
      <span>{t('{count} 行', lines === 1 ? '{count} line' : '{count} lines', { count: lines.toLocaleString(getLocale()) })}</span>
    </footer>
  </section>;
}
