/**
 * UI Components - Syntax highlighting, diff rendering, spinner states, enhanced TUI
 */

import { Effect, Layer } from "effect";
import * as ansi from "ansi-colors";
import * as diff from "diff";
import { highlight } from "cli-highlight";

export interface SpinnerOptions {
  frames?: string[];
  interval?: number;
  text?: string;
  color?: keyof typeof ansi;
}

export interface DiffOptions {
  contextLines?: number;
  ignoreWhitespace?: boolean;
  color?: boolean;
}

export interface HighlightOptions {
  language?: string;
  theme?: "dark" | "light";
  lineNumbers?: boolean;
}

// Spinner animation
export class Spinner {
  private frames: string[];
  private interval: number;
  private text: string;
  private color: keyof typeof ansi;
  private intervalId: NodeJS.Timeout | null = null;
  private currentFrame = 0;
  private message = "";

  constructor(options: SpinnerOptions = {}) {
    this.frames = options.frames || ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    this.interval = options.interval || 80;
    this.text = options.text || "";
    this.color = options.color || "cyan";
  }

  start(text?: string): void {
    if (text) this.text = text;
    this.currentFrame = 0;
    this.intervalId = setInterval(() => {
      this.currentFrame = (this.currentFrame + 1) % this.frames.length;
      this.render();
    }, this.interval);
    this.render();
  }

  stop(finalText?: string): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (finalText !== undefined) {
      this.text = finalText;
      this.render(true);
    } else {
      // Clear the line
      process.stdout.write("\r\x1b[K");
    }
  }

  succeed(text?: string): void {
    this.stop(ansi.green("✔") + (text ? ` ${text}` : ""));
  }

  fail(text?: string): void {
    this.stop(ansi.red("✖") + (text ? ` ${text}` : ""));
  }

  warn(text?: string): void {
    this.stop(ansi.yellow("⚠") + (text ? ` ${text}` : ""));
  }

  info(text?: string): void {
    this.stop(ansi.blue("ℹ") + (text ? ` ${text}` : ""));
  }

  private render(final = false): void {
    const frame = this.frames[this.currentFrame % this.frames.length];
    const color = (ansi as any)[this.color] || ansi.cyan;
    const prefix = final ? "" : color(frame);
    const text = this.text ? ` ${this.text}` : "";
    process.stdout.write(`\r${prefix}${text}`);
  }
}

// Progress bar
export class ProgressBar {
  private total: number;
  private current: number = 0;
  private width: number;
  private completeChar: string;
  private incompleteChar: string;
  private color: keyof typeof ansi;
  private label: string;
  private startTime: number = Date.now();

  constructor(options: {
    total: number;
    width?: number;
    completeChar?: string;
    incompleteChar?: string;
    color?: keyof typeof ansi;
    label?: string;
  }) {
    this.total = options.total;
    this.width = options.width || 40;
    this.completeChar = options.completeChar || "█";
    this.incompleteChar = options.incompleteChar || "░";
    this.color = options.color || "cyan";
    this.label = options.label || "";
  }

  tick(increment = 1): void {
    this.current = Math.min(this.current + increment, this.total);
    this.render();
  }

  setCurrent(value: number): void {
    this.current = Math.min(value, this.total);
    this.render();
  }

  finish(): void {
    this.current = this.total;
    this.render(true);
    console.log();
  }

  private render(final = false): void {
    const percent = this.total > 0 ? this.current / this.total : 0;
    const filled = Math.round(this.width * percent);
    const empty = this.width - filled;
    
    const color = (ansi as any)[this.color] || ansi.cyan;
    const bar = color(this.completeChar.repeat(filled)) + ansi.dim(this.incompleteChar.repeat(empty));
    const percentStr = (percent * 100).toFixed(1).padStart(5);
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const eta = this.current > 0 ? ((Date.now() - this.startTime) / this.current * (this.total - this.current) / 1000).toFixed(1) : "?";
    
    const label = this.label ? `${this.label} ` : "";
    const etaStr = final ? "" : ` ETA: ${eta}s`;
    const elapsedStr = ` ${elapsed}s`;
    
    process.stdout.write(`\r${label}[${bar}] ${percentStr}%${elapsedStr}${etaStr}`);
  }
}

// Syntax highlighting
export function highlightCode(code: string, language: string = "typescript", options: HighlightOptions = {}): string {
  try {
    return highlight(code, {
      language,
      theme: options.theme || "dark",
      lineNumbers: options.lineNumbers ?? false,
      ignoreIllegals: true
    });
  } catch {
    return code;
  }
}

// Highlight code blocks in text
export function highlightCodeBlocks(text: string, options: HighlightOptions = {}): string {
  return text.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
    const lang = lang || "text";
    const highlighted = highlightCode(code.trim(), lang, options);
    return `\n\`\`\`${lang}\n${highlighted}\n\`\`\`\n`;
  });
}

