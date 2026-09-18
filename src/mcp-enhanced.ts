/**
 * MCP Enhancement - Full stdio/HTTP transport, auth, resource subscriptions
 */

import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";

export interface McpServerConfig {
  name: string;
  version: string;
  transport: "stdio" | "http" | "ws" | "sse";
  port?: number;
  host?: string;
  path?: string;
  auth?: McpAuthConfig;
  capabilities: McpCapabilities;
}

export interface McpAuthConfig {
  type: "none" | "bearer" | "oauth" | "apikey";
  tokens?: string[]; // valid bearer tokens
  apiKeys?: Record<string, string>; // key -> client info
  oauth?: {
    clientId: string;
    clientSecret: string;
    authorizationUrl: string;
    tokenUrl: string;
    scopes: string[];
  };
  apiKeyHeader?: string; // header name for API key
}

export interface McpCapabilities {
  tools: boolean;
  resources: boolean;
  prompts: boolean;
  logging: boolean;
  sampling: boolean;
  roots: boolean;
}

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  annotations?: any;
}

export interface McpResourceTemplate {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: McpPromptArgument[];
}

export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: any; // JSON Schema
}

export interface McpRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: any;
}

export interface McpResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

export interface McpNotification {
  jsonrpc: "2.0";
  method: string;
  params?: any;
}

export class McpServer extends EventEmitter {
  private config: McpServerConfig;
  private tools = new Map<string, McpTool & { handler: Function }>();
  private resources = new Map<string, McpResource>();
  private resourceTemplates = new Map<string, McpResourceTemplate>();
  private prompts = new Map<string, McpPrompt & { handler: Function }>();
  private transports: McpTransport[] = [];
  private authenticatedClients = new Map<string, any>(); // clientId -> auth info
  private resourceSubscriptions = new Map<string, Set<string>>(); // uri -> clientIds

  constructor(config: McpServerConfig) {
    super();
    this.config = config;
  }

  // Tool registration
  registerTool(tool: McpTool, handler: (args: any, context: McpContext) => Promise<any>): void {
    this.tools.set(tool.name, { ...tool, handler });
  }

  // Resource registration
  registerResource(resource: McpResource, handler?: (uri: string) => Promise<any>): void {
    this.resources.set(resource.uri, resource);
    if (handler) {
      (this.resources.get(resource.uri) as any).handler = handler;
    }
  }

  registerResourceTemplate(template: McpResourceTemplate, handler: (uri: string, variables: Record<string, string>) => Promise<any>): void {
    this.resourceTemplates.set(template.uriTemplate, { ...template, handler });
  }

  // Prompt registration
  registerPrompt(prompt: McpPrompt, handler: (args: any, context: McpContext) => Promise<any>): void {
    this.prompts.set(prompt.name, { ...prompt, handler });
  }

  // Start server
  async start(): Promise<void> {
    switch (this.config.transport) {
      case "stdio":
        await this.startStdio();
        break;
      case "http":
        await this.startHttp();
        break;
      case "ws":
        await this.startWebSocket();
        break;
      case "sse":
        await this.startSSE();
        break;
    }
    this.emit("started");
  }

