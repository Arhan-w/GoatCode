/**
 * Core GoatCode Improvements - Main Entry Point
 * Integrates all enhanced systems
 */

import { EnhancedAgent } from "./agent-enhanced.ts";
import { SessionDatabase, sessionDB } from "./session-db.ts";
import { SkillManager, skillsManager } from "./skills.ts";
import { McpServer, McpClient } from "./mcp-enhanced.ts";
import { CollabManager, CollabSessionManager } from "./collab.ts";
import { semanticSearch } from "./code/semantic.ts";
import { sessionDB } from "./session-db.ts";
import { skillsManager } from "./skills.ts";

export interface GoatCodeConfig {
  enablePlanning: boolean;
  enableReasoning: boolean;
  enableSemanticSearch: boolean;
  enableSessionDB: boolean;
  enableSkills: boolean;
  enableMCP: boolean;
  enableCollab: boolean;
  enableEnhancedAgent: boolean;
}

export interface GoatCodeDeps {
  client: any;
  config: any;
  session: any;
  tools: any;
}

export class GoatCodeCore {
  private config: Required<GoatCodeConfig>;
  private agent: any;
  private sessionDB: any;
  private skillManager: any;
  private mcpServer: any;
  private collabManager: any;
  
  constructor(config: Partial<GoatCodeConfig> = {}) {
    this.config = {
      enablePlanning: config.enablePlanning ?? true,
      enableReasoning: config.enableReasoning ?? true,
      enableSemanticSearch: config.enableSemanticSearch ?? true,
      enableSessionDB: config.enableSessionDB ?? true,
      enableSkills: config.enableSkills ?? true,
      enableMCP: config.enableMCP ?? true,
      enableCollab: config.enableCollab ?? true,
      enableEnhancedAgent: config.enableEnhancedAgent ?? true,
    };
  }

  async initialize(deps: any): Promise<void> {
    // Initialize session DB
    if (this.config.enableSessionDB) {
      // sessionDB is already initialized
      console.log("Session DB initialized");
    }

    // Initialize skills
    if (this.config.enableSkills) {
      await skillsManager.initialize();
      console.log("Skills system initialized");
    }

    // Initialize semantic search
    if (this.config.enableSemanticSearch) {
      try {
        await semanticSearch.initialize();
        console.log("Semantic search initialized");
      } catch (e) {
        console.warn("Semantic search unavailable:", e);
      }
    }

    console.log("GoatCode Core initialized");
  }

  async createEnhancedAgent(deps: any) {
    if (!this.config.enableEnhancedAgent) {
      // Return standard agent
      const { Agent } = await import("./agent.ts");
      return new Agent(deps);
    }

    const { EnhancedAgent } = await import("./agent-enhanced.ts");
    return new EnhancedAgent({
      ...deps,
      enablePlanning: this.config.enablePlanning,
      enableReasoning: this.config.enableReasoning,
    });
  }

  async initializeSemanticSearch(roots: Map<string, string>) {
    if (!this.config.enableSemanticSearch) return;
    try {
      await semanticSearch.initialize();
      await semanticSearch.indexCodebase(new Map(), (progress) => {
        console.log(`Indexing: ${progress.done}/${progress.total}`);
      });
    } catch (e) {
      console.warn("Semantic search init failed:", e);
    }
  }

  async searchCode(query: string, opts: { k?: number; hybrid?: boolean } = {}) {
    if (!this.config.enableSemanticSearch) return [];
    try {
      return await semanticSearch.search(query, opts.k || 10);
    } catch (e) {
      console.warn("Semantic search failed:", e);
      return [];
    }
  }

  // Session management
  async createSession(opts: any) {
    const { Session } = await import("./session.ts");
    return Session.new(opts.cwd, opts.model);
  }

  // Skills
  async loadSkill(name: string, path: string) {
    return skillsManager.loadSkill(name, path);
  }

  // MCP
  async createMCPServer(config: any) {
    const { McpServer } = await import("./mcp-enhanced.ts");
    const server = new McpServer(config);
    await server.start();
    return server;
  }

  // Collaboration
  createCollabSession(roomName: string, config: any) {
    const { CollabManager } = await import("./collab.ts");
    const manager = new CollabManager({
      roomName: config.roomName,
      userId: config.userId,
      userName: config.userName,
      ...config
    });
    return new CollabManager(config);
  }
}

export const goatCode = new GoatCodeCore();
export { GoatCodeCore };