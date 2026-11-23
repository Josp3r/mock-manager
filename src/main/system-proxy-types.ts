export type ProxyConfiguration = Record<string, unknown>;
export interface ProxyProtocolState { enabled: boolean; configuration: ProxyConfiguration }
export interface ProxyService extends ProxyProtocolState { id: string; name: string; active: boolean }
export interface ProxySnapshot { location: string; services: ProxyService[] }
export interface ProxyChange { id: string; expected: ProxyProtocolState; next: ProxyProtocolState }
export interface SystemProxyAdapter {
  readonly supported: boolean;
  /** Missing means legacy macOS, preserving existing adapters and journals. */
  readonly platform?: 'darwin' | 'win32';
  read(): Promise<ProxySnapshot>;
  write(changes: ProxyChange[], expectedLocation?: string): Promise<void>;
}
