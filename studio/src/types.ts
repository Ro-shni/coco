export type Mode = 'auto' | 'confirm' | 'off';
export type ServerState = 'disconnected' | 'connecting' | 'connected' | 'needs_auth' | 'error' | 'disabled';
export interface ServerConfig { id: string; name: string; transport: 'stdio' | 'http'; command?: string; args: string[]; url?: string; envSecrets: string[]; headerSecrets: string[]; auth: 'none' | 'oauth'; enabled: boolean; source: string; readOnly: boolean }
export interface ServerStatus { id: string; state: ServerState; error?: string; toolCount: number; since: number }
export interface ToolView { qualified: string; name: string; description: string; mode: Mode; reason: string }
export interface ConnectorView { config: ServerConfig; status?: ServerStatus; tools: ToolView[] }
export interface Discovered { key: string; name: string; transport: 'stdio' | 'http'; command?: string; args: string[]; url?: string; envNames: string[]; headerNames: string[]; foundIn: string[]; status: 'importable' | 'blocked_host' | 'unsupported_variable' | 'unsupported_transport' | 'already_imported'; readOnly: boolean }
export interface CatalogItem { id: string; name: string; description: string; transport: 'stdio' | 'http'; url?: string; command?: string; args?: string[]; auth: string; headerNames?: string[]; envNames?: string[]; needsClientId?: boolean; argsHint?: string; setupNotes: string; docsUrl: string; added: boolean }
export interface AuditRow { id: number; ts: number; serverId: string; tool: string; decision: string; ok: boolean | null; ms: number | null; resultChars: number | null }
export interface Health { brain: string; ollama: boolean; models: { main: string; vision: string }; connectors: { total: number; connected: number; error: number } }
