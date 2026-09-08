/**
 * OAuth flows: browser (PKCE + CSRF state) + RFC 8628 device flow, token
 * import, refresh. Turns a subscription login (Claude Pro/Max, ChatGPT,
 * Gemini, Copilot, Kimi, Grok) into a working API credential.
 */
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { URL } from "node:url";
import { OAUTH_PROVIDERS, type Credential } from "./providers.ts";

const CALLBACK_TIMEOUT_MS = 300_000;

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function token(): string {
  return b64url(randomBytes(16));
}

async function waitForCode(port: number, expectedState: string): Promise<Record<string, string>> {
  return new Promise((resolveP, rejectP) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const got: Record<string, string> = {};
      u.searchParams.forEach((v, k) => { got[k] = v; });
      let payload = got;
      if (expectedState && got.state !== expectedState)
        payload = { error: "state_mismatch" }; // CSRF guard
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<h2>GoatCode: login complete, you can close this tab.</h2>");
      server.close();
      clearTimeout(timer);
      resolveP(payload);
    });
    const timer = setTimeout(() => {
      server.close();
      rejectP(new Error("no OAuth callback received within 5 minutes"));
    }, CALLBACK_TIMEOUT_MS);
    server.listen(port, "127.0.0.1");
  });
}

async function formPost(url: string, body: Record<string, string>, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...headers },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  if (res.status >= 400) throw new Error(`token exchange failed (${res.status}): ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

function credFromTokens(tokens: any): Credential {
  const expiresIn = Number(tokens.expires_in ?? 28800);
  return {
    kind: "oauth",
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() / 1000 + expiresIn,
  };
}

export interface LoginIO {
  print(s: string): void;
  prompt(s: string): Promise<string>;
  openBrowser?(url: string): void;
}

export async function loginOauth(providerId: string, io: LoginIO, manualPaste = false): Promise<Credential> {
  const meta = OAUTH_PROVIDERS[providerId];
  if (!meta) throw new Error(`no OAuth flow for '${providerId}'`);
  const { verifier, challenge } = pkcePair();
  const state = token();
  const redirect = meta.redirect_uri!;
  const params: Record<string, string> = {
    client_id: meta.client_id!,
    redirect_uri: redirect,
    response_type: "code",
    scope: meta.scope!,
    state,
  };
  if (meta.pkce) {
    params.code_challenge = challenge;
    params.code_challenge_method = "S256";
  }
  const url = `${meta.authorize_url}?${new URLSearchParams(params).toString()}`;
  const port = Number(new URL(redirect).port || 0);

  let code: string;
  if (manualPaste || !port) {
    io.print(`\nOpen this URL in your browser:\n\n  ${url}\n`);
    let pasted = (await io.prompt("Paste the authorization code (or full redirect URL): ")).trim();
    if (pasted.includes("=") && (pasted.includes("?") || pasted.includes("&"))) {
      const qs = new URL(pasted.replace(/^http:\/\/localhost/, "http://localhost")).searchParams;
      pasted = qs.get("code") ?? qs.get("authorization_code") ?? pasted;
    }
    code = pasted;
  } else {
    io.print(`\nOpening browser for ${meta.label}...`);
    try {
      if (io.openBrowser) io.openBrowser(url);
      else {
        const [binary, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
          : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
        Bun.spawn([binary, ...args], { stdout: "ignore", stderr: "ignore" });
      }
    } catch {
      io.print(`If nothing opened, visit:\n  ${url}`);
    }
    const got = await waitForCode(port, state);
    if (got.error) throw new Error(`OAuth error: ${got.error} ${got.error_description ?? ""}`);
    code = got.code ?? got.authorization_code ?? "";
  }

  const body: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
    client_id: meta.client_id!,
  };
  if (meta.pkce) body.code_verifier = verifier;
  const headers: Record<string, string> = {};
  if (providerId === "gemini") body.client_secret = "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";
  const tokens = await formPost(meta.token_url!, body, headers);
  return credFromTokens(tokens);
}

export async function loginDevice(providerId: string, io: LoginIO): Promise<Credential> {
  const meta = OAUTH_PROVIDERS[providerId];
  if (!meta) throw new Error(`no device flow for '${providerId}'`);
  const res = await fetch(meta.device_url!, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ client_id: meta.client_id!, scope: "read:user" }).toString(),
  });
  const dev: any = await res.json();
  const verify = dev.verification_uri ?? dev.verification_url ?? "https://github.com/login/device";
  io.print(`\n  To sign in, visit  ${verify}  and enter code:  ${dev.user_code}\n`);
  const deadline = Date.now() + Number(dev.expires_in ?? 900) * 1000;
  const interval = Number(dev.interval ?? 5) * 1000;
  for (;;) {
    await Bun.sleep(interval);
    const tok: any = await (await fetch(meta.token_url!, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        client_id: meta.client_id!, device_code: dev.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }).toString(),
    })).json();
    if (tok.access_token) {
      if (providerId === "github-copilot") return finishCopilot(tok.access_token);
      return credFromTokens(tok);
    }
    if (tok.error !== "authorization_pending" && tok.error !== "slow_down")
      throw new Error(`device flow failed: ${tok.error} ${tok.error_description ?? ""}`);
    if (Date.now() > deadline) throw new Error("device code expired before authorization");
  }
}

export async function loginImport(providerId: string, io: LoginIO): Promise<Credential> {
  const t = (await io.prompt("Paste access token: ")).trim();
  if (!t) throw new Error("empty token");
  return { kind: "oauth", accessToken: t, expiresAt: 0 };
}

async function finishCopilot(githubToken: string): Promise<Credential> {
  const res = await fetch("https://api.github.com/copilot_internal/v2/token", {
    headers: {
      authorization: `Bearer ${githubToken}`,
      "editor-version": "goatcode/0.1.0", "user-agent": "GoatCode", accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`copilot token exchange failed: HTTP ${res.status}`);
  const data: any = await res.json();
  const expires = Number(data.expires_at ?? Date.now() / 1000 + 28800);
  return { kind: "oauth", accessToken: data.token, refreshToken: githubToken, expiresAt: expires };
}

export async function refresh(providerId: string, cred: Credential): Promise<Credential> {
  const meta = OAUTH_PROVIDERS[providerId];
  if (!meta) throw new Error(`no OAuth flow for '${providerId}'`);
  if (!cred.refreshToken) throw new Error("no refresh token stored — re-login required");
  if (providerId === "github-copilot") return finishCopilot(cred.refreshToken);
  const body: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: cred.refreshToken,
    client_id: meta.client_id!,
  };
  const headers: Record<string, string> = {};
  if (providerId === "claude") headers["anthropic-beta"] = "oauth-2025-04-20";
  if (providerId === "gemini") body.client_secret = "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";
  const tokens = await formPost(meta.token_url!, body, headers);
  const fresh = credFromTokens(tokens);
  if (!fresh.refreshToken) fresh.refreshToken = cred.refreshToken;
  return fresh;
}
