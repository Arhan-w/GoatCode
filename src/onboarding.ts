/**
 * First-run wizard for GoatCode v3.2.
 *
 * Guides new users through provider selection, model choice,
 * and optional configuration on first launch.
 * Runs before the TUI starts (pure stdio, no Ink).
 */
import { loadConfig, saveConfig, splitModel, type GoatConfig } from "./config.ts";
import { join } from "node:path";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";

const PROVIDERS = [
  { id: "claude", label: "Claude AI (anthropic)", defaultModel: "claude-sonnet-4-5" },
  { id: "openai", label: "OpenAI", defaultModel: "gpt-5-codex" },
  { id: "google", label: "Google Gemini", defaultModel: "gemini-2.5-pro" },
  { id: "goated-flash", label: "Goated Flash (free, no key)", defaultModel: "goated-1-flash" },
];

const MODELS: Record<string, string[]> = {
  claude: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"],
  openai: ["gpt-5-codex", "gpt-4o"],
  google: ["gemini-2.5-pro", "gemini-1.5-flash"],
  "goated-flash": ["goated-1-flash"],
};

async function prompt(text: string): Promise<string> {
  process.stdout.write(`${text} `);
  for await (const chunk of process.stdin) {
    const s = (chunk as Buffer).toString("utf8");
    const nl = s.indexOf("\n");
    if (nl >= 0) return s.slice(0, nl).trim();
  }
  return "";
}

async function pick(
  title: string,
  items: Array<{ label: string; value: string }>,
): Promise<string | null> {
  console.log(`\n${title}`);
  console.log("-".repeat(40));
  for (let i = 0; i < items.length; i++) {
    console.log(`  ${i + 1}. ${items[i].label}`);
  }
  console.log(`  ${items.length + 1}. skip`);
  const raw = (await prompt("goat> ")).trim();
  const n = parseInt(raw, 10);
  if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1].value;
  return null; // skip
}

/**
 * Run the first-run wizard if it hasn't been run yet.
 * Returns true if the wizard ran (and may have skipped or completed),
 * false if onboarding was already done.
 */
export async function runFirstRunWizard(): Promise<boolean> {
  const cfg = loadConfig();

  // Check if we've already been through onboarding
  if (cfg.onboardingComplete) return false;

  console.log("\x1b[2J\x1b[H\x1b[3J");
  console.log("");
  console.log("  \x1b[35m████████████████████████████████\x1b[39m");
  console.log("  \x1b[35m  Welcome to GoatCode v3.2  \x1b[39m");
  console.log("  \x1b[35m████████████████████████████████\x1b[39m");
  console.log("");
  console.log("  Every provider. One terminal. Agentic coding CLI.");
  console.log("  Let's get you set up in just a few steps.");
  console.log("");
  console.log("  Press Enter to continue, Ctrl+C to abort.");
  console.log("");

  const start = await prompt("");
  if (start === "") { /* proceed */ } else { return false; }

  // Step 1: Provider
  const providerItems = PROVIDERS.map((p) => ({
    label: p.label,
    value: p.id,
  }));
  const provider = (await pick("Step 1: Select provider", providerItems)) ?? "claude";

  // Step 2: Model
  const models = MODELS[provider] ?? [PROVIDERS.find((p) => p.id === provider)?.defaultModel ?? "custom"];
  const modelItems = models.map((m) => ({
    label: `${provider}/${m}`,
    value: `${provider}/${m}`,
  }));
  const model = (await pick("Step 2: Select model", modelItems)) ?? `${provider}/${models[0]}`;

  // Step 3: Name (optional)
  const name = await prompt("Step 3: Your display name (optional, press Enter to skip): ");

  // Step 4: Auth hint
  console.log("");
  console.log("  Final step: make sure you have credentials for your provider.");
  console.log(`  Example: goat auth ${provider} --key YOUR_KEY_HERE`);
  console.log("  Or use OAuth: goat auth ${provider} --oauth");
  console.log("");
  await prompt("Press Enter when ready to start: ");

  // Save config
  const updated = { ...cfg };
  updated.model = model;
  updated.provider = provider;
  updated.onboardingComplete = true;
  if (name) {
    updated.raw = updated.raw ?? {};
    updated.raw.userName = name;
  }
  saveConfig(updated);
  splitModel(updated);

  // Create GOAT.md if it doesn't exist
  const goatPath = join(process.cwd(), "GOAT.md");
  if (!existsSync(goatPath)) {
    try {
      mkdirSync(join(process.cwd(), ".goatcode"), { recursive: true });
      writeFileSync(goatPath, "# Project Memory\n\nStart building!\n", "utf8");
    } catch { /* best-effort */ }
  }

  console.log("\x1b[2J\x1b[H\x1b[3J");
  return true;
}

/**
 * Quick check: should we show the onboarding wizard?
 */
export function shouldShowOnboarding(): boolean {
  try {
    const cfg = loadConfig();
    return !cfg.onboardingComplete;
  } catch {
    return true;
  }
}
