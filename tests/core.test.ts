import { describe, expect, it } from 'vitest';
import { compileRules } from '../src/core/compiler';
import { configurationHash, createInitialData, validateData, validateForApply } from '../src/core/model';
import type { AppData, Endpoint } from '../src/shared/types';

const url = 'https://api.example.test:8443/v1/items.+[a]';
const fixturePath = '/tmp/Whistle Mock #1/fixture.json';
const endpoint: Endpoint = {
  id: 'items', name: 'Items', module: 'catalog', url, method: 'GET', enabled: true,
  activeScenarioId: 'ok', query: [], headers: [],
  scenarios: [{ id: 'ok', name: 'OK', body: '{"items":[]}', status: 200, delay: 0, headers: {} }],
};

function dataWith(overrides: Partial<Endpoint> = {}): AppData {
  return {
    schemaVersion: 1, installationId: 'local', settings: { engineMode: 'builtin' },
    projects: [{ id: 'project', name: 'Catalog', description: '', endpoints: [{ ...structuredClone(endpoint), ...overrides }], presets: [] }],
  };
}

function ruleFor(data: AppData): string[] {
  return compileRules(data, () => fixturePath).split('\n').find((line) => line.startsWith('/'))!.split('#', 1)[0].trim().split(' ');
}

function regexp(token: string): RegExp {
  const match = /^\/(.+)\/([a-z]*)$/.exec(token);
  if (!match) throw new Error('Expected a Whistle regular expression: ' + token);
  return new RegExp(match[1], match[2]);
}

// Whistle includes are OR, and any matching exclude vetoes the rule.
function matches(rule: string[], requestUrl: string, method = 'GET', headers: Record<string, string> = {}): boolean {
  if (!regexp(rule[0]).test(requestUrl)) return false;
  const includes = rule.filter((part) => part.startsWith('includeFilter://'));
  if (includes.length && !includes.some((part) => part.slice('includeFilter://m:'.length) === method)) return false;
  return !rule.filter((part) => part.startsWith('excludeFilter://')).some((part) => {
    const filter = part.slice('excludeFilter://'.length);
    if (filter.startsWith('!/')) return !regexp(filter.slice(1)).test(requestUrl);
    const not = filter.startsWith('reqH:!');
    const [key, pattern] = filter.slice(not ? 'reqH:!'.length : 'reqH:'.length).split('=');
    const value = headers[key];
    const equal = value !== undefined && (!pattern || (value !== '' && regexp(pattern).test(value)));
    return not ? !equal : equal;
  });
}

