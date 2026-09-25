/**
 * Symbol search and ranking for GoatCode.
 * Provides keyword-based find, hybrid search (keyword + semantic), and ranking.
 */

import type { IndexFile, Index } from "./indexer.ts";
import { semanticSearch } from "./semantic.ts";
import { VectorIndex } from "./semantic.ts";
import { getEmbeddingModel } from "./semantic.ts";

export interface SearchResult {
  file: string;
  symbols: Array<{ name: string; line: number; score: number; kind: string }>;
}

/** Check if q is a camel-case prefix of name (e.g. "usrInfo" matches "userInfo") */
function isCamelPrefix(name: string, q: string): boolean {
  // Only match if query has uppercase letters (camel case pattern like "usrInfo")
  if (!/[A-Z]/.test(q)) return false;
  let qi = 0;
  for (let ni = 0; ni < name.length && qi < q.length; ni++) {
    if (name[ni].toLowerCase() === q[qi].toLowerCase()) {
      qi++;
    }
  }
  return qi === q.length;
}

/** Rank symbols by relevance */
export function rankSymbols(
  symbols: Array<{ name: string; line: number; kind: string }>,
  query: string
): Array<{ name: string; line: number; score: number; kind: string }> {
  return symbols
    .map((s) => {
      let score = 0;
      const lowerName = s.name.toLowerCase();
      const lowerQuery = query.toLowerCase();

      // Exact match
      if (lowerName === lowerQuery) score += 100;
      // Contains match
      if (lowerName.includes(lowerQuery)) score += 50;
      // Prefix match
      if (lowerName.startsWith(lowerQuery)) score += 75;
      // Substring match
      if (lowerName.includes(lowerQuery)) score += 25;

      // Priority by kind
      if (s.kind.includes("function")) score += 10;
      if (s.kind.includes("class")) score += 8;
      if (s.kind.includes("variable")) score += 5;

      return { name: s.name, line: s.line, score, kind: s.kind };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Find symbols matching query across indexed files.
 * Returns ranked results sorted by relevance score.
 * Includes edge bonuses for graph-connected symbols.
 * All symbols are included in results (non-matching get score 0).
 */
export function findSymbols(
  index: Index,
  query: string,
  opts: { limit?: number; kind?: string } = {}
): Array<{ name: string; file: string; line: number; kind: string; score: number; heuristic?: boolean }> {
  const lowerQuery = query.toLowerCase();

  // Phase 1: Add ALL symbols to results (non-matching get score 0)
  const results: Array<{ name: string; file: string; line: number; kind: string; score: number; heuristic?: boolean }> = [];
  const resultIndex = new Map<string, number>(); // name -> index in results

  for (const [file, data] of Object.entries(index.files)) {
    for (const symbol of data.symbols) {
      const lowerName = symbol.name.toLowerCase();

      // Skip if kind filter doesn't match
      if (opts.kind && !symbol.kind.toLowerCase().includes(opts.kind.toLowerCase())) continue;

      let score = 0;
      // Exact match
      if (lowerName === lowerQuery) score += 10;
      // Prefix match
      else if (lowerName.startsWith(lowerQuery)) score += 6;
      // CamelCase prefix match (original case preserved)
      else if (isCamelPrefix(symbol.name, query)) score += 6;
      // Contains match
      else if (lowerName.includes(lowerQuery)) score += 3;

      const idx = results.length;
      results.push({
        name: symbol.name,
        file,
        line: symbol.line,
        kind: symbol.kind,
        score,
        heuristic: data.heuristic,
      });
      resultIndex.set(symbol.name.toLowerCase(), idx);
    }
  }

  // Phase 2: Add FILE_BONUS for files whose name matches query
  const filePathBonus = new Set<number>();
  for (const [file, data] of Object.entries(index.files)) {
    if (file.toLowerCase().includes(lowerQuery)) {
      for (let i = 0; i < results.length; i++) {
        if (results[i].file === file && !filePathBonus.has(i)) {
          results[i].score += 2;
          filePathBonus.add(i);
        }
      }
    }
  }

  // Phase 3: Edge bonuses for graph-connected symbols
  // Only direct partners of symbols with score >= 3 get +2 bonus
  for (const edge of index.edges) {
    const callerIdx = resultIndex.get(edge.caller.toLowerCase());
    const calleeIdx = resultIndex.get(edge.callee.toLowerCase());

    if (callerIdx !== undefined && calleeIdx !== undefined) {
      // If caller matches query well, give callee a small edge bonus
      if (results[callerIdx].score >= 3) {
        results[calleeIdx].score += 2;
      }
      // If callee matches query well, give caller a small edge bonus
      if (results[calleeIdx].score >= 3) {
        results[callerIdx].score += 2;
      }
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 20);
}

/**
 * Semantic search wrapper — builds vector index from files if missing,
 * then returns top-k semantically relevant files with their symbols.
 */
export async function semanticFind(
  index: Index,
  query: string,
  opts: { limit?: number } = {}
): Promise<Array<{ file: string; score: number; symbols: Array<{ name: string; line: number; score: number }> }>> {
  // Ensure vectorIndex exists
  if (!index.vectorIndex) {
    index.vectorIndex = new VectorIndex();
    await buildVectorIndex(index);
  }

  return semanticSearch(query, index.vectorIndex, opts.limit ?? 10);
}

/** Build semantic vectors for all indexed files */
export async function buildVectorIndex(index: Index): Promise<void> {
  const model = getEmbeddingModel();
  const vi = new VectorIndex();

  for (const [file, data] of Object.entries(index.files)) {
    // Use first 200 chars of file content as embedding source
    const content = `${data.repo}/${file} ${data.symbols.map((s) => s.name).join(" ")}`;
    const vector = await model.embed(content.slice(0, 500));
    vi.add(file, vector, { repo: data.repo });
  }

  index.vectorIndex = vi;
}

/** Hybrid search: keyword + semantic fusion using Reciprocal Rank Fusion */
export async function hybridSearch(
  query: string,
  index: Index,
  topK: number = 20
): Promise<SearchResult[]> {
  // Keyword search
  const keywordResults: SearchResult[] = [];
  const kwSymbols = findSymbols(index, query, { limit: 50 });
  const fileMap = new Map<string, Array<{ name: string; line: number; score: number; kind: string }>>();
  for (const r of kwSymbols) {
    if (!fileMap.has(r.file)) fileMap.set(r.file, []);
    fileMap.get(r.file)!.push({ name: r.name, line: r.line, score: r.score, kind: r.kind });
  }
  let kwRank = 0;
  for (const file of fileMap.keys()) {
    kwRank++;
    keywordResults.push({
      file,
      symbols: fileMap.get(file)!,
    });
  }

  // Semantic search
  let semanticResults: Array<{ file: string; score: number }> = [];
  try {
    const model = getEmbeddingModel();
    await model.initialize();
    if (!index.vectorIndex) {
      index.vectorIndex = new VectorIndex();
      await buildVectorIndex(index);
    }
    const queryVector = await model.embed(query.slice(0, 500));
    semanticResults = index.vectorIndex.search(queryVector, 10);
  } catch {
    // Semantic unavailable — return keyword-only results
  }

  // Combine with Reciprocal Rank Fusion (k=60)
  const fused: Map<string, { score: number; symbols: Array<{ name: string; line: number; score: number; kind: string }> }> = new Map();

  // Keyword scores
  for (let i = 0; i < keywordResults.length; i++) {
    const result = keywordResults[i];
    const rank = i + 1;
    const keyScore = 1 / (60 + rank);
    if (!fused.has(result.file)) fused.set(result.file, { score: 0, symbols: [] });
    fused.get(result.file)!.score += keyScore;
    fused.get(result.file)!.symbols.push(...result.symbols);
  }

  // Semantic scores
  for (let i = 0; i < semanticResults.length; i++) {
    const r = semanticResults[i];
    const rank = i + 1;
    const semScore = r.score / (60 + rank);
    if (!fused.has(r.file)) fused.set(r.file, { score: 0, symbols: [] });
    fused.get(r.file)!.score += semScore;
    // Append semantic-only file entries
    if (fused.get(r.file)!.symbols.length === 0) {
      fused.get(r.file)!.symbols.push({ name: r.file, line: 0, score: r.score, kind: "file" });
    }
  }

  // Sort by fused score, take topK
  const final = [...fused.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, topK)
    .map(([file, data]) => ({ file, symbols: data.symbols }));

  return final;
}