// Diff rendering
export function renderDiff(oldText: string, newText: string, options: DiffOptions = {}): string {
  const contextLines = options.contextLines ?? 3;
  const ignoreWhitespace = options.ignoreWhitespace ?? false;
  const color = options.color ?? true;

  const diff = diff.diffLines(oldText, newText, { ignoreWhitespace });
  
  let output = "";
  for (const part of diff) {
    const colorize = (text: string, color: string) => color ? (ansi as any)[color](text) : text;
    
    if (part.added) {
      for (const line of part.value.split("\n")) {
        if (line) output += ansi.green(`+ ${line}`) + "\n";
      }
    } else if (part.removed) {
      for (const line of part.value.split("\n")) {
        if (line) output += ansi.red(`- ${line}`) + "\n";
      }
    } else {
      for (const line of part.value.split("\n")) {
        if (line) output += ansi.dim(`  ${line}`) + "\n";
      }
    }
  }
  
  return output.trim();
}

// Unified diff format
export function unifiedDiff(oldText: string, newText: string, options: DiffOptions = {}): string {
  const diff = require("diff").createPatch("file", oldText, newText, "old", "new", {
    context: options.contextLines ?? 3
  });
  return diff;
}

// Side-by-side diff
export function sideBySideDiff(oldText: string, newText: string, options: DiffOptions = {}): string {
  const diff = require("diff").diffLines(oldText, newText, { ignoreWhitespace: options.ignoreWhitespace });
  
  const leftWidth = 60;
  const rightWidth = 60;
  let output = "";
  
  // Header
  output += "OLD".padEnd(62) + " | " + "NEW".padEnd(62) + "\n";
  output += "─".repeat(123) + "\n";
  
  let oldLines: string[] = [];
  let newLines: string[] = [];
  
  for (const part of require("diff").diffLines(oldText, newText)) {
    if (part.added) {
      for (const line of part.value.split("\n").filter(Boolean)) {
        newLines.push({ type: "added", text: line });
      }
    } else if (part.removed) {
      for (const line of part.value.split("\n").filter(Boolean)) {
        oldLines.push({ type: "removed", text: line });
      }
    } else {
      for (const line of part.value.split("\n").filter(Boolean)) {
        oldLines.push({ type: "context", text: line });
        newLines.push({ type: "context", text: line });
      }
    }
  }
  
  const maxLines = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLines; i++) {
    const oldLine = oldLines[i] || { type: "empty", text: "" };
    const newLine = newLines[i] || { type: "empty", text: "" };
    
    const oldText = oldLine.text.padEnd(leftWidth).slice(0, leftWidth);
    const newText = newLine.text.padEnd(rightWidth).slice(0, rightWidth);
    
    let oldColor = (s: string) => s;
    let newColor = (s: string) => s;
    
    if (oldLine.type === "removed") oldColor = ansi.red;
    else if (oldLine.type === "added") oldColor = ansi.green;
    else if (oldLine.type === "context") oldColor = ansi.dim;
    
    if (newLine.type === "added") newColor = ansi.green;
    else if (newLine.type === "removed") newColor = ansi.red;
    else if (newLine.type === "context") newColor = ansi.dim;
    
    output += oldColor(oldText) + " | " + newColor(newText) + "\n";
  }
  
  return output;
}

// Theme-aware syntax highlighting
export const themes = {
  dark: {
    keyword: ansi.cyan,
    string: ansi.green,
    comment: ansi.dim,
    number: ansi.yellow,
    function: ansi.blue,
    operator: ansi.magenta,
    punctuation: ansi.white,
    bracket: ansi.white
  },
  light: {
    keyword: ansi.blue,
    string: ansi.green,
    comment: ansi.dim,
    number: ansi.red,
    function: ansi.blue,
    operator: ansi.magenta,
    punctuation: ansi.black,
    bracket: ansi.black
  }
};

// Simple tokenizer for basic highlighting (when cli-highlight not available)
export function simpleHighlight(code: string, language: string = "typescript"): string {
  const keywords = [
    "const", "let", "var", "function", "return", "if", "else", "for", "while",
    "class", "interface", "type", "import", "export", "default", "async", "await",
    "try", "catch", "finally", "throw", "new", "this", "super", "extends",
    "implements", "interface", "enum", "namespace", "module", "declare"
  ];
  
  return code
    .replace(/\b(const|let|var|function|return|if|else|for|while|class|interface|type|import|export|default|async|await|try|catch|finally|throw|new|this|super|extends|implements|interface|enum|namespace|module|declare)\b/g, ansi.cyan("$&"))
    .replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, ansi.green("$&"))
    .replace(/\b(\d+\.?\d*)\b/g, ansi.yellow("$&"))
    .replace(/\/\/.*$/gm, ansi.dim("$&"))
    .replace(/\/\*[\s\S]*?\*\//g, ansi.dim("$&"));
}

