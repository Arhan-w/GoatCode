/**
 * Session Management - SQLite-based persistent session storage
 * Provides searchable history, branching, snapshots, and replay
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appDir } from "../config.ts";
import Database from "better-sqlite3";

const DB_PATH = join(appDir(), "sessions.db");

export interface SessionRecord {
  id: string;
  cwd: string;
  model: string;
  title: string;
  created_at: number;
  updated_at: number;
  parent_id?: string; // for branching
  branch_name?: string;
  messages_json: string;
  usage_in: number;
  usage_out: number;
  cache_read?: number;
  cache_write?: number;
  compacted_from: number;
  digest?: string;
  tags?: string; // JSON array
  is_branch: boolean;
  parent_session_id?: string;
}

export interface SessionSearchResult {
  id: string;
  title: string;
  model: string;
  cwd: string;
  created_at: number;
  updated_at: number;
  snippet: string;
  matches: number;
  tags: string[];
  is_branch: boolean;
}

export interface SessionSnapshot {
  id: string;
  session_id: string;
  name: string;
  description: string;
  created_at: number;
  messages_json: string;
  usage_in: number;
  usage_out: number;
  compacted_from: number;
  digest?: string;
  tags?: string;
}

class SessionDatabase {
  private db: any;
  private initialized = false;

  constructor() {
    this.init();
  }

  private init(): void {
    try {
      const Database = require("better-sqlite3");
      this.db = new Database(join(appDir(), "sessions.db"));
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      this.initSchema();
      this.initialized = true;
    } catch (error) {
      console.warn("SQLite not available, falling back to JSONL:", error);
      throw error;
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        model TEXT NOT NULL,
        title TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        parent_id TEXT,
        branch_name TEXT,
        messages_json TEXT NOT NULL,
        usage_in INTEGER DEFAULT 0,
        usage_out INTEGER DEFAULT 0,
        cache_read INTEGER DEFAULT 0,
        cache_write INTEGER DEFAULT 0,
        compacted_from INTEGER DEFAULT 0,
        digest TEXT,
        tags TEXT, -- JSON array
        is_branch INTEGER DEFAULT 0,
        parent_session_id TEXT,
        FOREIGN KEY (parent_id) REFERENCES sessions(id),
        FOREIGN KEY (parent_session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        created_at INTEGER NOT NULL,
        messages_json TEXT NOT NULL,
        usage_in INTEGER DEFAULT 0,
        usage_out INTEGER DEFAULT 0,
        compacted_from INTEGER DEFAULT 0,
        digest TEXT,
        tags TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS session_tags (
        session_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        PRIMARY KEY (session_id, tag),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd);
      CREATE INDEX IF NOT EXISTS idx_sessions_model ON sessions(model);
      CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_branch ON sessions(is_branch);
      CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);

      -- FTS for full-text search
      CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
        id UNINDEXED,
        title,
        cwd,
        model,
        content='sessions',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS sessions_ai AFTER INSERT ON sessions BEGIN
        INSERT INTO sessions_fts(rowid, id, title, cwd, model)
        VALUES (new.rowid, new.id, new.title, new.cwd, new.model);
      END;

      CREATE TRIGGER IF NOT EXISTS sessions_ad AFTER DELETE ON sessions BEGIN
        INSERT INTO sessions_fts(sessions_fts, rowid, id, title, cwd, model)
        VALUES ('delete', old.rowid, old.id, old.title, old.cwd, old.model);
      END;

      CREATE TRIGGER IF NOT EXISTS sessions_au AFTER UPDATE ON sessions BEGIN
        INSERT INTO sessions_fts(sessions_fts, rowid, id, title, cwd, model)
        VALUES ('delete', old.rowid, old.id, old.title, old.cwd, old.model);
        INSERT INTO sessions_fts(rowid, id, title, cwd, model)
        VALUES (new.rowid, new.id, new.title, new.cwd, new.model);
      END;
    `);
  }

  // Session CRUD
  save(session: any): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions (
        id, cwd, model, title, created_at, updated_at,
        parent_id, branch_name, messages_json,
        usage_in, usage_out, cache_read, cache_write,
        compacted_from, digest, tags, is_branch, parent_session_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      session.id,
      session.cwd,
      session.model,
      session.title || "",
      session.createdAt || Date.now(),
      Date.now(),
      session.parentId || null,
      session.branchName || null,
      JSON.stringify(session.messages),
      session.usage?.in || 0,
      session.usage?.out || 0,
      session.cacheRead || 0,
      session.cacheWrite || 0,
      session.compactedFrom || 0,
      session.digest || null,
      JSON.stringify(session.tags || []),
      session.isBranch ? 1 : 0,
      session.parentSessionId || null
    );
  }

  get(id: string): any {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
    if (!row) return null;
    return {
      ...row,
      messages: JSON.parse(row.messages_json),
      tags: JSON.parse(row.tags || "[]"),
      isBranch: Boolean(row.is_branch),
      parentSessionId: row.parent_session_id
    };
  }

  // Session branching
  createBranch(sessionId: string, branchName: string, branchPoint?: number): any {
    const session = this.get(sessionId);
    if (!session) throw new Error("Session not found");

    const branchId = `branch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const branchNameFinal = branchName || `branch_${Date.now()}`;
    
    const branchData = {
      ...session,
      id: branchId,
      title: `${session.title} (branch: ${branchNameFinal})`,
      parentId: session.id,
      branchName: branchNameFinal,
      isBranch: true,
      parentSessionId: session.id,
      messages: session.messages.slice(0, branchPoint || session.messages.length)
    };

    this.save({ ...session, ...branchData, id: branchId });
    return this.get(branchId);
  }

  // Session search with FTS
  search(query: string, options: { limit?: number; cwd?: string; model?: string; tags?: string[] } = {}): any[] {
    let query = `
      SELECT s.*, 
        snippet(sessions_fts, -1, '...', '...', '...', 32) as snippet
      FROM sessions_fts
      JOIN sessions s ON sessions_fts.rowid = s.rowid
      WHERE sessions_fts MATCH ?
    `;
    
    const params: any[] = [query];
    
    if (options.cwd) {
      query += " AND s.cwd = ?";
      params.push(options.cwd);
    }
    if (options.model) {
      query += " AND s.model = ?";
      params.push(options.model);
    }
    if (options.tags?.length) {
      query += " AND EXISTS (SELECT 1 FROM session_tags st WHERE st.session_id = s.id AND st.tag IN (" + options.tags.map(() => "?").join(",") + "))";
      params.push(...options.tags);
    }
    
    query += " ORDER BY bm25(sessions_fts) LIMIT ?";
    params.push(options.limit || 20);

    return this.db.prepare(query).all(...params);
  }

  // Full-text search with ranking
  searchByContent(query: string, options: { limit?: number; cwd?: string } = {}): any[] {
    const rows = this.db.prepare(`
      SELECT s.*, 
        snippet(sessions_fts, -1, '...', '...', '...', 64) as snippet,
        bm25(sessions_fts) as rank
      FROM sessions_fts
      JOIN sessions s ON sessions_fts.rowid = s.rowid
      WHERE sessions_fts MATCH ? AND s.cwd LIKE ?
      ORDER BY rank LIMIT ?
    `).all(query, options.cwd ? `%${options.cwd}%` : "%", options.limit || 20);
    
    return rows.map(row => ({
      ...row,
      messages: JSON.parse(row.messages_json),
      tags: JSON.parse(row.tags || "[]"),
      isBranch: Boolean(row.is_branch),
      parentSessionId: row.parent_session_id
    });
  }

  // Session snapshots
  createSnapshot(sessionId: string, name: string, description: string): void {
    const session = this.get(sessionId);
    if (!session) throw new Error("Session not found");

    const stmt = this.db.prepare(`
      INSERT INTO snapshots (id, session_id, name, description, created_at, messages_json, usage_in, usage_out, compacted_from, digest, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      `snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      session.id,
      name,
      description || "",
      Date.now(),
      JSON.stringify(session.messages),
      session.usage?.in || 0,
      session.usage?.out || 0,
      session.compactedFrom || 0,
      session.digest || null,
      JSON.stringify(session.tags || [])
    );
  }

  listSnapshots(sessionId: string): any[] {
    return this.db.prepare("SELECT * FROM snapshots WHERE session_id = ? ORDER BY created_at DESC").all(sessionId);
  }

  restoreSnapshot(snapshotId: string): any {
    const snap = this.db.prepare("SELECT * FROM snapshots WHERE id = ?").get(snapshotId);
    if (!snap) throw new Error("Snapshot not found");

    const session = this.get(snap.session_id);
    if (!session) throw new Error("Parent session not found");

    // Create new session from snapshot
    const newSession = {
      ...session,
      id: `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      messages: JSON.parse(snap.messages_json),
      usage: { in: snap.usage_in, out: snap.usage_out },
      compactedFrom: snap.compacted_from,
      digest: snap.digest,
      tags: JSON.parse(snap.tags || "[]"),
      createdAt: Date.now(),
      title: `Restored: ${snap.name}`
    };

    this.save({ ...session, ...snap, id: `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` });
    return this.get(newSession.id);
  }

  listSnapshots(sessionId: string): any[] {
    return this.listSnapshots(sessionId);
  }

  // Tagging
  addTag(sessionId: string, tag: string): void {
    this.db.prepare("INSERT OR IGNORE INTO session_tags (session_id, tag) VALUES (?, ?)").run(sessionId, tag);
  }

  removeTag(sessionId: string, tag: string): void {
    this.db.prepare("DELETE FROM session_tags WHERE session_id = ? AND tag = ?").run(sessionId, tag);
  }

  getTags(sessionId: string): string[] {
    return this.db.prepare("SELECT tag FROM session_tags WHERE session_id = ?").all(sessionId).map(r => r.tag);
  }

  // Session history with pagination
  list(options: { limit?: number; offset?: number; cwd?: string; model?: string } = {}): any[] {
    let query = "SELECT * FROM sessions";
    const params: any[] = [];
    const conditions: string[] = [];

    if (options.cwd) {
      conditions.push("cwd = ?");
      params.push(options.cwd);
    }
    if (options.model) {
      conditions.push("model = ?");
      params.push(options.model);
    }

    if (conditions.length) {
      query += " WHERE " + conditions.join(" AND ");
    }

    query += " ORDER BY updated_at DESC LIMIT ? OFFSET ?";
    params.push(options.limit || 50, options.offset || 0);

    return this.db.prepare(query).all(...params).map(row => ({
      ...row,
      messages: JSON.parse(row.messages_json),
      tags: JSON.parse(row.tags || "[]"),
      isBranch: Boolean(row.is_branch),
      parentSessionId: row.parent_session_id
    });
  }

  // Delete session
  delete(id: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    // Snapshots and tags cascade deleted via foreign keys
  }

  // Get session tree (for branch visualization)
  getSessionTree(rootId: string): any {
    const sessions = this.db.prepare("SELECT * FROM sessions WHERE parent_session_id = ? OR id = ?").all(rootId, rootId);
    const children = new Map<string, any[]>();
    
    for (const s of sessions) {
      if (s.parent_session_id) {
        if (!children.has(s.parent_session_id)) children.set(s.parent_session_id, []);
        children.get(s.parent_session_id)!.push(s);
      }
    }

    const buildTree = (id: string): any => {
      const session = this.get(id);
      if (!session) return null;
      const kids = children.get(id) || [];
      return {
        ...session,
        children: kids.map(k => buildTree(k.id))
      };
    };

    return buildTree(rootId);
  }

  close(): void {
    this.db.close();
  }
}

export const sessionDB = new SessionDatabase();
export { SessionDatabase };

// Export types
export type { SessionRecord, SessionSnapshot, SessionSearchResult };