describe('Whistle compiler', () => {
  it('limits matching to the exact escaped URL and method and ignores an arbitrary query by default', () => {
    const rule = ruleFor(dataWith());
    expect(matches(rule, url)).toBe(true);
    expect(matches(rule, url + '?page=2')).toBe(true);
    expect(matches(rule, url, 'POST')).toBe(false);
    expect(matches(rule, url.replace('https:', 'http:'))).toBe(false);
    expect(matches(rule, url.replace(':8443', ''))).toBe(false);
    expect(matches(rule, url.replace('api.example', 'apiXexample'))).toBe(false);
    expect(matches(rule, url.replace('.+[a]', 'Xa'))).toBe(false);
    expect(matches(rule, url + '/child')).toBe(false);
    expect(matches(rule, url.replace('/items', '/Items'))).toBe(false);
    expect(matches(rule, url.replace('api.example.test', 'API.EXAMPLE.TEST'))).toBe(true);
  });

  it('treats an explicit default port like its implicit form', () => {
    const rule = ruleFor(dataWith({ url: 'https://api.example.test:443/v1/items' }));
    expect(matches(rule, 'https://api.example.test/v1/items')).toBe(true);
    expect(matches(rule, 'https://api.example.test:443/v1/items')).toBe(true);
    expect(matches(rule, 'https://api.example.test:444/v1/items')).toBe(false);
  });

  it('requires every query and request header to equal its literal value', () => {
    const rule = ruleFor(dataWith({
      url: url + '?channel=preview',
      query: [{ key: 'display name', value: 'A+B' }, { key: 'empty', value: '' }],
      headers: [{ key: 'X-Tier', value: 'Premium #2' }, { key: 'X-Empty', value: '' }],
    }));
    const headers = { 'x-tier': 'Premium #2', 'x-empty': '' };
    const qualified = url + '?display%20name=A%2bB&empty&channel=preview&extra=yes';
    expect(matches(rule, qualified, 'GET', headers)).toBe(true);
    expect(matches(rule, qualified.replace('display%20name', 'display+name'), 'GET', headers)).toBe(true);
    expect(matches(rule, qualified.replace('A%2bB', 'AxB'), 'GET', headers)).toBe(false);
    expect(matches(rule, qualified.replace('&empty&', '&other&'), 'GET', headers)).toBe(false);
    expect(matches(rule, qualified.replace('channel=preview', 'notchannel=preview'), 'GET', headers)).toBe(false);
    expect(matches(rule, qualified.replace('channel=preview', 'channel=preview2'), 'GET', headers)).toBe(false);
    expect(matches(rule, qualified, 'POST', headers)).toBe(false);
    expect(matches(rule, qualified, 'GET', { ...headers, 'x-tier': 'premium #2' })).toBe(false);
    expect(matches(rule, qualified, 'GET', { 'x-tier': 'Premium #2' })).toBe(false);
    expect(matches(rule, qualified, 'GET', { ...headers, 'x-empty': 'x' })).toBe(false);
  });

  it('keeps literal values out of rule syntax and safely encodes absolute fixture paths', () => {
    const example = dataWith({ query: [{ key: '#[]', value: '` ${query.invalid}&x' }] });
    const scenario = example.projects[0].endpoints[0].scenarios[0];
    scenario.status = 503;
    scenario.delay = 250;
    scenario.headers = { 'X-Test': '` ${query.invalid} # literal' };
    const text = compileRules(example, () => fixturePath);
    const tokens = ruleFor(example);
    expect(tokens).toContain('file:///tmp/Whistle%20Mock%20%231/fixture.json');
    expect(tokens).toContain('replaceStatus://503');
    expect(tokens).toContain('resDelay://250');
    expect(text).not.toContain('` ${query.invalid}');
    expect(text).not.toContain(' # literal');
    expect(() => compileRules(example, () => '../relative.json')).toThrow(/absolute|绝对/);
  });

  it.each([
    ['C:\\Users\\测试 用户\\100% #1\\fixture.json', 'file://C%3A/Users/%E6%B5%8B%E8%AF%95%20%E7%94%A8%E6%88%B7/100%25%20%231/fixture.json'],
    ['d:/Mock data/percent%20literal.json', 'file://d%3A/Mock%20data/percent%2520literal.json'],
    ['/tmp/测试 用户/100% #1/fixture.json', 'file:///tmp/%E6%B5%8B%E8%AF%95%20%E7%94%A8%E6%88%B7/100%25%20%231/fixture.json'],
  ])('encodes a local absolute fixture path for Whistle: %s', (path, token) => {
    expect(compileRules(dataWith(), () => path).split(/\s+/)).toContain(token);
  });

  it.each([
    '../fixture.json', 'C:fixture.json', '\\fixtures\\response.json',
    '\\\\server\\share\\response.json', '//server/share/response.json',
    '\\\\?\\C:\\fixtures\\response.json', '\\\\.\\C:\\fixtures\\response.json',
    'C:\\fixtures\\NUL.json', 'C:\\fixtures\\response.json:stream',
  ])('rejects relative, network, and device fixture paths: %s', (path) => {
    expect(() => compileRules(dataWith(), () => path)).toThrow();
  });
});

