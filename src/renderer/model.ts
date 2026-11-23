import { t, getLocale } from '../shared/i18n';
import type { Endpoint, HttpMethod, Project, Scenario } from '../shared/types';

export const methods: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
export const maxResponseLength = 2_000_000;

export function makeScenario(name: string): Scenario {
  return { id: crypto.randomUUID(), name, body: '{\n  "ok": true\n}', status: 200, delay: 0, headers: {} };
}

export function readUrl(text: string) {
  const raw = text.trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(t('请输入完整的 HTTP 或 HTTPS URL。', 'Enter a complete HTTP or HTTPS URL.'));
  }
  if (!/^https?:\/\//i.test(raw) || raw.includes('\\') || !parsed.hostname) {
    throw new Error(t('请输入完整的 HTTP 或 HTTPS URL。', 'Enter a complete HTTP or HTTPS URL.'));
  }
  const authority = /^https?:\/\/([^/?#]*)/i.exec(raw)?.[1];
  if (parsed.username || parsed.password || authority?.includes('@')) throw new Error(t('请求 URL 不能包含用户名或密码。', 'The request URL must not contain a username or password.'));
  if (raw.includes('#')) throw new Error(t('请移除请求 URL 中的片段（# 后的内容）。', 'Remove the URL fragment (the part after #).'));

  const query = [...parsed.searchParams.entries()].map(([key, value]) => ({ key, value }));
  const controls = /[\x00-\x1f\x7f\u2028\u2029]/;
  if (controls.test(raw) || query.some(({ key, value }) => controls.test(key) || controls.test(value))) {
    throw new Error(t('URL 和查询参数不能包含控制字符。', 'The URL and query parameters must not contain control characters.'));
  }
  if (query.some(({ key, value }) => !key || key.length > 256 || value.length > 1024)) {
    throw new Error(t('请检查 URL 中的查询参数名称和长度。', 'Check the query parameter names and lengths in the URL.'));
  }
  return { url: raw.split('?')[0], query };
}

export function saveEndpoint(project: Project, endpoint: Endpoint) {
  const exists = project.endpoints.some(item => item.id === endpoint.id);
  return { ...project, endpoints: exists
    ? project.endpoints.map(item => item.id === endpoint.id ? endpoint : item)
    : [...project.endpoints, endpoint] };
}

export function deleteEndpoint(project: Project, id: string) {
  return {
    ...project,
    endpoints: project.endpoints.filter(endpoint => endpoint.id !== id),
    presets: project.presets.map(preset => ({
      ...preset,
      selections: Object.fromEntries(Object.entries(preset.selections).filter(([key]) => key !== id)),
    })),
  };
}

export function deleteScenario(project: Project, endpoint: Endpoint, scenario: Scenario) {
  const scenarios = endpoint.scenarios.filter(item => item.id !== scenario.id);
  if (!scenarios.length) return project;
  const updated = saveEndpoint(project, {
    ...endpoint,
    scenarios,
    activeScenarioId: endpoint.activeScenarioId === scenario.id ? scenarios[0].id : endpoint.activeScenarioId,
  });
  return {
    ...updated,
    presets: updated.presets.map(preset => {
      const selection = preset.selections[endpoint.id];
      if (selection?.scenarioId !== scenario.id) return preset;
      return {
        ...preset,
        selections: { ...preset.selections, [endpoint.id]: { ...selection, scenarioId: scenarios[0].id } },
      };
    }),
  };
}

export function moduleName(module: string) {
  return module || t('未分组', 'Ungrouped');
}

export function timeLabel(time?: string) {
  if (!time) return '—';
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(getLocale(), {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date);
}
