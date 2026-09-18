# GoatCode v3 Upgrade Plan

## Phase 1: Code Intelligence with Semantic Embeddings
- Replace heuristic search with semantic embeddings using sentence-transformers + FAISS
- Add vector database for code search
- Implement hybrid search (keyword + semantic)

## Phase 2: Agent Loop Enhancement
- ReAct/Plan-and-Execute reasoning
- Tool result summarization
- Structured reasoning traces

## Phase 3: Session Management
- SQLite-based session DB
- Searchable history with full-text search
- Session branching and snapshots
- Session replay/rewind

## Phase 4: Skills System
- Plugin API with sandboxed WASM
- Hot-reload capability
- Marketplace infrastructure

## Phase 5: MCP Enhancement
- Full stdio/HTTP transport
- Auth (OAuth, API keys)
- Resource subscriptions

## Phase 6: Collab
- CRDT-based sync (Yjs)
- Real-time presence
- Conflict resolution

## Phase 8: UI Improvements
- Syntax highlighting in terminal
- Better diff rendering
- Spinner states

Let me start implementing these systematically.

## Phase 1: Code Intelligence with Semantic Embeddings
- Add sentence-transformers for embeddings
- FAISS vector index for code search
- Hybrid search (keyword + semantic)
- Incremental embedding updates

