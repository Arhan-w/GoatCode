/**
 * Collab System - CRDT-based real-time collaboration using Yjs
 */

import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { IndexeddbPersistence } from "y-indexeddb";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

export interface CollabConfig {
  roomName: string;
  userId: string;
  userName: string;
  userColor: string;
  signalingServer?: string; // WebRTC signaling server
  websocketUrl?: string; // y-websocket server
  persistence?: boolean; // Enable IndexedDB persistence
}

export interface CollabUser {
  id: string;
  name: string;
  color: string;
  cursor?: { x: number; y: number; selection?: { start: number; end: number } };
  lastActive: number;
  isOnline: boolean;
}

export interface CollabDocument {
  id: string;
  content: string;
  version: number;
  lastModified: number;
  users: Map<string, CollabUser>;
}

export interface CollabEvent {
  type: "user-joined" | "user-left" | "cursor-move" | "content-change" | "selection-change" | "user-status";
  userId: string;
  userName: string;
  data: any;
  timestamp: number;
}

interface CollabUserInternal extends CollabUser {
  awareness: any; // Yjs awareness
  lastPing: number;
}

export class CollabManager extends EventEmitter {
  private doc: Y.Doc;
  private provider: any; // WebsocketProvider
  private persistence: any; // IndexeddbPersistence
  private awareness: any; // Yjs awareness
  private roomName: string;
  private userId: string;
  private userName: string;
  private userColor: string;
  private connected = false;
  private synced = false;
  private localUserId: string;
  private documentContent = "";
  private pendingChanges: any[] = [];
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;

  constructor(config: CollabConfig) {
    super();
    this.roomName = config.roomName;
    this.userId = config.userId;
    this.userName = config.userName;
    this.userColor = config.userColor || this.generateColor();
    
    this.doc = new Y.Doc();
    this.setupYjs();
    
    // Initialize connection
    this.connect(config.websocketUrl || "wss://demos.yjs.dev", config.roomName);
    
    if (config.persistence) {
      this.setupPersistence();
    }
  }

  private setupYjs(): void {
    // Create shared text type for collaborative editing
    this.ydoc = this.doc.getText("content");
    
    // Awareness for cursor positions and user presence
    this.awareness = (this.doc as any).awareness || (this.doc as any).awareness || this.createAwareness();
    
    // Set local user info
    this.awareness.setLocalStateField("user", {
      id: this.userId,
      name: this.userName,
      color: this.generateColor(),
      cursor: null,
      lastActive: Date.now()
    });

    // Listen for remote changes
    this.doc.on("update", (update: Uint8Array, origin: any) => {
      this.emit("remote-change", update);
    });

    // Listen for awareness changes (cursors, presence)
    this.awareness.on("change", () => {
      this.broadcastAwareness();
    });

    // Observe text changes
    this.ytext = this.doc.getText("content");
    this.ytext.observe((event: any) => {
      this.emit("content-change", {
        delta: event.changes,
        content: this.doc.getText("content").toString()
      });
    });
  }

  private createAwareness(): any {
    // Minimal awareness implementation if Yjs awareness not available
    return {
      states: new Map(),
      setLocalStateField: (key: string, value: any) => {},
      on: (event: string, handler: Function) => {},
      off: (event: string, handler: Function) => {},
      getStates: () => new Map()
    };
  }

