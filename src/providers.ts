/**
 * Provider catalog: built-in providers (183, from the extracted registry),
 * custom endpoints, and credential resolution (env vars + OAuth tokens).
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appDir, type CustomEndpoint, type WireFormat } from "./config.ts";
import catalogData from "./data/providers.json";

const ENDPOINT_SUFFIXES = [
  "/chat/completions", "/messages", "/responses",
  "/streamGenerateContent", "/generateContent",
];

export function normalizeBaseUrl(url: string): string {
  let u = (url ?? "").replace(/\/+$/, "");
  for (const suffix of ENDPOINT_SUFFIXES) {
    if (u.endsWith(suffix)) {
      u = u.slice(0, -suffix.length).replace(/\/+$/, "");
      break;
    }
  }
  return u;
}

export interface OAuthProviderMeta {
  label: string;
  flow?: "browser" | "device" | "import";
  authorize_url?: string;
  token_url?: string;
  device_url?: string;
  copilot_token_url?: string;
  client_id?: string;
  redirect_uri?: string;
  scope?: string;
  pkce?: boolean;
  api_format: WireFormat | "gemini-oauth";
  base_url: string;
  model_prefix: string;
}

export const OAUTH_PROVIDERS: Record<string, OAuthProviderMeta> = {
  claude: {
    label: "Claude Pro/Max (OAuth)",
    authorize_url: "https://claude.ai/oauth/authorize",
    token_url: "https://api.anthropic.com/v1/oauth/token",
    client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    redirect_uri: "https://console.anthropic.com/oauth/code/callback",
    scope: "org:create_api_key user:profile user:inference",
    pkce: true,
    api_format: "claude",
    base_url: "https://api.anthropic.com/v1",
    model_prefix: "claude",
  },
  codex: {
    label: "ChatGPT Plus/Pro (OAuth)",
    authorize_url: "https://auth.openai.com/oauth/authorize",
    token_url: "https://auth.openai.com/oauth/token",
    client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    redirect_uri: "http://localhost:1455/auth/callback",
    scope: "openid email profile offline_access",
    pkce: true,
    api_format: "openai-responses",
    base_url: "https://chatgpt.com/backend-api/codex",
    model_prefix: "gpt",
  },
  gemini: {
    label: "Gemini Code Assist (OAuth)",
    authorize_url: "https://accounts.google.com/o/oauth2/auth",
    token_url: "https://oauth2.googleapis.com/token",
    client_id: "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com",
    redirect_uri: "http://localhost:8085/oauth2callback",
    scope: "https://www.googleapis.com/auth/cloud-platform",
    pkce: false,
    api_format: "gemini-oauth",
    base_url: "https://cloudcode-pa.googleapis.com/v1internal",
    model_prefix: "gemini",
  },
  "github-copilot": {
    label: "GitHub Copilot (device OAuth)",
    flow: "device",
    device_url: "https://github.com/login/device/code",
    token_url: "https://github.com/login/oauth/access_token",
    copilot_token_url: "https://api.github.com/copilot_internal/v2/token",
    client_id: "Iv1.b507a08c87ecfe98",
    api_format: "openai",
    base_url: "https://api.githubcopilot.com",
    model_prefix: "gpt",
  },
  kimi: {
    label: "Kimi For Coding (device OAuth)",
    flow: "device",
    device_url: "https://auth.kimi.com/api/oauth/device_authorization",
    token_url: "https://auth.kimi.com/api/oauth/token",
    client_id: "17e5f671-d194-4dfb-9706-5516cb48c098",
    api_format: "openai",
    base_url: "https://api.kimi.com/coding/v1",
    model_prefix: "kimi",
  },
  grok: {
    label: "Grok (import token)",
    flow: "import",
    api_format: "openai",
    base_url: "https://cli-chat-proxy.grok.com/v1",
    model_prefix: "grok",
  },
};

/** Env var fallbacks — keys must match catalog provider ids. */
export const ENV_KEY_FALLBACK: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  claude: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  xai: "XAI_API_KEY",
  "grok-cli": "XAI_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  cohere: "COHERE_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  zai: "ZAI_API_KEY",
  moonshot: "MOONSHOT_API_KEY",
  kimi: "MOONSHOT_API_KEY",
  minimax: "MINIMAX_API_KEY",
  "cloudflare-ai": "CLOUDFLARE_API_KEY",
  huggingface: "HF_TOKEN",
};

export interface Provider {
  id: string;
  name: string;
  format: WireFormat;
  baseUrl: string;
  auth: "apikey" | "oauth" | "none";
  envKey?: string;
  models: string[];
  custom: boolean;
}

export interface Credential {
  kind: "api_key" | "oauth";
  apiKey?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt: number; // unix seconds; 0 = never/unknown
}

export function credentialValid(c: Credential): boolean {
  if (c.kind === "oauth")
    return Boolean(c.accessToken) && (c.expiresAt === 0 || Date.now() / 1000 < c.expiresAt - 60);
  return Boolean(c.apiKey);
}

