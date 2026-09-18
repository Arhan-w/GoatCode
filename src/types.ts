/**
 * GoatCode Core Types and Interfaces
 * Central type definitions and interfaces
 */

export interface GoatConfig {
  model: string;
  provider: string;
  modelId: string;
  maxTokens: number;
  temperature: number | null;
  autoApprove: boolean;
  repos: string[];
  maxSteps: number;
  endpoints: Record<string, CustomEndpoint>;
  mcpServers: Record<string, McpServerConfig>;
  pluginDirs: string[];
  permissions: PermissionRules;
  hooks: HooksConfig;
  smallModel?: string;
  cachePrompts: boolean;
  contextWindow?: number;
  outputStyle?: string;
  fallbackModels: string[];
  projectMcpNames: Set<string>;
  pluginRegistry?: { url?: string };
  remoteAgents?: { name: string; url: string }[];
  raw?: Record<string, any>;
}

export interface CustomEndpoint {
  id: string;
  baseUrl: string;
  format: "openai" | "claude" | "openai-responses" | "gemini";
  apiKeyEnv?: string;
  apiKey?: string;
  models: string[];
  label: string;
}

export interface McpStdioServer {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpRemoteServer {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioServer | { type: "http" | "sse"; url: string; headers?: Record<string, string> };

export interface PermissionRules {
  allow: string[];
  deny: string[];
}

export type WireFormat = "openai" | "claude" | "openai-responses" | "gemini";

export interface CustomEndpoint {
  id: string;
  baseUrl: string;
  format: "openai" | "claude" | "openai-responses" | "gemini";
  apiKeyEnv?: string;
  apiKey?: string;
  models: string[];
  label: string;
}

export interface McpStdioServer {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpRemoteServer {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioServer | { type: "http" | "sse"; url: string; headers?: Record<string, string> };

export interface PermissionRules {
  allow: string[];
  deny: string[];
}

export type WireFormat = "openai" | "claude" | "openai-responses" | "gemini";

export interface CustomEndpoint {
  id: string;
  baseUrl: string;
  format: "openai" | "claude" | "openai-responses" | "gemini";
  apiKeyEnv?: string;
  apiKey?: string;
  models: string[];
  label: string;
}

export interface McpStdioServer {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpRemoteServer {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioServer | { type: "http" | "sse"; url: string; headers?: Record<string, string> };

export interface PermissionRules {
  allow: string[];
  deny: string[];
}

export type WireFormat = "openai" | "claude" | "openai-responses" | "gemini";

export interface CustomEndpoint {
  id: string;
  baseUrl: string;
  format: "openai" | "claude" | "openai-responses" | "gemini";
  apiKeyEnv?: string;
  apiKey?: string;
  models: string[];
  label: string;
}

export interface McpStdioServer {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpRemoteServer {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioServer | { type: "http" | "sse"; url: string; headers?: Record<string, string> };

export interface PermissionRules {
  allow: string[];
  deny: string[];
}

export type WireFormat = "openai" | "claude" | "openai-responses" | "gemini";

export interface CustomEndpoint {
  id: string;
  baseUrl: string;
  format: "openai" | "claude" | "openai-responses" | "gemini";
  apiKeyEnv?: string;
  apiKey?: string;
  models: string[];
  label: string;
}

export interface McpStdioServer {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpRemoteServer {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioServer | { type: "http" | "sse"; url: string; headers?: Record<string, string> };

export interface PermissionRules {
  allow: string[];
  deny: string[];
}

export type WireFormat = "openai" | "claude" | "openai-responses" | "gemini";

export interface CustomEndpoint {
  id: string;
  baseUrl: string;
  format: "openai" | "claude" | "openai-responses" | "gemini";
  apiKeyEnv?: string;
  apiKey?: string;
  models: string[];
  label: string;
}

export interface McpStdioServer {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpRemoteServer {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioServer | { type: "http" | "sse"; url: string; headers?: Record<string, string> };

export interface PermissionRules {
  allow: string[];
  deny: string[];
}

export type WireFormat = "openai" | "claude" | "openai-responses" | "gemini";

export interface CustomEndpoint {
  id: string;
  baseUrl: string;
  format: "openai" | "claude" | "openai-responses" | "gemini";
  apiKeyEnv?: string;
  apiKey?: string;
  models: string[];
  label: string;
}

export interface McpStdioServer {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpRemoteServer {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioServer | { type: "http" | "sse"; url: string; headers?: Record<string, string> };

export interface PermissionRules {
  allow: string[];
  deny: string[];
}