  private async startStdio(): Promise<void> {
    const { stdin, stdout } = process;
    let buffer = "";

    stdin.on("data", (chunk) => {
      buffer += chunk.toString();
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) this.handleStdioMessage(line);
      }
    });

    process.stdout.on("error", (err) => {
      if (err.code !== "EPIPE") console.error("STDOUT error:", err);
    });
  }

  private handleStdioMessage(line: string): void {
    try {
      const request = JSON.parse(line);
      this.handleRequest(request).then(response => {
        if (response) {
          process.stdout.write(JSON.stringify(response) + "\n");
        }
      }).catch(err => {
        const errorResponse: any = {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: err.message }
        };
        process.stdout.write(JSON.stringify(errorResponse) + "\n");
      });
    } catch (e) {
      const errorResponse: any = {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" }
      };
      process.stdout.write(JSON.stringify(errorResponse) + "\n");
    }
  }

  private async startHttp(): Promise<void> {
    const server = createHttpServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }

      // Auth check
      if (!this.authenticate(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }));
        return;
      }

      let body = "";
      for await (const chunk of req) body += chunk;
      
      try {
        const request = JSON.parse(body);
        const response = await this.handleRequest(request);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
      } catch (e: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: e.message }, id: null }));
      }
    });

    const port = this.config.port || 3000;
    const host = this.config.host || "localhost";
    
    return new Promise<void>((resolve) => {
      server.listen(port, host, () => {
        console.log(`MCP HTTP server listening on ${host}:${port}`);
        resolve();
      });
    });
    this.transports.push({ type: "http", server });
  }

  private async startWebSocket(): Promise<void> {
    const port = this.config.port || 3001;
    const host = this.config.host || "localhost";
    const path = this.config.path || "/mcp";

    const server = createHttpServer();
    const wss = new WebSocketServer({ server, path });

    wss.on("connection", (ws: WebSocket, req) => {
      if (!this.authenticateWs(req)) {
        ws.close(4001, "Unauthorized");
        return;
      }

      const clientId = randomUUID();
      const transport: McpTransport = {
        id: clientId,
        type: "ws",
        ws,
        send: (msg: any) => ws.send(JSON.stringify(msg)),
        close: () => ws.close()
      };

      this.transports.push(transport);
      this.authenticatedClients.set(clientId, { connectedAt: Date.now() });

      ws.on("message", (data) => {
        try {
          const request = JSON.parse(data.toString());
          this.handleRequest(request).then(response => {
            if (response) ws.send(JSON.stringify(response));
          }).catch(err => {
            ws.send(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: err.message }, id: null }));
          });
        } catch (e) {
          ws.send(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
        }
      });

      ws.on("close", () => {
        this.transports = this.transports.filter(t => t.id !== clientId);
        this.authenticatedClients.delete(clientId);
      });
    });

    return new Promise<void>((resolve) => {
      server.listen(this.config.port || 3001, this.config.host || "localhost", () => {
        console.log(`MCP WebSocket server on ws://${this.config.host}:${this.config.port}${this.config.path}`);
        resolve();
      });
    });
    this.transports.push({ type: "ws", server: wss });
  }

  private async startSSE(): Promise<void> {
    // SSE implementation similar to HTTP but with EventSource-compatible streaming
    await this.startHttp(); // Reuse HTTP server
  }

  private authenticate(req: any): boolean {
    if (!this.config.auth || this.config.auth.type === "none") return true;
    
    const auth = this.config.auth;
    
    if (auth.type === "bearer") {
      const authHeader = req.headers?.authorization;
      if (!authHeader?.startsWith("Bearer ")) return false;
      const token = authHeader.slice(7);
      return auth.tokens?.includes(token) ?? false;
    }
    
    if (auth.type === "apikey") {
      const header = auth.apiKeyHeader || "x-api-key";
      const key = req.headers?.[header.toLowerCase()] || req.headers?.[header];
      return auth.apiKeys?.[key as string] !== undefined;
    }
    
    return false;
  }

  private authenticateWs(req: any): boolean {
    // Check query params or headers for auth
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const token = url.searchParams.get("token") || req.headers?.["sec-websocket-protocol"]?.split(",")[1]?.trim();
    
    if (!this.config.auth || this.config.auth.type === "none") return true;
    
    if (this.config.auth.type === "bearer" && token) {
      return this.config.auth.tokens?.includes(token) ?? false;
    }
    if (this.config.auth.type === "apikey" && token) {
      return this.config.auth.apiKeys?.[token] !== undefined;
    }
    return false;
  }

  async handleRequest(request: any): Promise<any> {
    const { jsonrpc, id, method, params } = request;
    
    if (jsonrpc !== "2.0") {
      return { jsonrpc: "2.0", id: request.id, error: { code: -32600, message: "Invalid Request" } };
    }

    try {
      let result: any;
      
      switch (method) {
        case "initialize":
          result = await this.handleInitialize(params);
          break;
        case "tools/list":
          result = { tools: Array.from(this.tools.values()).map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
          break;
        case "tools/call":
          result = await this.callTool(params.name, params.arguments || {}, { clientId: params._clientId });
          break;
        case "resources/list":
          result = { resources: Array.from(this.resources.values()) };
          break;
        case "resources/read":
          result = await this.readResource(params.uri);
          break;
        case "resources/templates/list":
          result = { resourceTemplates: Array.from(this.resourceTemplates.values()) };
          break;
        case "resources/subscribe":
          this.subscribeResource(params.uri, params._clientId);
          result = {};
          break;
        case "resources/unsubscribe":
          this.unsubscribeResource(params.uri, params._clientId);
          result = {};
          break;
        case "prompts/list":
          result = { prompts: Array.from(this.prompts.values()).map(p => ({ name: p.name, description: p.description, arguments: p.arguments })) };
          break;
        case "prompts/get":
          result = await this.getPrompt(params.name, params.arguments);
          break;
        case "resources/templates/list":
          result = { resourceTemplates: Array.from(this.resourceTemplates.values()) };
          break;
        case "notifications/initialized":
          // Client finished initialization
          return null; // No response for notifications
        default:
          throw new Error(`Method not found: ${method}`);
      }
      
      return { jsonrpc: "2.0", id, result };
    } catch (error: any) {
      return { jsonrpc: "2.0", id: request.id, error: { code: -32603, message: error.message, data: error.stack } };
    }
  }

  private async handleInitialize(params: any): Promise<any> {
    return {
      protocolVersion: "2024-11-05",
      capabilities: this.config.capabilities,
      serverInfo: { name: this.config.name, version: this.config.version }
    };
  }

  async callTool(name: string, args: any, context: any): Promise<any> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    
    const ctx: McpContext = {
      clientId: context.clientId,
      requestId: randomUUID(),
      sessionId: context.sessionId,
      auth: context.auth
    };
    
    try {
      const result = await tool.handler(args, context);
      return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] };
    } catch (error: any) {
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
  }

  async readResource(uri: string): Promise<any> {
    const resource = this.resources.get(uri);
    if (!resource) throw new Error(`Resource not found: ${uri}`);
    
    if ((resource as any).handler) {
      const content = await (resource as any).handler(uri);
      return { contents: [{ uri, mimeType: resource.mimeType || "text/plain", text: content }] };
    }
    
    return { contents: [{ uri, mimeType: resource.mimeType || "text/plain", text: "" }] };
  }

  async getPrompt(name: string, args: any): Promise<any> {
    const prompt = this.prompts.get(name);
    if (!prompt) throw new Error(`Prompt not found: ${name}`);
    
    const ctx: McpContext = { clientId: "", requestId: randomUUID() };
    const messages = await prompt.handler(args, { clientId: "", requestId: randomUUID() });
    
    return { description: prompt.description, messages };
  }

  subscribeResource(uri: string, clientId: string): void {
    if (!this.resourceSubscriptions.has(uri)) this.resourceSubscriptions.set(uri, new Set());
    this.resourceSubscriptions.get(uri)!.add(clientId);
  }

  unsubscribeResource(uri: string, clientId: string): void {
    this.resourceSubscriptions.get(uri)?.delete(clientId);
  }

  notifyResourceChanged(uri: string): void {
    const clients = this.resourceSubscriptions.get(uri);
    if (!clients) return;
    
    const notification: McpNotification = {
      jsonrpc: "2.0",
      method: "notifications/resources/updated",
      params: { uri }
    };
    
    for (const clientId of clients) {
      const transport = this.transports.find(t => t.id === clientId);
      if (transport) transport.send({ jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri } });
    }
  }

  // Broadcast to all connected clients
  broadcast(method: string, params: any): void {
    const notification: McpNotification = { jsonrpc: "2.0", method, params };
    for (const transport of this.transports) {
      transport.send({ jsonrpc: "2.0", method, params });
    }
  }

  // Resource subscriptions for real-time updates
  private resourceSubscriptions = new Map<string, Set<string>>();

  // Transport management
  private transports: McpTransport[] = [];
  
  addTransport(transport: McpTransport): void {
    this.transports.push(transport);
  }

  removeTransport(transport: McpTransport): void {
    const idx = this.transports.indexOf(transport);
    if (idx >= 0) this.transports.splice(idx, 1);
  }
}

