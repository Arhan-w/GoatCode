/**
 * MCP client — stdio + HTTP/SSE transport.
 * Uses @modelcontextprotocol/sdk for the wire protocol.
 *
 * Each MCP server becomes a namespaced set of tools:
 *   mcp__<server>__<tool>
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { McpServerConfigSchema } from "./types.ts";
import type { ToolSpec } from "../llm.ts";
import type { ToolResult } from "../tools.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

export interface McpServerEntry {
  name: string;
  config: McpServerConfig;
  client: Client;
  transport: any;
  tools: Map<string, { spec: ToolSpec; run: (args: Record<string, unknown>) => Promise<ToolResult> }>;
}

export class McpClient {
  servers = new Map<string, McpServerEntry>();
  private _loaded = false;

  async load(cfg: { mcpServers: Record<string, any> }): Promise<McpServerEntry[]> {
    const entries: McpServerEntry[] = [];
    for (const [name, raw] of Object.entries(cfg.mcpServers ?? {})) {
      const parsed = McpServerConfigSchema.safeParse(raw);
      if (!parsed.success) {
        console.warn(`goat: MCP server '${name}' config invalid, skipping`);
        continue;
      }
      const entry = await this.add(name, parsed.data);
      if (entry) entries.push(entry);
    }
    this._loaded = true;
    return entries;
  }

  async add(name: string, config: McpServerConfig): Promise<McpServerEntry | null> {
    let transport: any;
    if (config.type === "stdio" || !config.type) {
      const stdio = config as import("./types.ts").McpStdioServer;
      transport = new StdioClientTransport({
        command: stdio.command, args: stdio.args ?? [],
        env: { ...process.env, ...stdio.env } as Record<string, string>,
      });
    } else if (config.type === "sse") {
      transport = new SSEClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
    } else {
      transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
    }

    const client = new Client({ name: `goatcode-${name}`, version: "0.1.0" });
    try {
      await client.connect(transport);
    } catch (e: any) {
      console.warn(`goat: MCP server '${name}' connection failed: ${e?.message}`);
      return null;
    }
    const tools = new Map();
    const list = await client.listTools();
    for (const t of list.tools) {
      const spec: ToolSpec = {
        name: `mcp__${name}__${t.name}`,
        description: t.description ?? `${name}.${t.name}`,
        parameters: (t.inputSchema as any) ?? { type: "object", properties: {} },
      };
      tools.set(t.name, { spec, run: async (args: Record<string, unknown>) => {
        const result = await client.callTool({ name: t.name, arguments: args });
        const text = typeof result.content === "string" ? result.content
          : JSON.stringify(result.content ?? result);
        return { ok: true, output: text.slice(0, 2000) };
      } });
    }
    const entry: McpServerEntry = { name, config, client, transport, tools };
    this.servers.set(name, entry);
    return entry;
  }

  specs(): ToolSpec[] {
    const out: ToolSpec[] = [];
    for (const e of this.servers.values())
      for (const t of e.tools.values()) out.push(t.spec);
    return out;
  }

  /** Namespaced dispatch: name must be 'mcp__<server>__<tool>' */
  async dispatch(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const parts = name.split("__");
    if (parts.length !== 3 || parts[0] !== "mcp") return { ok: false, output: `unknown MCP tool ${name}` };
    const [, server, tool] = parts;
    const entry = this.servers.get(server);
    if (!entry) return { ok: false, output: `MCP server '${server}' not connected` };
    const t = entry.tools.get(tool);
    if (!t) return { ok: false, output: `MCP tool '${tool}' on '${server}' not found` };
    return t.run(args);
  }

  async shutdown(): Promise<void> {
    for (const e of this.servers.values()) {
      try { await e.client.close(); } catch { /* */ }
      try { e.transport.close(); } catch { /* */ }
    }
    this.servers.clear();
  }
}

export async function loadMcpFromConfig(cfg: { mcpServers: Record<string, any> }): Promise<McpClient> {
  const c = new McpClient();
  await c.load(cfg);
  return c;
}