  private async connect(wsUrl: string, roomName: string): Promise<void> {
    try {
      // Dynamic import for y-websocket
      const { WebsocketProvider } = await import("y-websocket");
      
      this.provider = new WebsocketProvider(
        "wss://demos.yjs.dev", // Default signaling server
        this.roomName,
        this.doc,
        { connect: true }
      );

      this.provider.on("status", (event: { connected: boolean }) => {
        this.connected = event.connected;
        this.emit("connection-change", event.connected);
        if (event.connected) {
          this.reconnectAttempts = 0;
          this.emit("connected");
        } else {
          this.scheduleReconnect();
        }
      });

      this.provider.on("sync", (isSynced: boolean) => {
        this.synced = isSynced;
        this.emit("sync", isSynced);
      });

      this.provider.on("peer-joined", (peerId: string) => {
        this.emit("peer-joined", peerId);
      });

      this.provider.on("peer-left", (peerId: string) => {
        this.emit("peer-left", peerId);
      });

      this.provider.on("error", (error: Error) => {
        console.error("Collab provider error:", error);
        this.emit("error", error);
      });

      // Wait for connection
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Connection timeout")), 10000);
        this.provider.once("status", (event: { connected: boolean }) => {
          if (event.connected) {
            clearTimeout(timeout);
            resolve();
          }
        });
      });

    } catch (error) {
      console.error("Failed to connect:", error);
      throw error;
    }
  }

  private setupPersistence(): void {
    try {
      const { IndexeddbPersistence } = require("y-indexeddb");
      this.persistence = new IndexeddbPersistence(this.roomName, this.doc);
      this.persistence.on("synced", () => {
        console.log("Content synced with IndexedDB");
      });
    } catch (error) {
      console.warn("IndexedDB persistence not available:", error);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= 5) {
      this.emit("error", new Error("Max reconnection attempts reached"));
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    
    setTimeout(() => {
      this.reconnect();
    }, delay);
  }

  private async reconnect(): Promise<void> {
    try {
      if (this.provider) {
        this.provider.disconnect();
        this.provider.destroy();
      }
      await this.connect("wss://demos.yjs.dev", this.roomName);
    } catch (error) {
      console.error("Reconnection failed:", error);
      this.scheduleReconnect();
    }
  }

  // Public API

  // Get current document content
  getContent(): string {
    return this.doc.getText("content").toString();
  }

  // Set content (local change)
  setContent(content: string): void {
    const ytext = this.doc.getText("content");
    this.doc.transact(() => {
      this.ytext.delete(0, this.ytext.length);
      this.ytext.insert(0, content);
    });
  }

  // Insert text at position
  insertText(index: number, text: string): void {
    this.ytext.insert(index, text);
  }

  // Delete text
  deleteText(index: number, length: number): void {
    this.ytext.delete(index, length);
  }

  // Get current users
  getUsers(): Map<string, CollabUser> {
    const users = new Map<string, any>();
    const states = this.awareness.getStates();
    
    for (const [clientId, state] of states.entries()) {
      if (state.user) {
        users.set(state.user.id || clientId, {
          id: state.user.id || clientId,
          name: state.user.name || "Unknown",
          color: state.user.color || this.generateColor(),
          cursor: state.user.cursor,
          lastActive: state.user.lastActive || Date.now(),
          isOnline: true
        });
      }
    }
    return users;
  }

  // Update local cursor position
  updateCursor(position: number, selection?: { start: number; end: number }): void {
    this.awareness.setLocalStateField("user", {
      ...this.awareness.getLocalState()?.user,
      cursor: { position, selection },
      lastActive: Date.now()
    });
  }

  // Update user presence
  setUserStatus(status: "active" | "away" | "busy"): void {
    this.awareness.setLocalStateField("user", {
      ...this.awareness.getLocalState()?.user,
      status,
      lastActive: Date.now()
    });
  }

  // Get document content as string
  getContent(): string {
    return this.doc.getText("content").toString();
  }

  // Get document as Uint8Array for sync
  getStateVector(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  // Apply remote update
  applyUpdate(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update);
  }

  // Get state vector for sync
  getStateVector(): Uint8Array {
    return Y.encodeStateVector(this.doc);
  }

  // Conflict resolution for concurrent edits
  resolveConflicts(localChanges: any[], remoteChanges: any[]): any[] {
    // Yjs handles conflicts automatically via CRDT
    // This is for application-level conflict resolution if needed
    return localChanges;
  }

  // User presence
  updatePresence(data: Partial<CollabUser>): void {
    this.awareness.setLocalStateField("user", {
      ...this.awareness.getLocalState()?.user,
      ...data,
      lastActive: Date.now()
    });
  }

  // Set user cursor position
  setCursor(position: number, selection?: { start: number; end: number }): void {
    this.awareness.setLocalStateField("user", {
      ...this.awareness.getLocalState()?.user,
      cursor: { position: data.position, selection: data.selection },
      lastActive: Date.now()
    });
  }

  // Get all connected users
  getUsers(): Map<string, CollabUser> {
    const users = new Map<string, any>();
    const states = this.awareness.getStates();
    
    for (const [clientId, state] of states.entries()) {
      if (state.user) {
        users.set(state.user.id, {
          id: state.user.id,
          name: state.user.name,
          color: state.user.color,
          cursor: state.user.cursor,
          lastActive: state.user.lastActive,
          isOnline: true
        });
      }
    }
    return users;
  }

  // Get document content
  getContent(): string {
    return this.doc.getText("content").toString();
  }

  // Set content (replace all)
  setContent(content: string): void {
    this.doc.transact(() => {
      this.ytext.delete(0, this.ytext.length);
      this.ytext.insert(0, content);
    });
  }

  // Insert text at position
  insertText(index: number, text: string): void {
    this.ytext.insert(index, text);
  }

  // Delete text
  deleteText(index: number, length: number): void {
    this.ytext.delete(index, length);
  }

  // Subscribe to content changes
  onContentChange(callback: (content: string) => void): () => void {
    const handler = () => callback(this.getContent());
    this.ytext.observe(handler);
    return () => this.ytext.unobserve(handler);
  }

  // Subscribe to remote changes
  onRemoteChange(callback: (update: Uint8Array) => void): () => void {
    const handler = (update: Uint8Array) => callback(update);
    this.doc.on("update", handler);
    return () => this.doc.off("update", handler);
  }

  // Awareness events
  onAwarenessChange(callback: (users: Map<string, any>) => void): () => void {
    const handler = () => callback(this.awareness.getStates());
    this.awareness.on("change", handler);
    return () => this.awareness.off("change", handler);
  }

  // User presence
  setUserStatus(status: "active" | "away" | "busy" | "offline"): void {
    this.awareness.setLocalStateField("user", {
      ...this.awareness.getLocalState()?.user,
      status,
      lastActive: Date.now()
    });
  }

  // Set cursor position with optional selection
  setCursor(position: number, selection?: { start: number; end: number }): void {
    this.awareness.setLocalStateField("user", {
      ...this.awareness.getLocalState()?.user,
      cursor: { position, selection },
      lastActive: Date.now()
    });
  }

  // Get all connected users
  getUsers(): CollabUser[] {
    const users: CollabUser[] = [];
    const states = this.awareness.getStates();
    
    for (const [clientId, state] of states.entries()) {
      if (state.user) {
        users.push({
          id: state.user.id,
          name: state.user.name,
          color: state.user.color,
          cursor: state.user.cursor,
          lastActive: state.user.lastActive,
          isOnline: Date.now() - state.user.lastActive < 30000
        });
      }
    }
    return users;
  }

  // Get current user info
  getCurrentUser(): CollabUser {
    const state = this.awareness.getLocalState();
    return state.user ? {
      id: state.user.id,
      name: state.user.name,
      color: state.user.color,
      cursor: state.user.cursor,
      lastActive: state.user.lastActive,
      isOnline: true
    } : {
      id: this.userId,
      name: this.userName,
      color: this.generateColor(),
      lastActive: Date.now(),
      isOnline: true
    };
  }

  // Export document state for saving
  exportState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  // Import document state
  loadState(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update);
  }

  // Get state vector for sync
  getStateVector(): Uint8Array {
    return Y.encodeStateVector(this.doc);
  }

  // Apply remote update
  applyUpdate(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update);
  }

  // Get state vector for sync
  getStateVector(): Uint8Array {
    return Y.encodeStateVector(this.doc);
  }

  // Disconnect
  disconnect(): void {
    if (this.provider) {
      this.provider.disconnect();
      this.provider.destroy();
    }
    if (this.persistence) {
      this.persistence.destroy();
    }
    this.doc.destroy();
    this.emit("disconnected");
  }

  // Check connection status
  isConnected(): boolean {
    return this.connected;
  }

  isSynced(): boolean {
    return this.synced;
  }

  // Generate user color
  private generateColor(): string {
    const colors = [
      "#FF6B6B", "#4ECDC4", "#45B7D1", "#FFBE0B", "#FB5607",
      "#8338EC", "#3A86FF", "#FF006E", "#06D6A0", "#FF9F1C"
    ];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  // Clean up
  destroy(): void {
    this.disconnect();
    this.removeAllListeners();
  }
}

