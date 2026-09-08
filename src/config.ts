/**
 * GoatCode configuration — layered:
 *   defaults < ~/.goatcode/config.json < ./goatcode.json < env vars.
 * Also carries MCP server config (config.json `mcpServers` + project `.mcp.json`).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const APP_DIR_NAME = ".goatcode";
export const PROJECT_CONFIG_NAME = "goatcode.json";
export const MCP_FILE_NAME = ".mcp.json";

export type WireFormat = "openai" | "claude" | "openai-responses" | "gemini";

export interface CustomEndpoint {
  id: string;
  baseUrl: string;
  format: WireFormat;
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
export type McpServerConfig = McpStdioServer | McpRemoteServer;

export interface GoatConfig {
  model: string;
  provider: string; // derived from model
  modelId: string;  // derived from model
  maxTokens: number;
  temperature: number | null;
  autoApprove: boolean;
  maxSteps: number;
  endpoints: Record<string, CustomEndpoint>;
  mcpServers: Record<string, McpServerConfig>;
  pluginDirs: string[];
  /** Server names that came from the project .mcp.json — never persisted to user config. */
  projectMcpNames: Set<string>;
}

export function appDir(): string {
  const base = process.env.GOATCODE_HOME || join(homedir(), APP_DIR_NAME);
  mkdirSync(base, { recursive: true });
  return base;
}

export function configPath(): string {
  return join(appDir(), "config.json");
}

function parseJson(path: string): Record<string, any> {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

export function splitModel(cfg: GoatConfig): void {
  const i = cfg.model.indexOf("/");
  if (i > 0) {
    cfg.provider = cfg.model.slice(0, i);
    cfg.modelId = cfg.model.slice(i + 1);
  } else {
    cfg.provider = "openai";
    cfg.modelId = cfg.model;
  }
}

function endpointFrom(id: string, d: any): CustomEndpoint {
  return {
    id,
    baseUrl: String(d.base_url ?? d.baseUrl ?? "").replace(/\/+$/, ""),
    format: d.format ?? "openai",
    apiKeyEnv: d.api_key_env ?? d.apiKeyEnv ?? undefined,
    apiKey: d.api_key ?? d.apiKey ?? undefined,
    models: Array.isArray(d.models) ? d.models : [],
    label: d.label ?? id,
  };
}

export function loadConfig(projectDir: string = process.cwd()): GoatConfig {
  const data: Record<string, any> = { ...parseJson(configPath()) };
  Object.assign(data, parseJson(join(projectDir, PROJECT_CONFIG_NAME)));

  const cfg: GoatConfig = {
    model: String(data.model ?? "anthropic/claude-sonnet-4-5"),
    provider: "",
    modelId: "",
    maxTokens: Number(data.max_tokens ?? data.maxTokens ?? 8192),
    temperature: data.temperature ?? null,
    autoApprove: Boolean(data.auto_approve ?? data.autoApprove ?? false),
    maxSteps: Number(data.max_steps ?? data.maxSteps ?? 40),
    endpoints: {},
    mcpServers: { ...(data.mcpServers ?? {}) },
    pluginDirs: Array.isArray(data.plugins) ? data.plugins : [],
    projectMcpNames: new Set(),
  };
  for (const [pid, ed] of Object.entries<any>(data.endpoints ?? {})) {
    if (ed && typeof ed === "object") cfg.endpoints[pid] = endpointFrom(pid, ed);
  }

  // Project .mcp.json (Claude Code compatible shape: { mcpServers: {...} })
  const mcpJson = parseJson(join(projectDir, MCP_FILE_NAME));
  if (mcpJson.mcpServers) {
    for (const [name, sc] of Object.entries<any>(mcpJson.mcpServers)) {
      if (sc && typeof sc === "object") {
        cfg.mcpServers[name] = sc as McpServerConfig;
        cfg.projectMcpNames.add(name); // tracked so saveConfig never persists it
      }
    }
  }

  // env overrides win
  if (process.env.GOAT_MODEL) cfg.model = process.env.GOAT_MODEL;
  if (process.env.GOAT_AUTO_APPROVE)
    cfg.autoApprove = ["1", "true", "yes"].includes(process.env.GOAT_AUTO_APPROVE.toLowerCase());
  if (process.env.GOAT_MAX_TOKENS) {
    const n = parseInt(process.env.GOAT_MAX_TOKENS, 10);
    if (!Number.isNaN(n)) cfg.maxTokens = n;
  }
  if (process.env.GOAT_TEMPERATURE) {
    const n = parseFloat(process.env.GOAT_TEMPERATURE);
    if (!Number.isNaN(n)) cfg.temperature = n;
  }
  if (process.env.GOAT_MAX_STEPS) {
    const n = parseInt(process.env.GOAT_MAX_STEPS, 10);
    if (!Number.isNaN(n)) cfg.maxSteps = n;
  }
  splitModel(cfg);
  return cfg;
}

/**
 * Persist user-level config. Merges into the existing file so hand-edited or
 * future keys survive the round-trip; project .mcp.json servers are excluded.
 */
export function saveConfig(cfg: GoatConfig): void {
  const prev = parseJson(configPath());
  const userMcp: Record<string, McpServerConfig> = {};
  for (const [name, sc] of Object.entries(cfg.mcpServers))
    if (!cfg.projectMcpNames?.has(name)) userMcp[name] = sc;
  const payload: Record<string, unknown> = {
    ...prev,
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    max_steps: cfg.maxSteps,
    auto_approve: cfg.autoApprove,
    endpoints: Object.fromEntries(
      Object.entries(cfg.endpoints).map(([pid, ep]) => [
        pid,
        {
          base_url: ep.baseUrl,
          format: ep.format,
          ...(ep.apiKeyEnv ? { api_key_env: ep.apiKeyEnv } : {}),
          ...(ep.apiKey ? { api_key: ep.apiKey } : {}),
          ...(ep.models.length ? { models: ep.models } : {}),
        },
      ]),
    ),
    mcpServers: userMcp,
  };
  if (cfg.temperature != null) payload.temperature = cfg.temperature;
  writeFileSync(configPath(), JSON.stringify(payload, null, 2), "utf8");
}

export function fileExists(p: string): boolean {
  return existsSync(p);
}
