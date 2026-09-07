"""OAuth flows: browser (PKCE) + GitHub device flow, token refresh.

Turns a subscription login (Claude Pro/Max, ChatGPT, Gemini, Copilot, Kimi,
Grok) into a working API credential — the OmniRoute idea, embedded.
"""
from __future__ import annotations

import base64
import hashlib
import http.server

import secrets
import threading
import time
import urllib.parse
import webbrowser
from typing import Any

import httpx

from .providers import Credential, OAUTH_PROVIDERS

CALLBACK_TIMEOUT = 300


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def pkce_pair() -> tuple[str, str]:
    verifier = _b64url(secrets.token_bytes(32))
    challenge = _b64url(hashlib.sha256(verifier.encode()).digest())
    return verifier, challenge


class _CallbackHandler(http.server.BaseHTTPRequestHandler):
    result: dict[str, str] = {}
    expected_state: str = ""

    def do_GET(self) -> None:  # noqa: N802
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        got = {k: v[0] for k, v in qs.items()}
        if self.expected_state and got.get("state") != self.expected_state:
            got = {"error": "state_mismatch"}  # CSRF guard: reject foreign callbacks
        type(self).result = got
        self.send_response(200)
        self.send_header("content-type", "text/html")
        self.end_headers()
        self.wfile.write(b"<h2>GoatCode: login complete, you can close this tab.</h2>")

    def log_message(self, *args: Any) -> None:  # silence
        pass


def _wait_for_code(port: int, expected_state: str = "") -> dict[str, str]:
    _CallbackHandler.result = {}
    _CallbackHandler.expected_state = expected_state
    server = http.server.HTTPServer(("127.0.0.1", port), _CallbackHandler)
    server.timeout = CALLBACK_TIMEOUT
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    deadline = time.time() + CALLBACK_TIMEOUT
    try:
        while time.time() < deadline and not _CallbackHandler.result:
            time.sleep(0.2)
    finally:
        server.shutdown()
        server.server_close()
    if not _CallbackHandler.result:
        raise TimeoutError("no OAuth callback received within 5 minutes")
    got = _CallbackHandler.result
    # CSRF: the callback must carry the state we sent, otherwise some other
    # local process (or a stale tab) is feeding us a code.
    if "state" in got and got["state"] != expected_state:
        raise RuntimeError("OAuth state mismatch (possible CSRF) — retry login")
    return got


def login_oauth(provider_id: str, *, manual_paste: bool = False) -> Credential:
    """Run a browser OAuth login. Returns a fresh OAuth credential."""
    meta = OAUTH_PROVIDERS[provider_id]
    verifier, challenge = pkce_pair()
    state = secrets.token_urlsafe(16)
    redirect = meta["redirect_uri"]
    params: dict[str, str] = {
        "client_id": meta["client_id"],
        "redirect_uri": redirect,
        "response_type": "code",
        "scope": meta["scope"],
        "state": state,
    }
    if meta.get("pkce"):
        params.update({"code_challenge": challenge, "code_challenge_method": "S256"})
    url = f"{meta['authorize_url']}?{urllib.parse.urlencode(params)}"

    port = int(urllib.parse.urlparse(redirect).port or 0)
    if manual_paste or not port:
        print(f"\nOpen this URL in your browser:\n\n  {url}\n")
        code = input("Paste the authorization code (or full redirect URL) here: ").strip()
        if "=" in code and ("?" in code or "&" in code):
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(code.replace("http://localhost", "http://localhost")).query or code.split("?", 1)[-1])
            code = (qs.get("code") or qs.get("authorization_code") or [code])[0]
    else:
        print(f"\nOpening browser for {meta['label']}...")
        try:
            webbrowser.open(url)
        except Exception:  # noqa: BLE001
            print(f"If nothing opened, visit:\n  {url}")
        got = _wait_for_code(port, expected_state=state)
        if "error" in got:
            raise RuntimeError(f"OAuth error: {got.get('error')} {got.get('error_description', '')}")
        code = got.get("code") or got.get("authorization_code", "")

    token_body: dict[str, str] = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect,
        "client_id": meta["client_id"],
    }
    if meta.get("pkce"):
        token_body["code_verifier"] = verifier
    headers = {"content-type": "application/x-www-form-urlencoded", "accept": "application/json"}
    if provider_id == "gemini":
        token_body["client_secret"] = "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"
    resp = httpx.post(meta["token_url"], data=token_body, headers=headers, timeout=30)
    if resp.status_code >= 400:
        raise RuntimeError(f"token exchange failed ({resp.status_code}): {resp.text[:400]}")
    tokens = resp.json()
    return _cred_from_tokens(tokens)