Let me start implementingNow I'll start implementing the upgrades systematically. Let me begin with Phase 1 - Code Intelligence with Semantic Embeddings.
<tool_call>
<function=write_file>
<parameter=content>
/**
 * Semantic Code Intelligence - Vector-based semantic search for code
 * Uses sentence-transformers embeddings + FAISS for semantic code search
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createHash } from "node:crypto";
import { appDir } from "../config.ts";
import { SKIP_DIRS } from "../tools.ts";
import { extractFile, type ParserLike } from "./extract.ts";

const EMBEDDING_DIM = 384; // MiniLM-L6-v2 dimension
const MAX_INDEX_FILE_BYTES = 1_000_000;
const BATCH_SIZE = 200;

export interface VectorIndexFile {
  repo: string;
  hash: string;
  mtime: number;
  size: number;
  symbols: { name: string; kind: string; line: number }[];
  imports: string[];
  heuristic?: true;
  embedding?: number[]; // semantic embedding vector
  content: string; // original content for context
}

export interface VectorIndexEdge {
  caller: string;
  callee: string;
  repo: string;
  file: string;
  line: number;
}

export interface VectorIndex {
  files: Record<string, VectorIndexFile>;
  edges: Map<string, VectorIndexEdge[]>;
}

export interface VectorIndexProgress {
  done: number;
  total: number;
  files: number;
  symbols: number;
  heuristic: number;
}

export interface VectorIndexSummary {
  files: number;
  symbols: number;
  edges: number;
  heuristicFiles: number;
  ms: number;
  indexPath: string;
}

const MAX_INDEX_FILE_BYTES = 1_000_000;
const BATCH_SIZE = 200;
const EMBEDDING_BATCH_SIZE = 32;

interface EmbeddingModel {
  embed(texts: string[]): Promise<number[][]>;
  dimension: number;
}

// ONNX Runtime based embedding model (runs locally, no external API)
class LocalEmbeddingModel implements EmbeddingModel {
  private session: any = null;
  private tokenizer: any = null;
  public dimension = EMBEDDING_DIM;

  async initialize(): Promise<void> {
    // Dynamic import to avoid requiring onnxruntime as hard dependency
    try {
      const ort = await import("onnxruntime-node");
      const tokenizer = await import("@xenova/transformers");
      
      // Load MiniLM-L6-v2 model (384 dim, fast, good quality)
      this.session = await ort.InferenceSession.create(
        new URL("https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx").href,
        { executionProviders: ["cpu"] }
      );
      
      this.tokenizer = await tokenizer.AutoTokenizer.from_pretrained("Xenova/all-MiniLM-L6-v2");
      console.log("Embedding model loaded successfully");
    } catch (error) {
      console.warn("Could not load embedding model, falling back to heuristic:", error);
      throw error;
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.session || !this.tokenizer) {
      await this.initialize();
    }

    if (!this.session) {
      throw new Error("Embedding model not available");
    }

    // Tokenize all texts
    const encoded = await this.tokenizer(texts, {
      padding: true,
      truncation: true,
      max_length: 512,
      return_tensors: "np"
    });

    // Run inference
    const feeds = {
      input_ids: encoded.input_ids,
      attention_mask: encoded.attention_mask
    };

    const results = await this.session.run(null, feeds);
    const embeddings = results.last_hidden_state; // [batch, seq_len, hidden]

    // Mean pooling
    const embeddings_list: number[][] = [];
    for (let i = 0; i < texts.length; i++) {
      const mask = encoded.attention_mask[i];
      const emb = embeddings[i];
      let sum = new Float32Array(384);
      let count = 0;
      
      for (let j = 0; j < mask.length; j++) {
        if (mask[j] === 1) {
          for (let k = 0; k < 384; k++) {
            sum[k] += emb[j][k];
          }
          count++;
        }
      }
      
      for (let k = 0; k < 384; k++) {
        sum[k] /= count;
      }
      
      // Normalize
      let norm = 0;
      for (let k = 0; k < 384; k++) norm += sum[k] * sum[k];
      norm = Math.sqrt(norm);
      for (let k = 0; k < 384; k++) sum[k] /= norm;
      
      embeddings_list.push(Array.from(sum));
    }

    return embeddings_list;
  }

  dimension = EMBEDDING_DIM;
}

// FAISS-like vector index using simple array-based search (can be replaced with real FAISS)
class VectorIndex {
  private vectors: Float32Array[] = [];
  private ids: string[] = [];
  private metadata: Map<string, any> = new Map();

  add(id: string, vector: number[], metadata: any): void {
    const vec = new Float32Array(vector);
    // Normalize
    let norm = 0;
    for (let i = 0; i < vector.length; i++) norm += vector[i] * vector[i];
    norm = Math.sqrt(norm);
    const normalized = new Float32Array(vector.length);
    for (let i = 0; i < vector.length; i++) {
      normalized[i] = vector[i] / Math.sqrt(norm);
    }
    
    this.vectors.push(normalized);
    this.ids.push(id);
    this.metadata.set(id, metadata);
  }

  search(queryVector: number[], k: number = 10): Array<{ id: string; score: number; metadata: any }> {
    // Normalize query
    let norm = 0;
    for (let i = 0; i < queryVector.length; i++) norm += queryVector[i] * queryVector[i];
    norm = Math.sqrt(norm);
    const normalized = queryVector.map(v => v / Math.sqrt(norm));

    const scores: Array<{ id: string; score: number }> = [];
    
    for (let i = 0; i < this.vectors.length; i++) {
      let dot = 0;
      const vec = this.vectors[i];
      for (let j = 0; j < queryVector.length; j++) {
        dot += queryVector[j] * vec[j];
      }
      scores.push({ id: this.ids[i], score: dot });
    }

    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, k).map(s => ({
      id: s.id,
      score: s.score,
      metadata: this.metadata.get(s.id)
    }));
  }

  size(): number {
    return this.ids.length;
  }

  clear(): void {
    this.vectors = [];
    this.ids = [];
    this.metadata.clear();
  }

  getMetadata(id: string): any {
    return this.metadata.get(id);
  }

  getAllIds(): string[] {
    return [...this.ids];
  }

  getVector(id: string): Float32Array | undefined {
    const idx = this.ids.indexOf(id);
    return idx >= 0 ? this.vectors[idx] : undefined;
  }
}

// Semantic code search combining keyword + semantic
export class SemanticCodeSearch {
  private embeddingModel: LocalEmbeddingModel;
  private vectorIndex: VectorIndex;
  private initialized = false;

  constructor() {
    this.embeddingModel = new LocalEmbeddingModel();
    this.vectorIndex = new VectorIndex();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      await this.embeddingModel.initialize();
      this.initialized = true;
      console.log("Semantic code search initialized");
    } catch (error) {
      console.warn("Semantic search unavailable, using heuristic only:", error);
      throw error;
    }
  }

  async indexCodebase(
    roots: Map<string, string>,
    onProgress?: (p: { done: number; total: number; message: string }) => void
  ): Promise<void> {
    if (!this.initialized) await this.initialize();
    
    // Collect all files
    const candidates: { key: string; repo: string; abs: string }[] = [];
    for (const [repo, root] of roots) {
      walkRoot(root, (abs, rel) => {
        const i = rel.lastIndexOf(".");
        if (i < 0) return;
        candidates.push({ key: `${repo}/${rel}`, repo, abs });
      });
    }

    const total = candidates.length;
    let done = 0;
    const texts: string[] = [];
    const ids: string[] = [];

    // Collect all file contents
    for (const { key, repo, abs } of candidates) {
      try {
        const st = statSync(abs);
        if (st.size > 100_000) continue; // Skip large files
        const buf = readFileSync(abs);
        if (isBinaryHead(new Uint8Array(readFileSync(abs).slice(0, 8192)))) continue;
        const content = readFileSync(abs, "utf8");
        
        // Create meaningful text for embedding: file path + symbols + content
        const text = `${relative(process.cwd(), abs)}\n${content.slice(0, 2000)}`;
        texts.push(text);
        ids.push(key);
      } catch { /* skip unreadable */ }
    }

    // Generate embeddings in batches
    console.log(`Generating embeddings for ${texts.length} files...`);
    const embeddings = await this.embeddingModel.embed(texts);
    
    // Add to vector index
    for (let i = 0; i < ids.length; i++) {
      this.vectorIndex.add(ids[i], embeddings[i], {
        repo: candidates[i].repo,
        path: candidates[i].abs
      });
    }

    console.log(`Indexed ${ids.length} files with semantic embeddings`);
  }

  async search(query: string, k: number = 10): Promise<Array<{ id: string; score: number; metadata: any }>> {
    if (!this.initialized) await this.initialize();
    
    const [queryEmbedding] = await this.embeddingModel.embed([query]);
    return this.vectorIndex.search(queryEmbedding, k);
  }

  hybridSearch(query: string, keywordResults: Array<{ file: string; line: number; text: string }>, k: number = 10): Array<{ file: string; line: number; text: string; score: number }> {
    // Combine keyword and semantic search
    const semanticResults = await this.search(query, k);
    const keywordMap = new Map<string, { file: string; line: number; text: string }>();
    
    for (const r of keywordResults) {
      keywordMap.set(r.file, r);
    }

    const combined = new Map<string, { file: string; line: number; text: string; score: number }>();
    
    // Add semantic results
    for (const r of semanticResults) {
      const meta = r.metadata;
      if (meta) {
        combined.set(meta.path, {
          file: meta.path,
          line: 0,
          text: "",
          score: r.score * 0.7 // semantic weight
        });
      }
    }

    // Add keyword results
    for (const r of keywordResults) {
      const existing = combined.get(r.file);
      if (existing) {
        existing.score += 0.3; // keyword weight
      } else {
        combined.set(r.file, { ...r, score: 0.3 });
      }
    }

    return Array.from(combined.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  size(): number {
    return this.vectorIndex.size();
  }
}

// Global instance
export const semanticSearch = new SemanticCodeSearch();

// Integration with existing incrementalIndex
export async function incrementalIndexWithEmbeddings(
  roots: Map<string, string>,
  onProgress?: (p: { done: number; total: number; message: string }) => void,
  opts: { force?: boolean; parserFactory?: (grammar: string) => Promise<any> } = {}
): Promise<any> {
  // First run traditional incremental index
  const { incrementalIndex } = await import("./indexer.ts");
  const result = await incrementalIndex(roots, onProgress, opts);
  
  // Then enhance with semantic embeddings
  try {
    await semanticSearch.indexCodebase(roots, (progress) => {
      if (onProgress) onProgress({
        done: progress.done,
        total: progress.total,
        message: `Indexing with embeddings: ${progress.done}/${progress.total}`
      });
    });
  } catch (error) {
    console.warn("Semantic indexing failed, using heuristic only:", error);
  }
  
  return {
    ...result,
    semanticSearch: true,
    vectorIndexSize: semanticSearch.size()
  };
}

export { EmbeddingModel, LocalEmbeddingModel, VectorIndex, SemanticCodeSearch };