# GoatCode v3 Development Plan

## Vision
Transform GoatCode into a code intelligence platform: multi-repo semantic understanding, real-time collaborative sessions, agent-to-agent protocol, and plugin marketplace — all in one binary.

## Three Pillars

**A. Multi-Repo Workspace + Semantic Code Graph**
- Workspace = multiple git repos
- Tree-sitter parsers → AST → call graph + embeddings
- `/find "auth flow"` → semantic results across repos
- Cross-repo refactors, `/rewind` across repos
- Incremental indexing (~200ms/query)

**B. Real-time Collab (P2P)**
- `goat share` → WebRTC URL, peer joins same session
- Same transcript, tools, context, cursors visible
- CRDT for concurrent edits (Yjs)
- `/handoff @peer` transfers turn ownership
- No central server

**C. Agent Protocol + Plugin Marketplace**
- `goat://` protocol: agents discover/call each other
- `goat install-plugin @org/name` — signed, WASM-sandboxed
- In-terminal marketplace (`/plugins browse`)
- Plugin SDK: Rust/TS/Go, capability manifest, sandbox

## Architecture
- Single binary, feature flags at runtime
- No external deps: P2P via WebRTC, indexing via Tree-sitter WASM, CRDT via Yrs
- Terminal-first: slash commands + TUI
- Backward compatible: v2 sessions load in v3

## Tech Stack Additions
- tree-sitter + grammars (WASM)
- yjs/yrs (CRDT) + webrtc (data channels)
- wasmtime (plugin sandbox)
- tokio-tungstenite (WebRTC signaling)
- semver + ed25519-dalek (plugin signing)

## Phases
**Phase 0: Foundation (weeks 1-3)** - Workspace config, Tree-sitter WASM, indexer skeleton, CRDT+WebRTC scaffolding, wasmtime sandbox
**Phase 1: Semantic Layer (weeks 4-8)** - Per-language indexers, call graph + embeddings, `/find` UI, cross-repo refactor
**Phase 2: Collab (weeks 9-14)** - WebRTC data channel, Yjs doc model, cursor presence, `/share`, `/handoff`
**Phase 3: Agent Protocol + Marketplace (weeks 15-22)** - goat:// protocol, capability negotiation, wasmtime sandbox, marketplace TUI
**Phase 4: Polish + Ship (weeks 23-26)** - Perf tuning, stress tests, docs, v3.0.0 release

## Success Metrics
- `/find` <200ms on 500k LOC
- 5-peer join <2s, zero conflicts
- Plugin install+load <500ms
- Binary ≤120MB