export function loadCatalog(): Map<string, Provider> {
  const providers = new Map<string, Provider>();
  for (const [pid, d] of Object.entries<any>(catalogData)) {
    providers.set(pid, {
      id: pid,
      name: d.name ?? pid,
      format: d.format ?? "openai",
      baseUrl: normalizeBaseUrl(d.base_url ?? ""),
      auth: d.auth ?? "apikey",
      envKey: d.env_key ?? undefined,
      models: Array.isArray(d.models) ? d.models : [],
      custom: false,
    });
  }
  for (const [oid, meta] of Object.entries(OAUTH_PROVIDERS)) {
    const existing = providers.get(oid);
    if (existing) existing.auth = "oauth";
    else
      providers.set(oid, {
        id: oid, name: meta.label,
        format: (meta.api_format === "gemini-oauth" ? "gemini" : meta.api_format) as WireFormat,
        baseUrl: normalizeBaseUrl(meta.base_url), auth: "oauth", models: [], custom: false,
      });
  }
  return providers;
}

export class CredentialStore {
  private path: string;
  private cache: Record<string, any> | null = null;

  constructor(path?: string) {
    this.path = path ?? join(appDir(), "credentials.json");
  }

  private read(): Record<string, any> {
    if (this.cache === null) {
      try {
        this.cache = JSON.parse(readFileSync(this.path, "utf8"));
      } catch {
        this.cache = {};
      }
    }
    return this.cache ?? {};
  }

  get(providerId: string): Credential | null {
    const d = this.read()[providerId];
    if (!d) return null;
    return {
      kind: d.kind ?? "api_key",
      apiKey: d.api_key ?? undefined,
      accessToken: d.access_token ?? undefined,
      refreshToken: d.refresh_token ?? undefined,
      expiresAt: Number(d.expires_at ?? 0),
    };
  }

  put(providerId: string, cred: Credential): void {
    const data = this.read();
    data[providerId] = {
      kind: cred.kind,
      ...(cred.apiKey ? { api_key: cred.apiKey } : {}),
      ...(cred.accessToken ? { access_token: cred.accessToken } : {}),
      ...(cred.refreshToken ? { refresh_token: cred.refreshToken } : {}),
      expires_at: cred.expiresAt,
    };
    mkdirSync(join(this.path, ".."), { recursive: true });
    writeFileSync(this.path, JSON.stringify(data, null, 2), "utf8");
    this.cache = null;
    try { chmodSync(this.path, 0o600); } catch { /* windows */ }
  }

  remove(providerId: string): boolean {
    const data = this.read();
    if (providerId in data) {
      delete data[providerId];
      writeFileSync(this.path, JSON.stringify(data, null, 2), "utf8");
      this.cache = null;
      return true;
    }
    return false;
  }
}

export class ProviderRegistry {
  catalog: Map<string, Provider>;
  custom: Record<string, CustomEndpoint>;
  store: CredentialStore;

  constructor(customEndpoints: Record<string, CustomEndpoint> = {}, store?: CredentialStore) {
    this.catalog = loadCatalog();
    this.custom = { ...customEndpoints };
    this.store = store ?? new CredentialStore();
    for (const [pid, ep] of Object.entries(this.custom)) {
      this.catalog.set(pid, {
        id: pid, name: ep.label || pid, format: ep.format,
        baseUrl: normalizeBaseUrl(ep.baseUrl), auth: "apikey",
        models: ep.models, custom: true,
      });
    }
  }

  get(providerId: string): Provider | undefined {
    return this.catalog.get(providerId);
  }

  listAll(): Provider[] {
    return [...this.catalog.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  resolveCredential(providerId: string): Credential | null {
    // 1. stored credential (oauth or goat-set key)
    const stored = this.store.get(providerId);
    if (stored && credentialValid(stored)) return stored;
    // 2. custom endpoint inline key / env var
    const ep = this.custom[providerId];
    if (ep) {
      if (ep.apiKey) return { kind: "api_key", apiKey: ep.apiKey, expiresAt: 0 };
      if (ep.apiKeyEnv && process.env[ep.apiKeyEnv])
        return { kind: "api_key", apiKey: process.env[ep.apiKeyEnv], expiresAt: 0 };
    }
    // 3. catalog env key, then well-known fallback
    const prov = this.catalog.get(providerId);
    const envNames: string[] = [];
    if (prov?.envKey) envNames.push(prov.envKey);
    if (ENV_KEY_FALLBACK[providerId]) envNames.push(ENV_KEY_FALLBACK[providerId]);
    for (const name of envNames) {
      if (name && process.env[name]) return { kind: "api_key", apiKey: process.env[name], expiresAt: 0 };
    }
    // 4. expired oauth with refresh token — caller refreshes lazily
    if (stored && stored.kind === "oauth" && stored.refreshToken) return stored;
    return null;
  }
}
