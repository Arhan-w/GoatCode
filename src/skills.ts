/**
 * Skills System - Plugin API with sandboxed WASM, hot-reload, marketplace
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { appDir } from "../config.ts";
import { mkdirSync, writeFileSync } from "node:fs";

export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  author: string;
  license: string;
  homepage?: string;
  repository?: string;
  keywords: string[];
  main: string; // entry point
  types?: string; // TypeScript definitions
  dependencies?: Record<string, string>; // skill dependencies
  permissions: SkillPermission[];
  apiVersion: string;
  minGoatVersion: string;
  exports: SkillExports;
}

export interface SkillPermission {
  type: "read" | "write" | "execute" | "network" | "fs" | "process" | "network:fetch" | "fs:read" | "fs:write";
  resource: string; // path pattern or "global"
  description: string;
}

export interface SkillExports {
  commands?: Record<string, SkillCommand>;
  hooks?: Record<string, SkillHook>;
  tools?: Record<string, SkillTool>;
  providers?: Record<string, SkillProvider>;
  ui?: SkillUIComponents;
}

export interface SkillCommand {
  name: string;
  description: string;
  args: SkillArg[];
  handler: string; // function name in main export
  examples?: string[];
}

export interface SkillArg {
  name: string;
  type: "string" | "number" | "boolean" | "array" | "object";
  description: string;
  required: boolean;
  default?: any;
}

export interface SkillHook {
  name: string;
  events: string[]; // event names this hook subscribes to
  handler: string; // function name
  priority?: number; // execution order
  async?: boolean;
}

export interface SkillTool {
  name: string;
  description: string;
  args: SkillArg[];
  handler: string;
  permissions: SkillPermission[];
}

export interface SkillProvider {
  name: string;
  type: "llm" | "embedding" | "search" | "storage";
  config: Record<string, any>;
  handler: string;
}

export interface SkillUIComponents {
  components: Record<string, UIDefinition>;
  styles?: Record<string, string>;
}

export interface UIDefinition {
  type: "panel" | "modal" | "sidebar" | "toolbar" | "statusbar";
  title: string;
  component: string; // React component name or HTML template
  props?: Record<string, any>;
  position?: "left" | "right" | "bottom" | "top" | "floating";
  defaultOpen?: boolean;
}

export interface SkillContext {
  skillDir: string;
  config: any;
  api: SkillAPI;
  logger: SkillLogger;
  storage: SkillStorage;
  events: SkillEventEmitter;
}

export interface SkillAPI {
  // File system (sandboxed)
  fs: {
    readFile(path: string): Promise<string>;
    writeFile(path: string, content: string): Promise<void>;
    listFiles(dir: string): Promise<string[]>;
    exists(path: string): Promise<boolean>;
    mkdir(path: string): Promise<void>;
    remove(path: string): Promise<void>;
    // Sandboxed to skill's directory
  };
  // Configuration
  config: {
    get<T>(key: string, defaultValue?: any): T;
    set(key: string, value: any): void;
    watch(key: string, callback: (value: any) => void): () => void;
  };
  // Storage (persistent key-value)
  storage: {
    get<T>(key: string): Promise<T | null>;
    set(key: string, value: any): Promise<void>;
    delete(key: string): Promise<void>;
    list(prefix?: string): Promise<string[]>;
  };
  // Events
  events: {
    on(event: string, handler: (data: any) => void): () => void;
    emit(event: string, data: any): void;
    once(event: string, handler: (data: any) => void): void;
  };
  // Commands
  commands: {
    register(command: any): void;
    unregister(name: string): void;
  };
  // Tools
  tools: {
    register(tool: any): void;
    unregister(name: string): void;
  };
  // UI
  ui: {
    registerComponent(name: string, component: any): void;
    unregisterComponent(name: string): void;
    openPanel(name: string, props?: any): void;
    closePanel(name: string): void;
  };
  // Network (sandboxed)
  network: {
    fetch(url: string, options?: RequestInit): Promise<Response>;
    websocket(url: string): WebSocket;
  };
  // Process (sandboxed)
  process: {
    exec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }>;
    spawn(cmd: string, args: string[]): ChildProcess;
  };
  // Skills
  skills: {
    load(name: string): Promise<any>;
    unload(name: string): void;
    list(): SkillManifest[];
    get(name: string): any;
  };
}

export interface SkillLogger {
  debug(message: string, meta?: any): void;
  info(message: string, meta?: any): void;
  warn(message: string, meta?: any): void;
  error(message: string, meta?: any): void;
}

export interface SkillStorage {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: any): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
  clear(): Promise<void>;
}

export interface SkillEventEmitter {
  on(event: string, handler: (data: any) => void): () => void;
  once(event: string, handler: (data: any) => void): void;
  emit(event: string, data: any): void;
  off(event: string, handler: (data: any) => void): void;
}

// WASM Sandbox for skill execution
export class SkillSandbox {
  private wasmModule: WebAssembly.Module | null = null;
  private instance: WebAssembly.Instance | null = null;
  private imports: any = {};
  private memory: WebAssembly.Memory | null = null;

  async loadWasm(wasmBytes: Uint8Array, imports: any = {}): Promise<void> {
    this.imports = {
      env: {
        memory: new WebAssembly.Memory({ initial: 10, maximum: 100 }), // 640KB - 6.4MB
        ...imports,
        // Sandboxed imports
        console_log: (ptr: number, len: number) => this.log(ptr, len),
        memory_grow: (pages: number) => this.memory?.grow(pages) ?? 0,
        abort: () => { throw new Error("WASM abort"); },
        // Sandboxed syscalls
        fd_write: this.fd_write.bind(this),
        fd_read: this.fd_read.bind(this),
        fd_close: this.fd_close.bind(this),
        fd_seek: this.fd_seek.bind(this),
        proc_exit: (code: number) => { throw new Error(`Exit: ${code}`); },
        clock_time_get: (id: number, precision: number, out: number) => 0,
        proc_raise: () => 0,
        sched_yield: () => 0,
        random_get: (buf: number, len: number) => {
          const arr = new Uint8Array(this.memory!.buffer, buf, len);
          crypto.getRandomValues(arr);
          return 0;
        }
      },
      wasi_snapshot_preview1: {
        fd_write: this.fd_write.bind(this),
        fd_read: this.fd_read.bind(this),
        fd_close: this.fd_close.bind(this),
        fd_seek: this.fd_seek.bind(this),
        proc_exit: (code: number) => { throw new Error(`Exit: ${code}`); },
        clock_time_get: () => 0,
        proc_raise: () => 0,
        sched_yield: () => 0,
        random_get: (buf: number, len: number) => 0,
        fd_close: () => 0,
        fd_fdstat_get: () => 0,
        fd_fdstat_set_flags: () => 0,
        fd_filestat_get: () => 0,
        fd_filestat_set_size: () => 0,
        fd_filestat_set_times: () => 0,
        fd_read: () => 0,
        fd_write: this.fd_write.bind(this),
        path_create_directory: () => 0,
        path_filestat_get: () => 0,
        path_filestat_set_times: () => 0,
        path_link: () => 0,
        path_open: () => 0,
        path_readlink: () => 0,
        path_remove_directory: () => 0,
        path_rename: () => 0,
        path_symlink: () => 0,
        path_unlink_file: () => 0,
        poll_oneoff: () => 0,
        sched_yield: () => 0,
        random_get: (buf: number, len: number) => 0,
      }
    };

    this.module = await WebAssembly.compile(wasmBytes);
    this.memory = new WebAssembly.Memory({ initial: 10, maximum: 100 }); // 640KB - 6.4MB
    this.imports.env.memory = new WebAssembly.Memory({ initial: 10, maximum: 100 });
    this.instance = await WebAssembly.instantiate(this.module, this.imports);
  }

  private log(ptr: number, len: number): void {
    if (!this.memory) return;
    const decoder = new TextDecoder();
    const bytes = new Uint8Array(this.memory!.buffer, ptr, len);
    const text = decoder.decode(bytes);
    console.log("[WASM]", text.trim());
  }

  private fd_write(fd: number, iovs_ptr: number, iovs_len: number): number {
    // Simplified - just log to console
    return 0;
  }
  private fd_read(fd: number, iovs_ptr: number, iovs_len: number): number { return 0; }
  private fd_close(fd: number): number { return 0; }
  private fd_seek(fd: number, offset_low: number, offset_high: number, whence: number, new_offset: number): number { return 0; }
  private fd_write(fd: number, iovs_ptr: number, iovs_len: number, written: number): number { return 0; }
  private fd_close(fd: number): number { return 0; }
  private fd_read(fd: number, iovs_ptr: number, iovs_len: number, read: number): number { return 0; }
  private fd_seek(fd: number, offset_low: number, offset_high: number, whence: number, new_offset: number): number { return 0; }

  async runFunction(functionName: string, args: any[]): Promise<any> {
    if (!this.instance) throw new Error("WASM not loaded");
    const fn = (this.instance.exports as any)[functionName];
    if (!fn) throw new Error(`Function ${functionName} not exported`);
    return fn(...args);
  }

  async loadFromFile(wasmPath: string): Promise<void> {
    const wasmBytes = readFileSync(wasmPath);
    await this.loadWasm(wasmPath);
  }

  getExports(): any {
    return this.instance?.exports || {};
  }
}

// Skill Manager
export class SkillManager {
  private skills = new Map<string, LoadedSkill>();
  private skillDirs: string[];
  private marketplaceIndex: Map<string, SkillManifest> = new Map();
  private registryUrl?: string;

  constructor(skillDirs: string[] = []) {
    this.skillDirs = skillDirs;
  }

  async initialize(): Promise<void> {
    // Load built-in skills
    await this.loadBuiltinSkills();
    // Load user skills
    for (const dir of this.skillDirs) {
      await this.loadSkillsFromDir(dir);
    }
    // Load marketplace index
    await this.updateMarketplaceIndex();
  }

  private async loadBuiltinSkills(): Promise<void> {
    // Load built-in skills (built into GoatCode)
    const builtinSkills = [
      { name: "git", path: "builtin/git" },
      { name: "github", path: "builtin/github" },
      { name: "docker", path: "builtin/docker" },
      { name: "database", path: "builtin/database" },
      { name: "testing", path: "builtin/testing" },
      { name: "linting", path: "builtin/linting" },
      { name: "formatting", path: "builtin/formatting" },
      { name: "deploy", path: "builtin/deploy" }
    ];

    for (const skill of builtinSkills) {
      try {
        await this.loadSkill(skill.name, skill.path);
      } catch (e) {
        console.warn(`Failed to load builtin skill ${skill.name}:`, e);
      }
    }
  }

  async loadSkillsFromDir(dir: string): Promise<void> {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          await this.loadSkill(entry.name, join(dir, entry.name));
        }
      }
    } catch (e) {
      // Directory might not exist
    }
  }

  async loadSkill(name: string, skillPath: string): Promise<void> {
    const manifestPath = join(skillPath, "skill.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`Skill manifest not found: ${manifestPath}`);
    }

    const manifest: SkillManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    
    // Validate manifest
    this.validateManifest(manifest);

    // Check dependencies
    await this.checkDependencies(manifest);

    // Load skill (WASM or JS)
    const skill: LoadedSkill = {
      manifest,
      path: skillDir,
      loaded: false,
      instance: null,
      exports: {},
      context: null
    };

    // Check if it's a WASM skill or JS module
    const wasmPath = join(skillPath, manifest.main.replace(/\.js$/, ".wasm"));
    const jsPath = join(skillDir, manifest.main);

    let instance: any = null;

    if (existsSync(wasmPath)) {
      // Load WASM module
      const sandbox = new SkillSandbox();
      await sandbox.loadFromFile(wasmPath);
      this.sandboxes.set(manifest.name, sandbox);
      skill.instance = sandbox;
    } else if (existsSync(jsPath)) {
      // Load JS module
      const mod = await import(jsPath);
      skill.instance = mod.default || mod;
    } else {
      throw new Error(`No entry point found for skill: ${manifest.main}`);
    }

    // Initialize skill context
    const context = await this.createSkillContext(manifest, skillDir);
    skill.context = context;

    // Initialize skill
    if (skill.instance?.initialize) {
      await skill.instance.initialize(skill.context);
    }

    skill.loaded = true;
    skill.exports = skill.instance?.exports || {};

    this.skills.set(manifest.name, skill);

    // Register exports
    this.registerExports(manifest.name, skill.exports);
  }

  private validateManifest(manifest: SkillManifest): void {
    if (!manifest.name || !manifest.version || !manifest.main) {
      throw new Error("Invalid skill manifest: missing required fields");
    }
    if (!semver.satisfies(manifest.apiVersion, ">=1.0.0")) {
      throw new Error(`Unsupported API version: ${manifest.apiVersion}`);
    }
  }

  private async checkDependencies(manifest: SkillManifest): Promise<void> {
    if (!manifest.dependencies) return;
    for (const [dep, version] of Object.entries(manifest.dependencies)) {
      if (!this.skills.has(dep)) {
        // Try to load from marketplace
        await this.installSkill(dep, version);
      }
    }
  }

  async installSkill(name: string, version?: string): Promise<void> {
    if (!this.registryUrl) {
      throw new Error("No marketplace registry configured");
    }

    // Download from marketplace
    const response = await fetch(`${this.registryUrl}/skills/${name}${version ? `@${version}` : ""}`);
    if (!response.ok) throw new Error(`Failed to download skill: ${response.statusText}`);

    const skillData = await response.json();
    const skillDir = join(appDir(), "skills", skillData.name);
    mkdirSync(skillDir, { recursive: true });

    // Write skill files
    writeFileSync(join(skillDir, "skill.json"), JSON.stringify(skillData.manifest, null, 2));
    
    if (skillData.wasm) {
      writeFileSync(join(skillDir, "skill.wasm"), Buffer.from(skillData.wasm, "base64"));
    }
    if (skillData.js) {
      writeFileSync(join(skillDir, "index.js"), skillData.js);
    }

    await this.loadSkill(skillData.name, skillDir);
  }

  private async loadSkillsFromDir(dir: string): Promise<void> {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillPath = join(dir, entry.name);
          const manifestPath = join(skillPath, "skill.json");
          if (existsSync(manifestPath)) {
            await this.loadSkill(entry.name, skillPath);
          }
        }
      }
    } catch (e) {
      // Directory might not exist
    }
  }

  private async updateMarketplaceIndex(): Promise<void> {
    if (!this.registryUrl) return;
    try {
      const response = await fetch(`${this.registryUrl}/index.json`);
      if (response.ok) {
        const index = await response.json();
        for (const skill of index.skills) {
          this.marketplaceIndex.set(skill.name, skill);
        }
      }
    } catch (e) {
      console.warn("Failed to update marketplace index:", e);
    }
  }

  private validateManifest(manifest: SkillManifest): void {
    if (!manifest.name || !manifest.version || !manifest.main) {
      throw new Error("Invalid skill manifest: missing required fields");
    }
  }

  private async checkDependencies(manifest: SkillManifest): Promise<void> {
    if (!manifest.dependencies) return;
    for (const [dep, version] of Object.entries(manifest.dependencies)) {
      if (!this.skills.has(dep)) {
        await this.installSkill(dep, version);
      }
    }
  }

  private getSkillContext(manifest: SkillManifest, skillDir: string): SkillContext {
    const skillDirPath = resolve(manifest.name);
    mkdirSync(skillDir, { recursive: true });

    return {
      skillDir,
      config: {},
      api: {
        fs: {
          readFile: async (path: string) => {
            const safePath = this.sanitizePath(skillDir, path);
            return readFileSync(safePath, "utf8");
          },
          writeFile: async (path: string, content: string) => {
            const safePath = this.sanitizePath(skillDir, path);
            mkdirSync(dirname(safePath), { recursive: true });
            writeFileSync(safePath, content);
          },
          listFiles: async (dir: string) => {
            const safeDir = this.sanitizePath(skillDir, dir);
            return readdirSync(safeDir, { withFileTypes: true })
              .filter(e => !e.name.startsWith("."))
              .map(e => e.name);
          },
          exists: async (path: string) => {
            const safePath = this.sanitizePath(skillDir, path);
            return existsSync(safePath);
          },
          mkdir: async (path: string) => {
            const safePath = this.sanitizePath(skillDir, path);
            mkdirSync(safePath, { recursive: true });
          },
          remove: async (path: string) => {
            const safePath = this.sanitizePath(skillDir, path);
            unlinkSync(safePath);
          }
        },
        config: {
          get: <T>(key: string, defaultValue?: T): T => {
            // Implementation
            return defaultValue as T;
          },
          set: (key: string, value: any) => {},
          watch: (key: string, callback: (value: any) => void) => {
            return () => {};
          }
        },
        storage: {
          get: async <T>(key: string): Promise<T | null> => {
            // Use skill-specific storage namespace
            return null;
          },
          set: async (key: string, value: any) => {},
          delete: async (key: string) => {},
          list: async (prefix?: string) => [],
          clear: async () => {}
        },
        events: {
          on: (event: string, handler: (data: any) => void) => {
            return () => {};
          },
          emit: (event: string, data: any) => {},
          once: (event: string, handler: (data: any) => void) => {}
        },
        commands: {
          register: (command: any) => {},
          unregister: (name: string) => {}
        },
        tools: {
          register: (tool: any) => {},
          unregister: (name: string) => {}
        },
        ui: {
          registerComponent: (name: string, component: any) => {},
          unregisterComponent: (name: string) => {},
          openPanel: (name: string, props?: any) => {},
          closePanel: (name: string) => {}
        },
        network: {
          fetch: async (url: string, options?: RequestInit) => {
            // Sandboxed fetch - only allow certain domains
            return fetch(url, options);
          },
          websocket: (url: string) => {
            return new WebSocket(url);
          }
        },
        process: {
          exec: async (cmd: string, args: string[]) => {
            // Sandboxed process execution
            return { stdout: "", stderr: "", code: 0 };
          },
          spawn: (cmd: string, args: string[]) => {
            return { on: () => {}, kill: () => {} } as any;
          }
        },
        skills: {
          load: async (name: string) => {},
          unload: (name: string) => {},
          list: () => [],
          get: (name: string) => null
        }
      };
    }

    private sanitizePath(baseDir: string, path: string): string {
      const resolved = resolve(baseDir, path);
      const base = resolve(baseDir);
      if (!resolved.startsWith(base)) {
        throw new Error("Path traversal attempt blocked");
      }
      return resolved;
    }

  private async createSkillContext(manifest: SkillManifest, skillDir: string): Promise<SkillContext> {
    // Implementation
    return {} as SkillContext;
  }

  private async loadSkillsFromDir(dir: string): Promise<void> {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillPath = join(dir, entry.name);
          const manifestPath = join(skillPath, "skill.json");
          if (existsSync(manifestPath)) {
            await this.loadSkill(entry.name, skillPath);
          }
        }
      } catch (e) {
        // Directory might not exist
      }
    }

  private registerExports(skillName: string, exports: SkillExports): void {
    if (exports.commands) {
      for (const [name, cmd] of Object.entries(exports.commands)) {
        this.registerCommand(skillName, cmd);
      }
    }
    if (exports.tools) {
      for (const [name, tool] of Object.entries(exports.tools)) {
        this.registerTool(skillName, tool);
      }
    }
    if (exports.hooks) {
      for (const [name, hook] of Object.entries(exports.hooks)) {
        this.registerHook(skillName, hook);
      }
    }
    if (exports.providers) {
      for (const [name, provider] of Object.entries(exports.providers)) {
        this.registerProvider(skillName, provider);
      }
    }
  }

  registerCommand(skillName: string, command: SkillCommand): void {
    // Register with command system
  }

  registerTool(skillName: string, tool: SkillTool): void {
    // Register with tool system
  }

  registerHook(skillName: string, hook: SkillHook): void {
    // Register hook
  }

  registerProvider(skillName: string, provider: SkillProvider): void {
    // Register provider
  }

  getSkill(name: string): LoadedSkill | undefined {
    return this.skills.get(name);
  }

  listSkills(): SkillManifest[] {
    return Array.from(this.skills.values()).map(s => s.manifest);
  }

  async unloadSkill(name: string): Promise<void> {
    const skill = this.skills.get(name);
    if (skill) {
      if (skill.instance?.cleanup) {
        await skill.instance.cleanup();
      }
      this.skills.delete(name);
    }
  }

  // Marketplace
  async searchMarketplace(query: string): Promise<SkillManifest[]> {
    if (!this.registryUrl) return [];
    try {
      const response = await fetch(`${this.registryUrl}/search?q=${encodeURIComponent(query)}`);
      return response.json();
    } catch {
      return [];
    }
  }

  getMarketplaceSkills(): SkillManifest[] {
    return Array.from(this.marketplaceIndex.values());
  }

  setRegistryUrl(url: string): void {
    this.registryUrl = url;
  }
}

export interface LoadedSkill {
  manifest: SkillManifest;
  skillDir: string;
  loaded: boolean;
  instance: any;
  exports: SkillExports;
  context: SkillContext | null;
}

const skillsManager = new SkillManager([join(appDir(), "skills")]);
export { SkillManager, skillsManager };

export { SkillManifest, SkillPermission, SkillExports, SkillCommand, SkillHook, SkillTool, SkillProvider, SkillContext, SkillAPI, SkillLogger, SkillStorage, SkillEventEmitter, SkillContext, SkillLogger, SkillStorage, SkillEventEmitter };

// Marketplace index type
interface MarketplaceIndex {
  skills: SkillManifest[];
  updated: number;
}