// Terminal theme
export const terminalTheme = {
  dark: {
    background: "#1a1b26",
    foreground: "#c0caf5",
    cursor: "#c0caf5",
    selection: "#3b4261",
    black: "#15161e",
    red: "#f7768e",
    green: "#9ece6a",
    yellow: "#e0af68",
    blue: "#7aa2f7",
    magenta: "#bb9af7",
    cyan: "#7dcfff",
    white: "#c0caf5",
    brightBlack: "#414868",
    brightRed: "#f7768e",
    brightGreen: "#9ece6a",
    brightYellow: "#e0af68",
    brightBlue: "#7aa2f7",
    brightMagenta: "#bb9af7",
    brightCyan: "#7dcfff",
    brightWhite: "#c0caf5"
  },
  light: {
    background: "#ffffff",
    foreground: "#1a1b26",
    cursor: "#1a1b26",
    selection: "#c0caf5",
    black: "#15161e",
    red: "#f7768e",
    green: "#9ece6a",
    yellow: "#e0af68",
    blue: "#7aa2f7",
    magenta: "#bb9af7",
    cyan: "#7dcfff",
    white: "#a9b1d6",
    brightBlack: "#414868",
    brightRed: "#f7768e",
    brightGreen: "#9ece6a",
    brightYellow: "#e0af68",
    brightBlue: "#7aa2f7",
    brightMagenta: "#bb9af7",
    brightCyan: "#7dcfff",
    brightWhite: "#a9b1d6"
  }
};

export interface ThemeColors {
  background: string;
  foreground: string;
  cursor: string;
  selection: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

// Theme-aware color helpers
export function getThemeColors(theme: "dark" | "light" = "dark"): ThemeColors {
  return terminalTheme[theme];
}

// Status indicators
export const indicators = {
  success: ansi.green("✔"),
  error: ansi.red("✖"),
  warning: ansi.yellow("⚠"),
  info: ansi.blue("ℹ"),
  pending: ansi.cyan("◷"),
  running: ansi.cyan("◐"),
  done: ansi.green("✓"),
  failed: ansi.red("✗"),
  skipped: ansi.yellow("⊘"),
  question: ansi.blue("?"),
  arrow: ansi.cyan("→"),
  bullet: ansi.dim("•"),
  check: ansi.green("✓"),
  cross: ansi.red("✗"),
  arrowRight: ansi.cyan("→"),
  arrowLeft: ansi.cyan("←"),
  arrowUp: ansi.cyan("↑"),
  arrowDown: ansi.cyan("↓"),
  star: ansi.yellow("★"),
  heart: ansi.red("♥"),
  sparkle: ansi.magenta("✨"),
  gear: ansi.cyan("⚙"),
  rocket: ansi.yellow("🚀"),
  bug: ansi.red("🐛"),
  package: ansi.blue("📦"),
  folder: ansi.blue("📁"),
  file: ansi.white("📄"),
  search: ansi.blue("🔍"),
  lightning: ansi.yellow("⚡"),
  fire: ansi.red("🔥"),
  check: ansi.green("✓"),
  cross: ansi.red("✗")
};

// Box drawing characters
export const box = {
  topLeft: "┌",
  topRight: "┐",
  bottomLeft: "└",
  bottomRight: "┘",
  horizontal: "─",
  vertical: "│",
  topT: "┬",
  bottomT: "┴",
  leftT: "├",
  rightT: "┤",
  cross: "┼"
};

// Draw a box
export function drawBox(content: string[], options: { title?: string; padding?: number; borderColor?: keyof typeof ansi } = {}): string {
  const { title, padding = 1, borderColor = "cyan" } = options;
  const lines = content;
  const maxWidth = Math.max(...lines.map(l => l.length));
  const width = Math.max(maxWidth, (options.title?.length || 0)) + 2;
  
  const color = (ansi as any)[options.borderColor || "cyan"];
  const h = "─";
  const v = "│";
  const tl = "┌";
  const tr = "┐";
  const bl = "└";
  const br = "┘";
  
  const top = tl + color("─".repeat(width - 2)) + tr;
  const bottom = bl + color("─".repeat(width - 2)) + "┘";
  
  let output = color(tl) + color("─".repeat(width - 2)) + color(tr) + "\n";
  
  for (const line of lines) {
    const padded = " ".repeat(options.padding || 1) + line + " ".repeat(width - (options.padding || 1) * 2 - line.length);
    output += color("│") + " " + line + " ".repeat(width - 2 - line.length) + " " + color("│") + "\n";
  }
  
  output += color("└") + color("─".repeat(width - 2)) + "┘";
  
  return output;
}

// Loading animation
export class LoadingAnimation {
  private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private interval: NodeJS.Timeout | null = null;
  private index = 0;
  private message: string;
  private color: keyof typeof ansi;

