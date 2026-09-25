/**
 * Command Palette — Ctrl+P overlay for GoatCode v3.2.
 *
 * Filters commands by name/description/category, supports arrow-key
 * navigation, Enter to select, Esc to cancel.
 */
import { Box, Text, useInput } from "ink";
import { useState, useCallback, useMemo } from "react";

export type CommandCategory = "slash" | "skill" | "plugin" | "file" | "session";

export interface Command {
  name: string;
  description: string;
  category: CommandCategory;
}

const CATEGORY_LABEL: Record<CommandCategory, string> = {
  slash: "Slash",
  skill: "Skill",
  plugin: "Plugin",
  file: "File",
  session: "Session",
};

const CATEGORY_COLOR: Record<CommandCategory, string> = {
  slash: "#a855f7",
  skill: "#4ade80",
  plugin: "#facc15",
  file: "#38bdf8",
  session: "#fb923c",
};

export function CommandPalette({
  commands,
  onSelect,
  onClose,
}: {
  commands: Command[];
  onSelect: (cmd: Command) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(0);

  const filtered = useMemo(() => {
    const q = filter.toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        c.category.toLowerCase().includes(q),
    );
  }, [commands, filter]);

  // Reset selection when filter changes
  useMemo(() => {
    setSelected(0);
  }, [filtered.length]);

  useInput((key) => {
    if (key.upArrow) {
      setSelected((s) => Math.max(0, s - 1));
    } else if (key.downArrow) {
      setSelected((s) => Math.min(filtered.length - 1, s + 1));
    } else if (key.return) {
      if (filtered[selected]) {
        onSelect(filtered[selected]);
      }
      onClose();
    } else if (key.escape) {
      onClose();
    } else if (key.char) {
      // Handle backspace
      if (key.ctrl && key.char === "?") {
        // Help toggle
        return;
      }
      setFilter((prev) => prev + key.char);
    }
  });

  // Group filtered commands by category for display
  const grouped = useMemo(() => {
    const map = new Map<CommandCategory, Command[]>();
    for (const cmd of filtered) {
      const list = map.get(cmd.category) ?? [];
      list.push(cmd);
      map.set(cmd.category, list);
    }
    return map;
  }, [filtered]);

  const selectedCmd = filtered[selected];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} paddingY={1} backgroundColor="#1a1a2e">
      <Box marginBottom={1}>
        <Text color="cyan" bold>❯ Command Palette</Text>
        <Text dimColor color="#7c8390">  (Ctrl+P to open)</Text>
      </Box>
      <Box marginBottom={1} borderStyle="single" borderColor="#25262D" paddingX={1}>
        <Text color="#facc15">Search: </Text>
        <Text color="white" bold>{filter || "(type to filter)"}</Text>
      </Box>
      {filtered.length === 0 ? (
        <Box paddingY={1}>
          <Text dimColor color="#7c8390">  No commands match "{filter}"</Text>
        </Box>
      ) : (
        <>
          {Array.from(grouped.entries()).map(([cat, cmds]) => (
            <Box key={cat} flexDirection="column" marginBottom={1}>
              <Text dimColor color="#7c8390">  {CATEGORY_LABEL[cat]}</Text>
              {cmds.map((cmd, i) => {
                const globalIdx = filtered.indexOf(cmd);
                const isSelected = globalIdx === selected;
                return (
                  <Box key={cmd.name} paddingLeft={1}>
                    <Text
                      color={isSelected ? "cyan" : "#7c8390"}
                      bold={isSelected}
                    >
                      {isSelected ? "❯ " : "  "}
                      <Text color={CATEGORY_COLOR[cmd.category]}>
                        [{CATEGORY_LABEL[cmd.category].slice(0, 3).toUpperCase()}]
                      </Text>{" "}
                      <Text bold={isSelected} color={isSelected ? "white" : undefined}>
                        {cmd.name}
                      </Text>
                      <Text dimColor color="#7c8390"> — {cmd.description}</Text>
                    </Text>
                  </Box>
                );
              })}
            </Box>
          ))}
        </>
      )}
      <Box marginTop={1} borderTopStyle="single" borderColor="#25262D" paddingTop={1}>
        <Text dimColor color="#7c8390">
          ↑↓ navigate · Enter select · Esc cancel · type to filter
        </Text>
      </Box>
    </Box>
  );
}

/**
 * Build the full command list from all available sources.
 */
export function buildCommandList(opts: {
  slashCommands: string[];
  commandDescs: Record<string, string>;
  skills: Array<{ name: string; description: string }>;
  plugins: Array<{ name: string; description: string }>;
  sessions: string[];
}): Command[] {
  const commands: Command[] = [];

  // Slash commands
  for (const cmd of opts.slashCommands) {
    commands.push({
      name: cmd,
      description: opts.commandDescs[cmd] ?? "",
      category: "slash",
    });
  }

  // Skills
  for (const sk of opts.skills) {
    commands.push({
      name: `/${sk.name}`,
      description: sk.description,
      category: "skill",
    });
  }

  // Plugins
  for (const pl of opts.plugins) {
    commands.push({
      name: `/plugin:${pl.name}`,
      description: pl.description,
      category: "plugin",
    });
  }

  // Sessions
  for (const s of opts.sessions) {
    commands.push({
      name: `/resume ${s}`,
      description: "Resume session",
      category: "session",
    });
  }

  return commands;
}
