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
export const GOATED_FLASH_ID = "goated-flash";
export const GOATED_FLASH_MODEL = GEMINI_FREE_MODEL;

let serverProc: ReturnType<typeof spawn> | null = null;

function startServer(): void {
  if (serverProc) return;
  try {
    serverProc = spawn(process.execPath, [GEMINI_FREE_SERVER, "--port", String(GEMINI_FREE_PORT)], {
      cwd: join(appDir(), "vendor", "gemini-web2api"),
      stdio: ["ignore", "ignore", "ignore"],
      detached: false,
    });
  } catch {
    serverProc = null;
  }
}

function stopServer(): void {
  if (serverProc) { serverProc.kill(); serverProc = null; }
}

export class GoatedFlashFreeClient implements ChatClient {
  private static httpClient: ReturnType<typeof makeClient> | null = null;

  private get httpClient(): ReturnType<typeof makeClient> {
    if (!GoatedFlashFreeClient.httpClient) {
      startServer();
      GoatedFlashFreeClient.httpClient = makeClient("openai", GEMINI_FREE_BASE_URL, {});
    }
    return GoatedFlashFreeClient.httpClient;
  }

  async *streamChat(messages: Message[], tools: ToolSpec[], opts: StreamOpts): AsyncGenerator<StreamEvent> {
    yield* this.httpClient.streamChat(messages, tools, opts);
  }
}
