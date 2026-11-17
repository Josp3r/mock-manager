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
  throw new Error(`无效的${label}`);
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
  if (new Set(items.map((item) => item.id)).size !== items.length) invalid(`${label}（ID 重复）`);
  return items;
}

function conditions(input: unknown, label: string): Condition[] {
  return array(input, label, 24).map((item) => {
    const entry = record(item, label);
    return {
      key: string(entry.key, `${label}名称`, 256),
      value: string(entry.value, `${label}值`, 1024),
    };
  });
}

function scenario(input: unknown): Scenario {
  const entry = record(input, '响应场景');
  const headers = Object.entries(record(entry.headers, '响应头'));
  if (headers.length > 48) invalid('响应头（最多 48 项）');
  return {
    id: id(entry.id, '场景 ID'),
    name: string(entry.name, '场景名称', 160),
    body: string(entry.body, '响应正文', 2_000_000, true),
    status: integer(entry.status, 'HTTP 状态码（200–599）', 200, 599),
    delay: integer(entry.delay, '延迟（0–60000 ms）', 0, 60_000),
    headers: Object.fromEntries(headers.map(([key, value]) => [
      string(key, '响应头名称', 256), string(value, '响应头值', 8192),
    ])),
  };
}

function assertNoCredentials(input: string, url: URL): void {
  // Even an empty userinfo component is outside the supported URL syntax.
  const authority = /^(?:https?:)?\/\/([^/?#]*)/i.exec(input.trim())?.[1];
  if (url.username || url.password || authority?.includes('@')) invalid('URL（请移除账号和密码）');
}

function endpoint(input: unknown): Endpoint {
  const entry = record(input, '接口');
  const scenarios = unique(array(entry.scenarios, '场景列表', 128).map(scenario), '场景列表');
  const activeScenarioId = id(entry.activeScenarioId, '当前场景 ID');
  if (!scenarios.some((item) => item.id === activeScenarioId)) invalid('当前场景（场景不存在）');
  if (typeof entry.method !== 'string' || !METHODS.has(entry.method as HttpMethod)) invalid('HTTP 方法');
  const url = string(entry.url, 'URL', 4096);
  const parsed = URL.parse(url);
  if (parsed) assertNoCredentials(url, parsed);
  return {
    id: id(entry.id, '接口 ID'),
    name: string(entry.name, '接口名称', 160),
    module: string(entry.module, '模块名称', 160),
    url,
    method: entry.method as HttpMethod,
    enabled: boolean(entry.enabled, '接口开关'),
    activeScenarioId,
    query: conditions(entry.query, '查询条件'),
    headers: conditions(entry.headers, '请求头条件'),
    scenarios,
  };
}

function preset(input: unknown, endpoints: Map<string, Endpoint>): Preset {
  const entry = record(input, '项目预设');
  const selections = Object.fromEntries(Object.entries(record(entry.selections, '预设选择')).map(([endpointId, input]) => {
    const selection = record(input, '预设选择');
    const scenarioId = id(selection.scenarioId, '预设场景 ID');
    const target = endpoints.get(id(endpointId, '预设接口 ID'));
    if (!target?.scenarios.some((item) => item.id === scenarioId)) invalid('预设选择（接口或场景不存在）');
    return [endpointId, { enabled: boolean(selection.enabled, '预设接口开关'), scenarioId }];
  }));
  return { id: id(entry.id, '预设 ID'), name: string(entry.name, '预设名称', 160), selections };
}

export function validateProjects(input: unknown): Project[] {
  return unique(array(input, '项目列表', 256).map((input) => {
    const entry = record(input, '项目');
    const endpoints = unique(array(entry.endpoints, '接口列表', 1024).map(endpoint), '接口列表');
    const byId = new Map(endpoints.map((item) => [item.id, item]));
    return {
      id: id(entry.id, '项目 ID'),
      name: string(entry.name, '项目名称', 160),
      description: string(entry.description, '项目说明', 4096, true),
      endpoints,
      presets: unique(array(entry.presets, '项目预设列表', 256).map((item) => preset(item, byId)), '项目预设列表'),
    };
  }), '项目列表');
}

function snapshot(input: unknown): AppliedSnapshot {
  const entry = record(input, '已应用快照');
  const hash = string(entry.hash, '快照哈希', 64);
  const at = string(entry.at, '快照日期', 64);
  const ruleName = string(entry.ruleName, 'Whistle 规则名称', 160);
  if (!/^[0-9a-f]{64}$/.test(hash) || !Number.isFinite(Date.parse(at)) || !ruleName.trim()) invalid('已应用快照');
  const projects = validateProjects(entry.projects);
  if (configurationHash(projects) !== hash) invalid('已应用快照（校验不一致）');
  return { hash, at, ruleName, rules: string(entry.rules, 'Whistle 规则内容', 8_000_000, true), projects };
}

export function validateData(input: unknown): AppData {
  const entry = record(input, '配置');
  if (entry.schemaVersion !== 1) invalid('配置版本');
  const settings = record(entry.settings, '本机设置');
  const validated: AppData = {
    schemaVersion: 1,
    installationId: id(entry.installationId, '安装 ID'),
    projects: validateProjects(entry.projects),
    settings: { w2Path: string(settings.w2Path, 'Whistle 路径', 4096) },
  };
  if (entry.lastApplied !== undefined) validated.lastApplied = snapshot(entry.lastApplied);
  return validated;
}

export function createInitialData(): AppData {
  const example = (name: string, path: string, body: string, module = '概览'): Endpoint => {
    const scenarios: Scenario[] = [
      { id: randomUUID(), name: '成功', body, status: 200, delay: 0, headers: {} },
      { id: randomUUID(), name: '空数据', body: '{\n  "data": []\n}', status: 200, delay: 0, headers: {} },
      { id: randomUUID(), name: '服务异常', body: '{\n  "error": "暂时无法获取数据"\n}', status: 500, delay: 0, headers: {} },
    ];
    return {
      id: randomUUID(), name, module, url: 'https://api.example.test' + path,
      method: 'GET', enabled: false, activeScenarioId: scenarios[0].id, query: [], headers: [], scenarios,
    };
  };
  return {
    schemaVersion: 1,
    installationId: randomUUID(),
    settings: { w2Path: '' },
    projects: [{
      id: randomUUID(),
      name: '示例项目',
      description: '仅用于演示。示例域名 api.example.test 不指向生产环境；所有接口默认关闭。',
      endpoints: [
        example('获取概览', '/api/v1/overview', '{\n  "data": {\n    "visitors": 128,\n    "orders": 24\n  }\n}'),
        example('获取商品列表', '/api/v1/products', '{\n  "data": [\n    { "id": 1, "name": "示例商品" }\n  ]\n}', '商品'),
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
  if (!url || !/^https?:\/\//i.test(text) || /[\\#]/.test(text)) invalid('接口 URL（仅支持无片段的 HTTP/HTTPS URL）');
  assertNoCredentials(text, url);
  return url;
}

function requestHeaders(conditions: Condition[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const { key, value } of conditions) {
    const name = key.toLowerCase();
    validateHeaderName(name);
    if (RESERVED_KEYS.has(name) || /#|^!|!$/.test(name)) invalid('请求头名称（Whistle 无法精确匹配此名称）');
    validateHeaderValue(name, value);
    if (result.has(name) && result.get(name) !== value) invalid(`请求头条件（${name} 的值冲突）`);
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
    if (seen.has(name)) invalid(`响应头（${name} 重复）`);
    if (RESERVED_KEYS.has(name) || TRANSPORT_HEADERS.has(name) || name.startsWith('x-whistle-')) {
      invalid(`响应头（${name} 由代理管理）`);
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
          value.length > 1024 || CONTROL.test(key) || CONTROL.test(value))) invalid('查询条件（名称不能为空，最多 24 项）');
        const scenario = endpoint.scenarios.find((item) => item.id === endpoint.activeScenarioId)!;
        try {
          JSON.parse(scenario.body);
        } catch {
          throw new Error(`响应场景「${scenario.name || scenario.id}」的 JSON 无效`);
        }
        responseHeaders(scenario.headers);
        route = { endpoint, scenario, url, query, headers: requestHeaders(endpoint.headers) };
      } catch (error) {
        throw new Error(`${label}：${error instanceof Error ? error.message : String(error)}`);
      }
      const target = `${endpoint.method} ${route.url.origin}${route.url.pathname}`;
      const previous = routesByTarget.get(target) || [];
      const conflict = previous.find((other) => potentiallyOverlaps(route, other));
      if (conflict) throw new Error(`接口匹配冲突：${label} 与「${conflict.endpoint.name || conflict.endpoint.id}」可能匹配同一请求（${target}）`);
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