  constructor(message: string = "", color: keyof typeof ansi = "cyan") {
    this.message = message;
    this.color = color;
  }

  start(message?: string): void {
    if (message) this.message = message;
    this.index = 0;
    this.interval = setInterval(() => {
      this.render();
    }, 80);
    this.render();
  }

  stop(finalMessage?: string): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (finalMessage) {
      process.stdout.write(`\r${ansi.green("✔")} ${finalMessage}\n`);
    } else {
      process.stdout.write("\r\x1b[K");
    }
  }

  succeed(message?: string): void {
    this.stop(ansi.green("✔") + (message ? ` ${message}` : ""));
  }

  fail(message?: string): void {
    this.stop(ansi.red("✖") + (message ? ` ${message}` : ""));
  }

  warn(message?: string): void {
    this.stop(ansi.yellow("⚠") + (message ? ` ${message}` : ""));
  }

  private render(): void {
    const frame = this.frames[this.index % this.frames.length];
    const color = (ansi as any)[this.color] || ansi.cyan;
    process.stdout.write(`\r${color(frame)} ${this.message}`);
    this.index++;
  }
}

// Table rendering
export function renderTable(headers: string[], rows: string[][], options: { 
  border?: boolean; 
  headerColor?: keyof typeof ansi;
  compact?: boolean;
} = {}): string {
  const { border = true, headerColor = "cyan", compact = false } = options;
  const colWidths: number[] = [];
  
  // Calculate column widths
  const allRows = [headers, ...rows];
  for (let i = 0; i < headers.length; i++) {
    let max = headers[i].length;
    for (const row of rows) {
      max = Math.max(max, row[i]?.length || 0);
    }
    colWidths[i] = max + 2; // padding
  }

  const color = (ansi as any)[options.headerColor || "cyan"];
  const padding = 1;
  let output = "";

  // Header
  let headerLine = "";
  for (let i = 0; i < headers.length; i++) {
    const padded = headers[i].padEnd(colWidths[i] - 2);
    headerLine += ` ${padded} `;
  }
  
  if (true) {
    output += "┌" + "─".repeat(headers.reduce((sum, _, i) => sum + colWidths[i], 0) + 2) + "┐\n";
    output += "│" + headerLine + " │\n";
    output += "├" + "─".repeat(headers.reduce((sum, _, i) => sum + colWidths[i], 0)) + "┤\n";
  }

  // Rows
  for (const row of rows) {
    let rowStr = "";
    for (let i = 0; i < row.length; i++) {
      const padded = (row[i] || "").padEnd(colWidths[i] - 2);
      rowStr += ` ${padded} `;
    }
    output += `│${rowStr} │\n`;
  }

  output += "└" + "─".repeat(headers.reduce((sum, _, i) => sum + colWidths[i], 0) + 2) + "┘";
  
  return output;
}

// Confirmation prompt
export async function confirm(message: string, defaultValue = false): Promise<boolean> {
  const readline = require("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  
  const suffix = defaultValue ? " [Y/n] " : " [y/N] ";
  const answer = await rl.question(`${ansi.cyan("?")} ${message}${suffix}`);
  rl.close();
  
  if (!answer) return defaultValue;
  return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
}

// Input prompt
export async function input(message: string, defaultValue?: string): Promise<string> {
  const readline = require("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = await rl.question(`${ansi.cyan("?")} ${message}${suffix}: `);
  rl.close();
  
  return answer || defaultValue || "";
}

// Select prompt
export async function select(message: string, choices: string[], defaultIndex = 0): Promise<number> {
  const readline = require("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  
  let selected = 0;
  
  const render = () => {
    process.stdout.write("\x1b[2J\x1b[H"); // Clear screen
    console.log(`${ansi.cyan("?")} ${message}\n`);
    choices.forEach((choice, i) => {
      const prefix = i === selected ? ansi.green("▶ ") : "  ";
      console.log(`${prefix}${i === selected ? ansi.green(choice) : choice}`);
    });
  };

  return new Promise((resolve) => {
    const onKey = (str: string, key: any) => {
      if (key.name === "up") selected = (selected - 1 + choices.length) % choices.length;
      else if (key.name === "down") selected = (selected + 1) % choices.length;
      else if (key.name === "return") {
        rl.close();
        process.stdin.removeListener("keypress", onKey);
        resolve(selected);
      }
      render();
    };
    
    readline.emitKeypressEvents(process.stdin, rl);
    process.stdin.setRawMode(true);
    process.stdin.on("keypress", onKey);
    render();
  });
}

export { ansi };