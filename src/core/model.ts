import { t } from '../shared/i18n';
import { createHash, randomUUID } from 'node:crypto';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import type { AppData, AppliedSnapshot, Condition, Endpoint, HttpMethod, Preset, Project, Scenario } from '../shared/types';

const METHODS = new Set<HttpMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const CONTROL = /[\x00-\x1f\x7f\u2028\u2029]/;
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const TRANSPORT_HEADERS = new Set([
  'connection', 'content-encoding', 'content-length', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function invalid(label: string): never {
  throw new Error(t('无效的{label}', 'Invalid {label}', { label }));
}

function record(input: unknown, label: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid(label);
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== null && prototype !== Object.prototype) invalid(label);
  return input as Record<string, unknown>;
}

function array(input: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(input) || input.length > max) invalid(label);
  return input;
}

function string(input: unknown, label: string, max: number, allowControl = false): string {
  if (typeof input !== 'string' || input.length > max || (!allowControl && CONTROL.test(input))) invalid(label);
  return input;
}

function id(input: unknown, label: string): string {
  if (typeof input !== 'string' || !/^[a-z\d][a-z\d_-]{0,79}$/i.test(input) || RESERVED_KEYS.has(input)) invalid(label);
  return input;
}

function boolean(input: unknown, label: string): boolean {
  if (typeof input !== 'boolean') invalid(label);
  return input;
}

function integer(input: unknown, label: string, min: number, max: number): number {
  if (typeof input !== 'number' || !Number.isInteger(input) || input < min || input > max) invalid(label);
  return input;
}

function unique<T extends { id: string }>(items: T[], label: string): T[] {
  if (new Set(items.map((item) => item.id)).size !== items.length) invalid(t('{label}（ID 重复）', '{label} (duplicate IDs)', { label }));
  return items;
}

function conditions(input: unknown, label: string): Condition[] {
  return array(input, label, 24).map((item) => {
    const entry = record(item, label);
    return {
      key: string(entry.key, t('{label}名称', '{label} name', { label }), 256),
      value: string(entry.value, t('{label}值', '{label} value', { label }), 1024),
    };
  });
}

function scenario(input: unknown): Scenario {
  const entry = record(input, t("响应场景", "response scenario"));
  const headers = Object.entries(record(entry.headers, t("响应头", "response headers")));
  if (headers.length > 48) invalid(t("响应头（最多 48 项）", "response headers (up to 48)"));
  return {
    id: id(entry.id, t("场景 ID", "scenario ID")),
    name: string(entry.name, t("场景名称", "scenario name"), 160),
    body: string(entry.body, t("响应正文", "response body"), 2_000_000, true),
    status: integer(entry.status, t("HTTP 状态码（200–599）", "HTTP status code (200–599)"), 200, 599),
    delay: integer(entry.delay, t("延迟（0–60000 ms）", "delay (0–60000 ms)"), 0, 60_000),
    headers: Object.fromEntries(headers.map(([key, value]) => [
      string(key, t("响应头名称", "response header name"), 256), string(value, t("响应头值", "response header value"), 8192),
    ])),
  };
}

