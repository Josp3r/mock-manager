export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
export interface Condition { key: string; value: string }
export interface Scenario { id: string; name: string; body: string; status: number; delay: number; headers: Record<string, string> }
export interface Endpoint { id: string; name: string; module: string; url: string; method: HttpMethod; enabled: boolean; activeScenarioId: string; query: Condition[]; headers: Condition[]; scenarios: Scenario[] }
export interface PresetSelection { enabled: boolean; scenarioId: string }
export interface Preset { id: string; name: string; selections: Record<string, PresetSelection> }
export interface Project { id: string; name: string; description: string; endpoints: Endpoint[]; presets: Preset[] }
export interface AppliedSnapshot { hash: string; at: string; ruleName: string; rules: string; projects: Project[] }
export interface AppData { schemaVersion: 1; installationId: string; projects: Project[]; settings: { w2Path: string }; lastApplied?: AppliedSnapshot }
export interface ConnectionStatus {
  installed: boolean; running: boolean; w2Path: string; version?: string; port?: number;
  httpsEnabled?: boolean; multiSelect?: boolean; rulesDisabled?: boolean;
  managedSelected?: boolean; ruleName?: string; error?: string; lastAppliedAt?: string;
  syncState: 'pending' | 'synced' | 'disabled' | 'conflict' | 'offline';
  canRecover?: boolean;
}
export interface ApplyResult { data: AppData; status: ConnectionStatus }
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
  chooseW2(): Promise<string | null>;
  importBackup(): Promise<AppData | null>;
  exportBackup(): Promise<boolean>;
  importResponse(): Promise<string | null>;
  openWhistle(): Promise<void>;
  openDataFolder(): Promise<void>;
}
declare global { interface Window { mockManager: DesktopBridge } }
