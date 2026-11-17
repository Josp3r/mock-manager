export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
export interface Condition { key: string; value: string }
export interface Scenario { id: string; name: string; body: string; status: number; delay: number; headers: Record<string, string> }
export interface Endpoint { id: string; name: string; module: string; url: string; method: HttpMethod; enabled: boolean; activeScenarioId: string; query: Condition[]; headers: Condition[]; scenarios: Scenario[] }
export interface PresetSelection { enabled: boolean; scenarioId: string }
export interface Preset { id: string; name: string; selections: Record<string, PresetSelection> }
export interface Project { id: string; name: string; description: string; endpoints: Endpoint[]; presets: Preset[] }
export interface AppliedSnapshot { hash: string; at: string; ruleName: string; rules: string; projects: Project[] }
export interface AppData { schemaVersion: 1; installationId: string; projects: Project[]; settings: { engineMode: 'builtin' }; lastApplied?: AppliedSnapshot }
export interface ConnectionStatus {
  installed: boolean; running: boolean; engineMode: 'builtin'; version?: string; port?: number;
  host?: string; address?: string;
  httpsEnabled?: boolean; multiSelect?: boolean; rulesDisabled?: boolean;
  managedSelected?: boolean; ruleName?: string; error?: string; lastAppliedAt?: string;
  syncState: 'pending' | 'synced' | 'disabled' | 'conflict' | 'offline';
  canRecover?: boolean;
}
export interface ApplyResult { data: AppData; status: ConnectionStatus }
export interface SystemProxyStatus {
  supported: boolean;
  state: 'off' | 'on' | 'changed' | 'external' | 'error';
  managed: boolean;
  address?: string;
  services: string[];
  message?: string;
}
export interface DesktopBridge {
  load(): Promise<AppData>;
  save(data: AppData): Promise<AppData>;
  status(): Promise<ConnectionStatus>;
  apply(): Promise<ApplyResult>;
  disable(): Promise<ConnectionStatus>;
  restore(): Promise<ApplyResult>;
  startWhistle(): Promise<ConnectionStatus>;
  enableMultiSelect(): Promise<ConnectionStatus>;
  enableRules(): Promise<ConnectionStatus>;
  testConnection(): Promise<{ ok: boolean; message: string }>;
  exportCertificate(): Promise<boolean>;
  onPrepareQuit(callback: () => Promise<void>): () => void;
  importBackup(): Promise<AppData | null>;
  exportBackup(): Promise<boolean>;
  importResponse(): Promise<string | null>;
  openWhistle(): Promise<void>;
  openDataFolder(): Promise<void>;
  systemProxyStatus(): Promise<SystemProxyStatus>;
  setSystemProxy(enabled: boolean): Promise<SystemProxyStatus>;
  releaseSystemProxy(): Promise<SystemProxyStatus>;
}
declare global { interface Window { mockManager: DesktopBridge } }
