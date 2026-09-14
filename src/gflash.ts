import { spawn } from "node:child_process";
import { join } from "node:path";
import { appDir } from "./config.ts";
import { makeClient } from "./llm.ts";
import type { ChatClient, StreamEvent, StreamOpts, ToolSpec, Message } from "./llm.ts";

export const GEMINI_FREE_MODEL = "gemini-3.5-flash";
export const GEMINI_FREE_BASE_URL = "http://127.0.0.1:8081/v1";
export const GEMINI_FREE_LABEL = "Goated-Flash-Free";
export const GEMINI_FREE_PORT = 8081;
export const GEMINI_FREE_SERVER = join(appDir(), "vendor", "gemini-web2api", "gemini_web2api.py");

let serverProc: ReturnType<typeof spawn> | null = null;
let serverReady = false;

function startServer(): void {
  if (serverProc) return;
  try {
    serverProc = spawn(process.execPath === "bun" ? "python" : process.execPath, [GEMINI_FREE_SERVER, "--port", String(GEMINI_FREE_PORT)], {
      cwd: join(appDir(), "vendor", "gemini-web2api"),
      stdio: ["ignore", "ignore", "ignore"],
      detached: false,
    });
    // wait for the port to come up
    for (let i = 0; i < 30; i++) {
      if (serverReady) break;
      // poll by spawning a quick request
      try {
        const http = require("http");
        http.get(`http://127.0.0.1:${GEMINI_FREE_PORT}/v1/models`, () => { serverReady = true; }).catch(() => {});
      } catch { /* not ready yet */ }
    }
  } catch {
    serverProc = null;
  }
}

function stopServer(): void {
  if (serverProc) { serverProc.kill(); serverProc = null; serverReady = false; }
}

/**
 * Lazy HTTP client for the Goated-Flash-Free endpoint.
 * The server is started on first use.
 */
export class GoatedFlashFreeClient implements ChatClient {
  private static client: ReturnType<typeof makeClient> | null = null;

  private get httpClient(): ReturnType<typeof makeClient> {
    if (!GoatedFlashFreeClient.client) {
      startServer();
      GoatedFlashFreeClient.client = makeClient("openai", GEMINI_FREE_BASE_URL, {});
    }
    return GoatedFlashFreeClient.client;
  }

  async *streamChat(messages: Message[], tools: ToolSpec[], opts: StreamOpts): AsyncGenerator<StreamEvent> {
    yield* this.httpClient.streamChat(messages, tools, opts);
  }
}