def login_device(provider_id: str = "github-copilot") -> Credential:
    """RFC 8628 device flow: show a code, user authorizes in their browser."""
    meta = OAUTH_PROVIDERS[provider_id]
    resp = httpx.post(meta["device_url"],
                      data={"client_id": meta["client_id"], "scope": "read:user"},
                      headers={"accept": "application/json"}, timeout=30)
    resp.raise_for_status()
    dev = resp.json()
    verify = dev.get("verification_uri") or dev.get("verification_url") or "https://github.com/login/device"
    print(f"\n  To sign in, visit  {verify}  and enter code:  {dev['user_code']}\n")
    deadline = time.time() + int(dev.get("expires_in", 900))
    interval = int(dev.get("interval", 5))
    while time.time() < deadline:
        time.sleep(interval)
        tok = httpx.post(meta["token_url"], data={
            "client_id": meta["client_id"], "device_code": dev["device_code"],
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
        }, headers={"accept": "application/json"}, timeout=30).json()
        if tok.get("access_token"):
            if provider_id == "github-copilot":
                return _finish_copilot(tok["access_token"])
            return _cred_from_tokens(tok)
        if tok.get("error") not in ("authorization_pending", "slow_down"):
            raise RuntimeError(f"device flow failed: {tok.get('error')} {tok.get('error_description', '')}")
    raise TimeoutError("device code expired before authorization")


def login_import(provider_id: str) -> Credential:
    """Import a bearer token captured from a web/CLI session (Grok)."""
    token = input("Paste access token: ").strip()
    if not token:
        raise RuntimeError("empty token")
    return Credential(kind="oauth", access_token=token, expires_at=0.0)


def _finish_copilot(github_token: str) -> Credential:
    """Exchange the GitHub token for a Copilot API token (the OmniRoute trick)."""
    resp = httpx.post(
        "https://api.github.com/copilot_internal/v2/token",
        headers={"authorization": f"Bearer {github_token}",
                 "editor-version": "goatcode/0.1.0", "user-agent": "GoatCode",
                 "accept": "application/json"},
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    expires = float(data.get("expires_at") or (time.time() + 28800))
    return Credential(kind="oauth", access_token=data["token"],
                      refresh_token=github_token, expires_at=expires)


def _cred_from_tokens(tokens: dict[str, Any]) -> Credential:
    expires_in = float(tokens.get("expires_in") or 28800)
    return Credential(
        kind="oauth",
        access_token=tokens.get("access_token"),
        refresh_token=tokens.get("refresh_token"),
        expires_at=time.time() + expires_in,
    )


def refresh(provider_id: str, cred: Credential) -> Credential:
    """Refresh an OAuth credential; raises RuntimeError when unrecoverable."""
    meta = OAUTH_PROVIDERS[provider_id]
    if not cred.refresh_token:
        raise RuntimeError("no refresh token stored — re-login required")
    if provider_id == "github-copilot":
        return _finish_copilot(cred.refresh_token)
    body = {
        "grant_type": "refresh_token",
        "refresh_token": cred.refresh_token,
        "client_id": meta["client_id"],
    }
    headers = {"content-type": "application/x-www-form-urlencoded", "accept": "application/json"}
    if provider_id == "claude":
        headers["anthropic-beta"] = "oauth-2025-04-20"
    if provider_id == "gemini":
        body["client_secret"] = "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"
    resp = httpx.post(meta["token_url"], data=body, headers=headers, timeout=30)
    if resp.status_code >= 400:
        raise RuntimeError(f"refresh failed ({resp.status_code}): {resp.text[:300]}")
    tokens = resp.json()
    new = _cred_from_tokens(tokens)
    if not new.refresh_token:
        new.refresh_token = cred.refresh_token
    return new
