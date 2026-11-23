import { t } from '../shared/i18n';
export interface RuleValue { value: string; selected: boolean }
export interface WhistleApi {
  network: { getStatus(): Promise<{version: string; port?: number}> };
  isEnabledHTTPS(): Promise<boolean>;
  rules: {
    getStatus(): Promise<{multiSelect: boolean; disabled: boolean; list: {name: string; selected: boolean}[]}>;
    get(name: string): Promise<RuleValue | string | null>;
    add(name: string, value: string, selected?: boolean): Promise<void>;
    select(name: string): Promise<boolean>;
    unselect(name: string): Promise<boolean>;
    setMultiSelect(enabled: boolean): Promise<void>;
    turnOn(): Promise<void>;
  };
}
export interface WhistleAccess {
  find(configured: string): Promise<string>;
  resolve(configured: string): Promise<{path: string; api: WhistleApi}>;
  start(path: string): Promise<void>;
  endpoint?(configured: string): Promise<{host?: string; port: number}>;
}
export const WHISTLE_LOOPBACK = '127.0.0.1';

export function whistleAddress(host: string, port: number): string {
  const ipv6 = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const authority = ipv6.includes(':') && /^[a-f\d:.]+$/i.test(ipv6) ? `[${ipv6}]`
    : /^[a-z\d._-]+$/i.test(host) ? host : '';
  const hostname = authority && URL.parse(`http://${authority}/`)?.hostname;
  if (!hostname) throw new Error(t("无法确认 Whistle 的实际代理地址。", "The actual proxy address could not be determined."));
  const dialHost = hostname === '[::]' ? '[::1]' : hostname === '0.0.0.0' ? WHISTLE_LOOPBACK : hostname;
  return `${dialHost}:${port}`;
}

export function compatibleVersion(version: string): boolean {
  const [major, minor, patch] = version.split('.').map(Number);
  return major > 2 || (major === 2 && (minor > 10 || (minor === 10 && patch >= 7)));
}
export function ruleValue(value: RuleValue | string | null): RuleValue | null {
  if (typeof value === 'string') return {value, selected: false};
  return value;
}
