/**
 * Model price table — USD per 1M tokens (input, output).
 * Patterns match against the model id, case-insensitive; first match wins,
 * so put the most specific patterns first. Unknown models cost $0 with an
 * "(no price known)" note rather than a made-up number.
 */
export interface Price {
  in: number;
  out: number;
}

const PRICE_PATTERNS: [RegExp, Price][] = [
  // Anthropic
  [/opus/, { in: 15, out: 75 }],
  [/sonnet/, { in: 3, out: 15 }],
  [/haiku/, { in: 0.8, out: 4 }],
  // OpenAI
  [/gpt-4\.1\b/, { in: 2, out: 8 }],
  [/gpt-5\b/, { in: 1.25, out: 10 }],
  [/o[134]-?mini/, { in: 1.1, out: 4.4 }],
  [/gpt-4o/, { in: 2.5, out: 10 }],
  [/gpt-4o-mini|gpt-4\.1-nano/, { in: 0.15, out: 0.6 }],
  // Google
  [/gemini.*flash/, { in: 0.3, out: 2.5 }],
  [/gemini.*pro/, { in: 1.25, out: 10 }],
  // DeepSeek
  [/deepseek.*(chat|v3)/, { in: 0.27, out: 1.1 }],
  [/deepseek.*reasoner|deepseek-r1/, { in: 0.55, out: 2.19 }],
  // Meta / Llama
  [/llama-?3\.3-70b|llama-3\.1-70b/, { in: 0.59, out: 0.79 }],
  [/llama-?4|llama-3\.[12]-405b/, { in: 2, out: 5 }],
  // Mistral
  [/mistral-large/, { in: 2, out: 6 }],
  [/mistral|devstral/, { in: 0.4, out: 2 }],
  // Qwen
  [/qwen.*(235b|max)/, { in: 1.6, out: 6.4 }],
  [/qwen/, { in: 0.23, out: 0.92 }],
];

export function priceFor(model: string): Price | null {
  const m = model.toLowerCase();
  for (const [re, p] of PRICE_PATTERNS) if (re.test(m)) return p;
  return null;
}

/** Estimated USD spend for token counts, e.g. costUsd("anthropic/claude-sonnet-4-5", 120000, 3400). */
export function costUsd(model: string, inTok: number, outTok: number): number | null {
  const p = priceFor(model);
  if (!p) return null;
  return (inTok / 1_000_000) * p.in + (outTok / 1_000_000) * p.out;
}

export function fmtUsd(n: number): string {
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}
