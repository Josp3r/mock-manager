import { t } from '../shared/i18n';
import { createHash } from 'node:crypto';
import { activeRoutes, type ActiveRoute } from './model';
import type { AppData, Condition } from '../shared/types';

export { configurationHash } from './model';

export type FixturePath = (endpointId: string, scenarioId: string, body: string) => string;

function literal(value: string): string {
  // Whistle tokenizes on whitespace, strips # comments, and interpolates some
  // constructs. Only a small inert alphabet is emitted directly from input.
  return value.replace(/[^A-Za-z0-9_-]/g, (char) => {
    const code = char.charCodeAt(0);
    return code <= 255
      ? '\\x' + code.toString(16).padStart(2, '0')
      : '\\u' + code.toString(16).padStart(4, '0');
  });
}

function caseInsensitive(value: string): string {
  return [...value].map((char) => (
    /[A-Za-z]/.test(char) ? '[' + char.toLowerCase() + char.toUpperCase() + ']' : literal(char)
  )).join('');
}

function exactUrl(url: URL): string {
  // Whistle may expose a default port in the request authority or omit it.
  const port = url.port ? ':' + url.port : url.protocol === 'https:' ? '(?::443)?' : '(?::80)?';
  return '/^' + caseInsensitive(url.protocol + '//' + url.hostname) + port
    + literal(url.pathname) + '(?:\\?[^\\x23]*)?$/';
}

function encodedByte(byte: number): string {
  return '%' + [...byte.toString(16).padStart(2, '0')].map((char) =>
    /[a-f]/.test(char) ? '[' + char + char.toUpperCase() + ']' : char
  ).join('');
}

function formLiteral(value: string, key: boolean): string {
  return [...Buffer.from(value, 'utf8')].map((byte) => {
    const encoded = encodedByte(byte);
    if (byte === 0x20) return '(?:\\+|%20)';
    if (byte < 0x21 || byte > 0x7e || '%&#+'.includes(String.fromCharCode(byte)) || (key && byte === 0x3d)) {
      return encoded;
    }
    return '(?:' + literal(String.fromCharCode(byte)) + '|' + encoded + ')';
  }).join('');
}

function queryMismatch({ key, value }: Condition): string {
  const matchedKey = formLiteral(key, true);
  const matchedValue = formLiteral(value, false);
  const equality = value ? '=' + matchedValue : '=?';
  return 'excludeFilter://!/^[^?]*\\?(?:[^&\\x23]*&)*' + matchedKey + equality + '(?:&|$)/';
}

function headerMismatches(headers: Map<string, string>): string[] {
  return [...headers].flatMap(([name, value]) => value
    ? ['excludeFilter://reqH:!' + name + '=/^' + literal(value) + '$/']
    // Whistle bypasses regex evaluation for empty headers. Check existence
    // independently and reject nonempty values for an exact empty match.
    : ['excludeFilter://reqH:!' + name, 'excludeFilter://reqH:' + name + '=/[\\s\\S]+/']);
}

function fixtureOperator(path: string): string {
  const drivePath = /^[A-Za-z]:[\\/]/.test(path);
  const localPath = drivePath ? path.replace(/\\/g, '/') : path;
  const parts = localPath.split('/');
  const invalidWindowsPart = drivePath && parts.slice(1).some((part) =>
    /[:<>"|?*\x00-\x1f]/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
  );
  if ((!drivePath && (!path.startsWith('/') || path.startsWith('//') || path.includes('\\'))) ||
      invalidWindowsPart || path.includes('\0') || parts.includes('..')) {
    throw new Error(t("响应文件必须使用本地绝对路径", "Response files must use local absolute paths"));
  }
  // This is Whistle's file operator, not a WHATWG file URL: it strips file://
  // and decodes the remaining path once. A drive must not gain a leading '/'.
  const encoded = parts.map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (char) =>
    '%' + char.charCodeAt(0).toString(16).toUpperCase()
  )).join('/');
  return 'file://' + encoded;
}

function headerBlock(route: ActiveRoute, index: number, installationId: string): { token: string; block: string } {
  const headers = Object.fromEntries(Object.entries(route.scenario.headers).map(([key, value]) => [key.toLowerCase(), value]));
  if (!Object.hasOwn(headers, 'content-type')) headers['content-type'] = 'application/json; charset=utf-8';
  const suffix = createHash('sha256').update(installationId).digest('hex').slice(0, 16);
  const key = `mock-manager-${suffix}-headers-${index}`;
  const json = JSON.stringify(headers).replace(/[#`$\u2028\u2029]/g, (char) =>
    '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')
  );
  return { token: 'resHeaders://{' + key + '}', block: '``` ' + key + '\n' + json + '\n```' };
}

export function compileRules(data: AppData, fixturePath: FixturePath): string {
  const lines = ['# Whistle Mock Manager'];
  const blocks: string[] = [];
  for (const [index, route] of activeRoutes(data).entries()) {
    const { endpoint, scenario, url, headers, query } = route;
    const response = headerBlock(route, index, data.installationId);
    const operators = [
      fixtureOperator(fixturePath(endpoint.id, scenario.id, scenario.body)),
      `replaceStatus://${scenario.status}`,
      response.token,
    ];
    if (scenario.delay) operators.push(`resDelay://${scenario.delay}`);
    lines.push([
      exactUrl(url), ...operators, 'includeFilter://m:' + endpoint.method,
      ...query.map(queryMismatch), ...headerMismatches(headers),
    ].join(' '));
    blocks.push(response.block);
  }
  return [...lines, ...blocks].join('\n') + '\n';
}
