export type RiskLevel = 'read' | 'write' | 'dangerous';

export interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: any[];
  minimum?: number;
  maximum?: number;
  default?: any;
  /** Internal only: override the 4000-char sanitizer cap. Stripped before API. */
  maxLength?: number;
}

export interface ToolContext {
  uid: number;
  uname: string;
  domainId: string;
  scopeId: string;
  sessionId: string;
  sudo: boolean;
  db: any;
  user: any;
}

export type ResultKind = 'table' | 'text' | 'stats' | 'code';

export interface ToolPayload {
  summary: string;
  data?: any;
  columns?: string[];
  kind?: ResultKind;
}

export interface ToolResult {
  ok: boolean;
  summary: string;
  artifactId?: string;
  truncated?: boolean;
  error?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  risk: RiskLevel;
  parameters: JsonSchema;
  requireSudo?: boolean;
  execute: (ctx: ToolContext, args: any) => Promise<ToolPayload>;
}

export interface AiSettings {
  _id?: string;
  enabled: boolean;
  apiBase: string;
  model: string;
  validationAlias: string;
  validationTarget: string;
  timeoutMs: number;
  maxRetries: number;
  maxContextMessages: number;
  /** Max output tokens per request; large tool-call payloads need >= 4096. */
  maxTokens?: number;
  searchProvider?: string;
  searchApiBase?: string;
  updatedAt?: Date;
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  tool_call_id?: string;
  name?: string;
}

export interface ChatSessionDoc {
  _id?: any;
  uid: number;
  domainId: string;
  scopeId: string;
  messages: ChatMessage[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ArtifactDoc {
  _id?: any;
  uid: number;
  domainId: string;
  kind: string;
  data: any;
  columns?: string[];
  createdAt: Date;
  expiresAt: Date;
}

export interface AuditDoc {
  _id?: any;
  uid: number;
  uname: string;
  domainId: string;
  action: string;
  detail: any;
  createdAt: Date;
}

export interface OrgUnit {
  kind: 'course' | 'stage' | 'class' | 'domain';
  id: string;
  name: string;
  parentId?: string;
}