function assertNoCredentials(input: string, url: URL): void {
  // Even an empty userinfo component is outside the supported URL syntax.
  const authority = /^(?:https?:)?\/\/([^/?#]*)/i.exec(input.trim())?.[1];
  if (url.username || url.password || authority?.includes('@')) invalid(t("URL（请移除账号和密码）", "URL (remove the username and password)"));
}

function endpoint(input: unknown): Endpoint {
  const entry = record(input, t("接口", "endpoint"));
  const scenarios = unique(array(entry.scenarios, t("场景列表", "scenario list"), 128).map(scenario), t("场景列表", "scenario list"));
  const activeScenarioId = id(entry.activeScenarioId, t("当前场景 ID", "active scenario ID"));
  if (!scenarios.some((item) => item.id === activeScenarioId)) invalid(t("当前场景（场景不存在）", "active scenario (scenario does not exist)"));
  if (typeof entry.method !== 'string' || !METHODS.has(entry.method as HttpMethod)) invalid(t("HTTP 方法", "HTTP method"));
  const url = string(entry.url, 'URL', 4096);
  const parsed = URL.parse(url);
  if (parsed) assertNoCredentials(url, parsed);
  return {
    id: id(entry.id, t("接口 ID", "endpoint ID")),
    name: string(entry.name, t("接口名称", "endpoint name"), 160),
    module: string(entry.module, t("模块名称", "module name"), 160),
    url,
    method: entry.method as HttpMethod,
    enabled: boolean(entry.enabled, t("接口开关", "endpoint switch")),
    activeScenarioId,
    query: conditions(entry.query, t("查询条件", "query conditions")),
    headers: conditions(entry.headers, t("请求头条件", "request header conditions")),
    scenarios,
  };
}

function preset(input: unknown, endpoints: Map<string, Endpoint>): Preset {
  const entry = record(input, t("项目预设", "project preset"));
  const selections = Object.fromEntries(Object.entries(record(entry.selections, t("预设选择", "preset selection"))).map(([endpointId, input]) => {
    const selection = record(input, t("预设选择", "preset selection"));
    const scenarioId = id(selection.scenarioId, t("预设场景 ID", "preset scenario ID"));
    const target = endpoints.get(id(endpointId, t("预设接口 ID", "preset endpoint ID")));
    if (!target?.scenarios.some((item) => item.id === scenarioId)) invalid(t("预设选择（接口或场景不存在）", "preset selection (endpoint or scenario does not exist)"));
    return [endpointId, { enabled: boolean(selection.enabled, t("预设接口开关", "preset endpoint switch")), scenarioId }];
  }));
  return { id: id(entry.id, t("预设 ID", "preset ID")), name: string(entry.name, t("预设名称", "preset name"), 160), selections };
}

export function validateProjects(input: unknown): Project[] {
  return unique(array(input, t("项目列表", "project list"), 256).map((input) => {
    const entry = record(input, t("项目", "project"));
    const endpoints = unique(array(entry.endpoints, t("接口列表", "endpoint list"), 1024).map(endpoint), t("接口列表", "endpoint list"));
    const byId = new Map(endpoints.map((item) => [item.id, item]));
    return {
      id: id(entry.id, t("项目 ID", "project ID")),
      name: string(entry.name, t("项目名称", "project name"), 160),
      description: string(entry.description, t("项目说明", "project description"), 4096, true),
      endpoints,
      presets: unique(array(entry.presets, t("项目预设列表", "project preset list"), 256).map((item) => preset(item, byId)), t("项目预设列表", "project preset list")),
    };
  }), t("项目列表", "project list"));
}

function snapshot(input: unknown): AppliedSnapshot {
  const entry = record(input, t("已应用快照", "applied snapshot"));
  const hash = string(entry.hash, t("快照哈希", "snapshot hash"), 64);
  const at = string(entry.at, t("快照日期", "snapshot date"), 64);
  const ruleName = string(entry.ruleName, t("Whistle 规则名称", "proxy rule name"), 160);
  if (!/^[0-9a-f]{64}$/.test(hash) || !Number.isFinite(Date.parse(at)) || !ruleName.trim()) invalid(t("已应用快照", "applied snapshot"));
  const projects = validateProjects(entry.projects);
  if (configurationHash(projects) !== hash) invalid(t("已应用快照（校验不一致）", "applied snapshot (checksum mismatch)"));
  return { hash, at, ruleName, rules: string(entry.rules, t("Whistle 规则内容", "proxy rules"), 8_000_000, true), projects };
}

export function validateData(input: unknown): AppData {
  const entry = record(input, t("配置", "configuration"));
  if (entry.schemaVersion !== 1) invalid(t("配置版本", "configuration version"));
  record(entry.settings, t("本机设置", "local settings"));
  const validated: AppData = {
    schemaVersion: 1,
    installationId: id(entry.installationId, t("安装 ID", "installation ID")),
    projects: validateProjects(entry.projects),
    settings: { engineMode: 'builtin' },
  };
  if (entry.lastApplied !== undefined) validated.lastApplied = snapshot(entry.lastApplied);
  return validated;
}

export function createInitialData(): AppData {
  const example = (name: string, path: string, body: string, module = t("概览", "Overview")): Endpoint => {
    const scenarios: Scenario[] = [
      { id: randomUUID(), name: t("成功", "Success"), body, status: 200, delay: 0, headers: {} },
      { id: randomUUID(), name: t("空数据", "Empty data"), body: '{\n  "data": []\n}', status: 200, delay: 0, headers: {} },
      { id: randomUUID(), name: t("服务异常", "Server error"), body: JSON.stringify({ error: t('暂时无法获取数据', 'Data is temporarily unavailable') }, null, 2), status: 500, delay: 0, headers: {} },
    ];
    return {
      id: randomUUID(), name, module, url: 'https://api.example.test' + path,
      method: 'GET', enabled: false, activeScenarioId: scenarios[0].id, query: [], headers: [], scenarios,
    };
  };
  return {
    schemaVersion: 1,
    installationId: randomUUID(),
    settings: { engineMode: 'builtin' },
    projects: [{
      id: randomUUID(),
      name: t("示例项目", "Example project"),
      description: t("仅用于演示。示例域名 api.example.test 不指向生产环境；所有接口默认关闭。", "For demonstration only. The example domain api.example.test does not point to production; all endpoints are disabled by default."),
      endpoints: [
        example(t("获取概览", "Get overview"), '/api/v1/overview', '{\n  "data": {\n    "visitors": 128,\n    "orders": 24\n  }\n}'),
        example(t("获取商品列表", "Get products"), '/api/v1/products', t('{\n  "data": [\n    { "id": 1, "name": "示例商品" }\n  ]\n}', '{\n  "data": [\n    { "id": 1, "name": "Example product" }\n  ]\n}'), t("商品", "Products")),
      ],
      presets: [],
    }],
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const entry = value as Record<string, unknown>;
    return '{' + Object.keys(entry).sort().map((key) => JSON.stringify(key) + ':' + canonical(entry[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function configurationHash(projects: Project[]): string {
  return createHash('sha256').update(canonical(projects)).digest('hex');
}

export interface ActiveRoute {
  endpoint: Endpoint;
  scenario: Scenario;
  url: URL;
  query: Condition[];
  headers: Map<string, string>;
}

function routeUrl(input: string): URL {
  const text = input.trim();
  const url = URL.parse(text);
  if (!url || !/^https?:\/\//i.test(text) || /[\\#]/.test(text)) invalid(t("接口 URL（仅支持无片段的 HTTP/HTTPS URL）", "endpoint URL (HTTP/HTTPS URLs without fragments only)"));
  assertNoCredentials(text, url);
  return url;
}

function requestHeaders(conditions: Condition[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const { key, value } of conditions) {
    const name = key.toLowerCase();
    validateHeaderName(name);
    if (RESERVED_KEYS.has(name) || /#|^!|!$/.test(name)) invalid(t("请求头名称（Whistle 无法精确匹配此名称）", "request header name (the proxy engine cannot match it exactly)"));
    validateHeaderValue(name, value);
    if (result.has(name) && result.get(name) !== value) invalid(t('请求头条件（{name} 的值冲突）', 'request header conditions (conflicting values for {name})', { name }));
    result.set(name, value);
  }
  return result;
}

function responseHeaders(headers: Record<string, string>): void {
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    validateHeaderName(name);
    validateHeaderValue(name, value);
    if (seen.has(name)) invalid(t('响应头（{name} 重复）', 'response headers (duplicate {name})', { name }));
    if (RESERVED_KEYS.has(name) || TRANSPORT_HEADERS.has(name) || name.startsWith('x-whistle-')) {
      invalid(t('响应头（{name} 由代理管理）', 'response headers ({name} is managed by the proxy)', { name }));
    }
    seen.add(name);
  }
}

function potentiallyOverlaps(a: ActiveRoute, b: ActiveRoute): boolean {
  // Query keys may repeat, so differing values do not prove disjoint requests.
  for (const [key, value] of a.headers) {
    if (b.headers.has(key) && b.headers.get(key) !== value) return false;
  }
  return true;
}

export function activeRoutes(data: AppData): ActiveRoute[] {
  const clean = validateData(data);
  const active: ActiveRoute[] = [];
  const routesByTarget = new Map<string, ActiveRoute[]>();
  for (const project of clean.projects) {
    for (const endpoint of project.endpoints) {
      if (!endpoint.enabled) continue;
      const label = [project.name, endpoint.name || endpoint.id].filter(Boolean).join(' / ');
      let route: ActiveRoute;
      try {
        const url = routeUrl(endpoint.url);
        const query = [...endpoint.query];
        for (const [key, value] of url.searchParams) query.push({ key, value });
        if (query.length > 24 || query.some(({ key, value }) => !key || key.length > 256 ||
          value.length > 1024 || CONTROL.test(key) || CONTROL.test(value))) invalid(t("查询条件（名称不能为空，最多 24 项）", "query conditions (names cannot be empty; up to 24 conditions)"));
        const scenario = endpoint.scenarios.find((item) => item.id === endpoint.activeScenarioId)!;
        try {
          JSON.parse(scenario.body);
        } catch {
          throw new Error(t('响应场景「{name}」的 JSON 无效', 'Invalid JSON in response scenario "{name}"', { name: scenario.name || scenario.id }));
        }
        responseHeaders(scenario.headers);
        route = { endpoint, scenario, url, query, headers: requestHeaders(endpoint.headers) };
      } catch (error) {
        throw new Error(t('{label}：{error}', '{label}: {error}', { label, error: error instanceof Error ? error.message : String(error) }));
      }
      const target = `${endpoint.method} ${route.url.origin}${route.url.pathname}`;
      const previous = routesByTarget.get(target) || [];
      const conflict = previous.find((other) => potentiallyOverlaps(route, other));
      if (conflict) throw new Error(t('接口匹配冲突：{label} 与「{other}」可能匹配同一请求（{target}）', 'Endpoint conflict: {label} and "{other}" may match the same request ({target})', { label, other: conflict.endpoint.name || conflict.endpoint.id, target }));
      previous.push(route);
      routesByTarget.set(target, previous);
      active.push(route);
    }
  }
  return active;
}

export function validateForApply(data: AppData): void {
  activeRoutes(data);
}
