/**
 * Semantic embeddings pipeline for GoatCode.
 * Uses ONNX runtime with local MiniLM-L6-v2 (384-dim) for zero-API-cost embeddings.
 */

import { createHash } from "node:crypto";

/** Embedding vector */
export interface Vector {
  dimensions: number;
  data: Float32Array;
}

/** Semantic search result */
export interface SemanticResult {
  file: string;
  score: number;
  symbols: Array<{ name: string; line: number; score: number }>;
}

/** Local embedding model using ONNX runtime */
export class LocalEmbeddingModel {
  private model: any = null;
  private tokenizer: any = null;
  private readonly dimensions = 384; // MiniLM-L6-v2
  private initialized = false;

  /** Lazy initialization */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Try ONNX runtime + transformers
      const ort = await import("onnxruntime-node");
      const { pipeline } = await import("@xenova/transformers");

      this.model = await pipeline("feature-extraction", {
        model: "Xenova/MiniLM-L6-v2",
        quantized: true,
      });
      this.initialized = true;
    } catch (e) {
      console.warn("ONNX/transformers not available, using hash fallback:", e);
      // Fall through to hash-based fallback
    }
  }

  /** Generate embedding for text (returns normalized vector) */
  async embed(text: string): Promise<Vector> {
    if (!this.initialized) {
      await this.initialize();
    }

    if (this.model) {
      try {
        const output = await this.model(text, { pooling: "mean", normalize: true });
        const data = new Float32Array(output.data);
        return { dimensions: this.dimensions, data };
      } catch {
        // Fall through to hash fallback
      }
    }

    // Hash-based fallback embedding
    return this.hashEmbed(text);
  }

  /** Hash-based embedding fallback (no dependencies) */
  private hashEmbed(text: string): Vector {
    const hash = createHash("sha256").update(text).digest();
    const data = new Float32Array(this.dimensions);

    for (let i = 0; i < this.dimensions; i++) {
      data[i] = (hash[i % 32] / 255) * 2 - 1; // map to [-1, 1]
    }

    // L2 normalize
    let sumSq = 0;
    for (let i = 0; i < this.dimensions; i++) {
      sumSq += data[i] * data[i];
    }
    const norm = Math.sqrt(sumSq);
    if (norm > 0) {
      for (let i = 0; i < this.dimensions; i++) {
        data[i] /= norm;
      }
    }

    return { dimensions: this.dimensions, data };
  }
}

/** Vector index for semantic search */
export class VectorIndex {
  private vectors: Map<string, Vector> = new Map();
  private metadata: Map<string, any> = new Map();

  /** Add a vector with optional metadata */
  add(file: string, vector: Vector, metadata?: any): void {
    this.vectors.set(file, vector);
    this.metadata.set(file, metadata ?? {});
  }

  /** Remove a vector */
  remove(file: string): void {
    this.vectors.delete(file);
    this.metadata.delete(file);
  }

  /** Search for similar vectors */
  search(queryVector: Vector, topK: number = 10): Array<{ file: string; score: number }> {
    const scores: Array<{ file: string; score: number }> = [];

    for (const [file, vec] of this.vectors) {
      const score = cosineSimilarity(queryVector, vec);
      scores.push({ file, score });
    }

    return scores.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  /** Get metadata for a file */
  getMetadata(file: string): any {
    return this.metadata.get(file);
  }

  /** Clear all vectors */
  clear(): void {
    this.vectors.clear();
    this.metadata.clear();
  }

  get size(): number {
    return this.vectors.size;
  }
}

/** Cosine similarity between two vectors */
export function cosineSimilarity(a: Vector, b: Vector): number {
  if (a.dimensions !== b.dimensions) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.dimensions; i++) {
    dot += a.data[i] * b.data[i];
    magA += a.data[i] * a.data[i];
    magB += b.data[i] * b.data[i];
  }

  const norm = Math.sqrt(magA) * Math.sqrt(magB);
  return norm === 0 ? 0 : dot / norm;
}

/** Global embedding model instance */
let globalModel: LocalEmbeddingModel | null = null;

/** Get or create the global embedding model */
export function getEmbeddingModel(): LocalEmbeddingModel {
  if (!globalModel) {
    globalModel = new LocalEmbeddingModel();
  }
  return globalModel;
}

/**
 * Index codebase into vector index for semantic search.
 * Builds embeddings for all indexed files using the embedding model.
 */
export async function indexCodebase(
  roots: Map<string, string>,
  onProgress?: (p: { done: number; total: number }) => void,
): Promise<void> {
  const model = getEmbeddingModel();
  await model.initialize();
  const vi = new VectorIndex();

  // Gather all source files
  const candidates: Array<{ key: string; content: string }> = [];
  for (const [repo, root] of roots) {
    walkRoot(root, (abs, rel) => {
      const i = rel.lastIndexOf(".");
      if (i < 0) return;
      const ext = rel.slice(i + 1).toLowerCase();
      const supportedExts = ["ts", "tsx", "js", "jsx", "py", "go", "rs", "java", "c", "cpp", "h", "hpp", "swift", "kt", "rb", "php", "cs"];
      if (!supportedExts.includes(ext)) return;
      try {
        const buf = readFileSync(abs, "utf8");
        if (buf.length > 5000) return; // skip large files
        candidates.push({ key: `${repo}/${rel}`, content: buf });
      } catch { /* skip unreadable */ }
    });
  }

  const total = candidates.length;
  for (let i = 0; i < candidates.length; i++) {
    const { key, content } = candidates[i];
    const text = `${key}\n${content}`.slice(0, 500);
    try {
      const vector = await model.embed(text);
      vi.add(key, vector, { repo: key.split("/")[0] });
    } catch { /* skip on embed failure */ }
    if (onProgress && i % 50 === 0) {
      onProgress({ done: i, total });
    }
  }

  globalVectorIndex = vi;
}

/** Global vector index for semantic search across sessions */
let globalVectorIndex: VectorIndex | null = null;

/** Get or create the global vector index */
export function getVectorIndex(): VectorIndex {
  if (!globalVectorIndex) {
    globalVectorIndex = new VectorIndex();
  }
  return globalVectorIndex;
}

/** Semantic search across indexed files */
export async function semanticSearch(
  query: string,
  index: VectorIndex,
  topK: number = 10
): Promise<SemanticResult[]> {
  const model = getEmbeddingModel();
  const queryVector = await model.embed(query);
  const results = index.search(queryVector, topK);

  return results.map((r) => ({
    file: r.file,
    score: r.score,
    symbols: [],
  }));
}

/** Walk directory recursively (same as indexer.ts walkRoot) */
import { readFileSync, readdirSync } from "node:fs";
function walkRoot(root: string, onFile: (abs: string, rel: string) => void): void {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === ".git") continue;
      walkRoot(`${root}/${e.name}`, onFile);
    } else if (e.isFile()) {
      onFile(`${root}/${e.name}`, `${root}/${e.name}`.replace(root, ""));
    }
  }
}