describe('Configuration validation', () => {
  it('keeps an invalid response draft without allowing it to go live', () => {
    const example = dataWith();
    example.projects[0].endpoints[0].scenarios[0].body = '{draft';
    expect(validateData(example)).toEqual(example);
    expect(() => validateForApply(example)).toThrow(/JSON/);
    example.projects[0].endpoints[0].enabled = false;
    expect(() => validateForApply(example)).not.toThrow();
    expect(compileRules(example, () => { throw new Error('Disabled fixtures must not be requested'); })).not.toContain('file://');
  });

  it.each([
    { url: 'https://alice:secret@api.example.test/v1/' },
    { url: 'https://api.example.test/path\nall.example.test proxy://x' },
    { url: 'https://api.example.test/path#hash' },
    { headers: [{ key: 'x-key', value: 'ok\r\nInjected: bad' }] },
    { headers: [{ key: 'x-key bad', value: 'ok' }] },
  ])('refuses to apply an unsafe route input: %o', (overrides) => {
    expect(() => validateForApply(dataWith(overrides))).toThrow();
  });

  it.each([
    { status: 100 }, { status: 600 }, { status: 200.5 },
    { delay: -1 }, { delay: 60001 }, { delay: 10.5 },
    { headers: { 'X-Invalid': 'ok\r\nInjected: bad' } },
  ])('rejects invalid response properties: %o', (overrides) => {
    const example = dataWith();
    Object.assign(example.projects[0].endpoints[0].scenarios[0], overrides);
    expect(() => validateForApply(example)).toThrow();
  });

  it('refuses conflicts across projects when a repeated query key could satisfy both routes', () => {
    const example = dataWith({ query: [{ key: 'view', value: 'preview' }] });
    const other = structuredClone(example.projects[0].endpoints[0]);
    other.id = 'items2';
    other.scenarios[0].id = 'ok2';
    other.activeScenarioId = 'ok2';
    other.query[0].value = 'full';
    example.projects.push({ id: 'project2', name: 'Second project', description: '', endpoints: [other], presets: [] });
    expect(() => validateForApply(example)).toThrow(/overlap|conflict|重叠|冲突/);
    other.method = 'POST';
    expect(() => validateForApply(example)).not.toThrow();
    other.method = 'GET';
    example.projects[0].endpoints[0].headers = [{ key: 'x-channel', value: 'alpha' }];
    other.headers = [{ key: 'X-Channel', value: 'beta' }];
    expect(() => validateForApply(example)).not.toThrow();
  });

  it('keeps configuration hash stable across map insertion order but detects changed response bytes', () => {
    const a = dataWith();
    const b = dataWith();
    a.projects[0].endpoints[0].scenarios[0].headers = { 'X-A': 'a', 'X-B': 'b' };
    b.projects[0].endpoints[0].scenarios[0].headers = { 'X-B': 'b', 'X-A': 'a' };
    expect(configurationHash(a.projects)).toBe(configurationHash(b.projects));
    b.projects[0].endpoints[0].scenarios[0].body = '{}';
    expect(configurationHash(a.projects)).not.toBe(configurationHash(b.projects));
  });

  it('limits first-run sample endpoints to a test domain with no active routes', () => {
    const data = createInitialData();
    const endpoints = data.projects.flatMap(({ endpoints: list }) => list);
    expect(endpoints.length).toBeGreaterThan(0);
    expect(endpoints.every((item) => !item.enabled && new URL(item.url).hostname === 'api.example.test')).toBe(true);
    expect(data.lastApplied).toBeUndefined();
  });
});

describe('persisted engine mode', () => {
  it('creates new profiles with the bundled engine', () => {
    expect(createInitialData().settings).toEqual({ engineMode: 'builtin' });
  });

  it('drops the previous executable path from a legacy profile', () => {
    const legacy = { ...dataWith(), settings: { w2Path: '/custom/w2' } };
    const migrated = validateData(legacy);
    expect(migrated.settings).toEqual({ engineMode: 'builtin' });
    expect(migrated.projects).toEqual(legacy.projects);
  });
});