// Collaborative editing session manager
export class CollabSessionManager {
  private sessions = new Map<string, CollabManager>();
  private userId: string;
  private userName: string;

  constructor(userId: string, userName: string) {
    this.userId = userId;
    this.userName = userName;
  }

  createSession(roomName: string, config: Partial<CollabConfig> = {}): CollabManager {
    const session = new CollabManager({
      roomName,
      userId: this.userId,
      userName: this.userName,
      ...config
    });
    
    this.sessions.set(roomName, session);
    return session;
  }

  getSession(roomName: string): CollabManager | undefined {
    return this.sessions.get(roomName);
  }

  closeSession(roomName: string): void {
    const session = this.sessions.get(roomName);
    if (session) {
      session.destroy();
      this.sessions.delete(roomName);
    }
  }

  getAllSessions(): CollabManager[] {
    return Array.from(this.sessions.values());
  }

  closeAll(): void {
    for (const session of this.sessions.values()) {
      session.destroy();
    }
    this.sessions.clear();
  }
}

export { CollabManager, CollabUser, CollabEvent, CollabDocument, CollabConfig };

// Utility: Generate consistent user color from ID
export function generateUserColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 50%)`;
}

// Utility: Create user presence object
export function createUserPresence(userId: string, name: string, color?: string) {
  return {
    id: userId,
    name,
    color: color || generateUserColor(userId),
    lastActive: Date.now(),
    isOnline: true
  };
}

export { Y } from "yjs";