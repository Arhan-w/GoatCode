/**
 * Model context windows + a true usage meter. The footer meter prefers the
 * REAL prompt-token count reported by the last API response (what the model
 * actually saw, incl. system+tools) over any char estimate.
 */

/** Approximate context window (tokens) for a model id. Config `context_window` overrides. */
export function contextWindow(modelId: string): number {
  const m = modelId.toLowerCase();
  if (/gemini/.test(m)) return 1_000_000;
  if (/gpt-5|codex/.test(m)) return 400_000;
  if (/gpt-4\.1|o[134]\b/.test(m)) return 128_000;
  if (/claude/.test(m)) return 200_000;
  if (/deepseek/.test(m)) return 128_000;
  if (/qwen2\.5|qwen-?2\.5/.test(m)) return 128_000;
  if (/grok/.test(m)) return 128_000;
  if (/llama-?4/.test(m)) return 1_000_000;
  if (/llama/.test(m)) return 128_000;
  if (/mistral|devstral/.test(m)) return 128_000;
  return 128_000;
}

/**
 * 0-1 fraction of the context window used, from the last real API usage if
 * present (prompt tokens include cached blocks), else null (caller estimates).
 */
export function contextPct(modelId: string, lastPromptTokens: number, windowOverride?: number): number | null {
  if (!lastPromptTokens) return null;
  const win = windowOverride && windowOverride > 0 ? windowOverride : contextWindow(modelId);
  return Math.min(1, lastPromptTokens / win);
}
