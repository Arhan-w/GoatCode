/**
 * Runtime glue: resolve provider+credential into a live chat client.
 * Handles lazy OAuth refresh and the special headers subscription-backed
 * endpoints (Copilot, Codex) expect.
 */
import { splitModel, type GoatConfig } from "./config.ts";
import { makeClient, type ChatClient } from "./llm.ts";
import { refresh } from "./oauth.ts";
import {
  normalizeBaseUrl, OAUTH_PROVIDERS, type Credential,
  type Provider, type ProviderRegistry,
} from "./providers.ts";
import { credentialValid } from "./providers.ts";

export class ResolveError extends Error {}
export class AuthRequired extends ResolveError {
  constructor(public providerId: string) {
    super(
      `provider '${providerId}' needs credentials.\n` +
      `  API key:  set the env var or run:  goat auth ${providerId} --key <KEY>\n` +
      `  OAuth:    goat auth ${providerId} --oauth   (if listed by: goat auth --list-oauth)`,
    );
  }
}
export class UnknownProvider extends ResolveError {
  constructor(public providerId: string) {
    super(`unknown provider '${providerId}' — see: goat providers`);
  }
}

export interface Resolved {
  provider: Provider;
  credential: Credential;
  client: ChatClient;
}

async function refreshIfNeeded(
  registry: ProviderRegistry, providerId: string, cred: Credential,
): Promise<Credential> {
  if (cred.kind !== "oauth" || credentialValid(cred)) return cred;
  let fresh: Credential;
  try {
    fresh = await refresh(providerId, cred);
  } catch {
    throw new AuthRequired(providerId);
  }
  registry.store.put(providerId, fresh);
  return fresh;
}

function headersFor(providerId: string): Record<string, string> | undefined {
  if (providerId === "github-copilot")
    return { "editor-version": "vscode/1.99.0", "user-agent": "GoatCode", "copilot-integration-id": "vscode-chat" };
  if (providerId === "codex") return { originator: "goatcode", accept: "text/event-stream" };
  return undefined;
}

export async function resolve(cfg: GoatConfig, registry: ProviderRegistry): Promise<Resolved> {
  const provider = registry.get(cfg.provider);
  if (!provider) throw new UnknownProvider(cfg.provider);
  let cred = registry.resolveCredential(provider.id);
  if (!cred) throw new AuthRequired(provider.id);
  cred = await refreshIfNeeded(registry, provider.id, cred);

  let fmt: string = provider.format;
  let base = provider.baseUrl;
  // OAuth credential -> the subscription endpoint from OAUTH_PROVIDERS
  if (cred.kind === "oauth" && provider.id in OAUTH_PROVIDERS) {
    const meta = OAUTH_PROVIDERS[provider.id];
    fmt = meta.api_format;
    base = normalizeBaseUrl(meta.base_url);
  }
  const client = buildClient(fmt, base, cred, provider.id);
  return { provider, credential: cred, client };
}

function buildClient(fmt: string, base: string, cred: Credential, providerId: string): ChatClient {
  let apiKey = cred.apiKey;
  let authToken = cred.kind === "oauth" ? cred.accessToken : undefined;
  // OpenAI-compatible endpoints with OAuth send the bearer via the api_key slot
  if (fmt === "openai" && authToken && !apiKey) {
    apiKey = authToken;
    authToken = undefined;
  }
  return makeClient(fmt, base, {
    apiKey, authToken, extraHeaders: headersFor(providerId),
  });
}

/**
 * Resolve the configured small/cheap model for background work (compaction,
 * explore subagents). Returns null when unset or unresolvable — callers fall
 * back to the main client, so a bad small_model never breaks the session.
 */
export async function resolveSmall(cfg: GoatConfig, registry: ProviderRegistry): Promise<ChatClient | null> {
  if (!cfg.smallModel || cfg.smallModel === cfg.model) return null;
  try {
    const small = { ...cfg, model: cfg.smallModel };
    splitModel(small);
    const r = await resolve(small, registry);
    return r.client;
  } catch {
    return null;
  }
}