export interface McpTransport {
  id: string;
  type: "stdio" | "http" | "ws" | "sse";
  ws?: any;
  server?: any;
  send: (msg: any) => void;
  close: () => void;
}

export interface McpContext {
  clientId: string;
  requestId: string;
  sessionId?: string;
  auth?: any;
}

interface McpContext {
  clientId: string;
  requestId: string;
  sessionId?: string;
  auth?: any;
}

// MCP Client for connecting to other MCP servers
export class McpClient {
  private transport: McpTransport;
  private requestId = 0;
  private pending = new Map<number | string, { resolve: Function; reject: Function }>();
  private connected = false;
  private requestIdCounter = 0;

  constructor(transport: McpTransport) {
    this.transport = transport;
    this.setupMessageHandler();
  }

  private setupMessageHandler(): void {
    if (this.transport.type === "ws" && this.transport.ws) {
      this.transport.ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg);
        } catch (e) { /* ignore parse errors */ }
      });
    } else if (this.transport.type === "stdio") {
      // Handle stdio messages
    }
  }

  private handleMessage(msg: any): void {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve } = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) resolve({ error: msg.error });
      else resolve(msg.result);
    } else if (msg.method) {
      // Handle notifications
    }
  }

  async initialize(): Promise<any> {
    return this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "goatcode", version: "1.0.0" }
    });
  }

  async request(method: string, params?: any): Promise<any> {
    const id = ++this.requestIdCounter;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.transport.send({ jsonrpc: "2.0", id, method, params });
      
      // Timeout after 30s
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("Request timeout"));
        }
      }, 30000);
    });
  }

  async listTools(): Promise<any[]> {
    const result = await this.request("tools/list");
    return result.tools || [];
  }

  async callTool(name: string, args: any): Promise<any> {
    const result = await this.request("tools/call", { name, arguments: args });
    if (result.isError) throw new Error(result.content[0]?.text || "Tool error");
    return result.content[0]?.text;
  }

  async listResources(): Promise<any[]> {
    const result = await this.request("resources/list");
    return result.resources || [];
  }

  async readResource(uri: string): Promise<string> {
    const result = await this.request("resources/read", { uri });
    return result.contents[0]?.text || "";
  }

  async subscribe(uri: string): Promise<void> {
    await this.request("resources/subscribe", { uri });
  }

  onNotification(handler: (method: string, params: any) => void): void {
    // Would need event emitter setup
  }

  close(): void {
    this.transport.close();
  }
}

export { McpServer, McpClient, McpTransport, McpTool, McpResource, McpPrompt, McpContext };