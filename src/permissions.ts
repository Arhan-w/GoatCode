/**
 * Permission rules — Claude Code settings.json compatible.
 *
 *   Bash(git add:*)     — command starts with "git add"
 *   Bash(npm run test)  — exact command
 *   Edit(src/**)        — file path glob (** spans dirs, * doesn't)
 *   Read(~/.ssh/**)     — home path glob (absolute outside sandbox)
 *   WebFetch(domain:docs.example.com)
 *   Task               — bare tool name matches every call of that tool
 *
 * deny beats allow beats asking the user. Tool names are matched
 * case-insensitively; goat's write/edit both answer to Edit/Write.
 */
import { homedir } from "node:os";

export interface RuleSet { allow: string[]; deny: string[] }

interface Rule { tool: string; arg?: string; raw: string }

function parseRule(raw: string): Rule | null {
  const m = raw.trim().match(/^([A-Za-z_][\w]*)(?:\((.+)\))?$/s);
  if (!m) return null;
  return { tool: m[1].toLowerCase(), arg: m[2], raw: raw.trim() };
}

/** Glob with * (single segment) and ** (across separators). */
export function globMatch(rel: string, pattern: string): boolean {
  let rx = "";
  const p = pattern.replaceAll("\\", "/");
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        rx += ".*"; i++;
        if (p[i + 1] === "/") i++;
      } else rx += "[^/]*";
    } else if ("\\^$.|+()[]{}?".includes(c)) rx += "\\" + c;
    else rx += c;
  }
  return new RegExp("^" + rx + "$").test(rel.replaceAll("\\", "/"));
}

/** One rule against one tool call. */
export function ruleMatches(rule: Rule, tool: string, args: Record<string, unknown>): boolean {
  const t = tool.toLowerCase();
  // goat write/edit both satisfy Edit/Write rules; mcp__x__y matches a Mcp(x) style loosely
  const toolOk =
    rule.tool === t ||
    (rule.tool === "edit" && (t === "edit" || t === "write")) ||
    (rule.tool === "write" && t === "write");
  if (!toolOk) return false;
  if (rule.arg === undefined) return true;
  const pat = rule.arg;
  switch (t) {
    case "bash": {
      const cmd = String(args.command ?? "").trim();
      // Anti-bypass (matches Claude): prefix/glob allow rules never match
      // compound commands — exact rules only. deny checks both anyway.
      const compound = /[;&|]|\$\(|`/.test(cmd);
      if (pat.endsWith(":*")) {
        const prefix = pat.slice(0, -2).trim();
        return !compound && (cmd === prefix || cmd.startsWith(prefix + " "));
      }
      if (pat.includes("*")) return !compound && globMatch(cmd, pat);
      return cmd === pat;
    }
    case "edit":
    case "write":
    case "read": {
      const path = String(args.path ?? "").replaceAll("\\", "/");
      const expanded = pat.startsWith("~/") ? joinHome(pat) : pat;
      if (expanded === pat) return globMatch(path, pat);
      return path === expanded || path.replaceAll("\\", "/").startsWith(expanded.replace(/\/\*\*.*$/, "/"));
    }
    case "webfetch": {
      const url = String(args.url ?? "");
      if (pat.startsWith("domain:")) {
        const dom = pat.slice(7).replace(/^\./, "");
        try {
          const host = new URL(url).hostname;
          return host === dom || host.endsWith("." + dom);
        } catch { return false; }
      }
      return url.startsWith(pat);
    }
    case "computer": {
      // Computer(type) matches the type action; Computer(click) covers the
      // click variants; bare Computer matches everything.
      const action = String(args.action ?? "");
      if (pat === "click") return ["click", "double_click", "right_click"].includes(action);
      return action === pat;
    }
    default:
      return false; // arg-bearing rules only defined for known tools
  }
}

function joinHome(p: string): string {
  return (homedir() + p.slice(1)).replaceAll("\\", "/");
}

export type Decision = "allow" | "deny" | "ask";

export function decide(rules: RuleSet | undefined, tool: string, args: Record<string, unknown>): Decision {
  if (!rules) return "ask";
  for (const raw of rules.deny) {
    const r = parseRule(raw);
    if (r && ruleMatches(r, tool, args)) return "deny";
  }
  for (const raw of rules.allow) {
    const r = parseRule(raw);
    if (r && ruleMatches(r, tool, args)) return "allow";
  }
  return "ask";
}
