/**
 * MCP (Model Context Protocol) — types and config schema.
 * Claude Code compatible: reads the same config shape.
 */
import { z } from "zod";

export const TransportSchema = z.enum(["stdio", "sse", "http"]);
export type Transport = z.infer<typeof TransportSchema>;

export const McpStdioServerSchema = z.object({
  type: z.literal("stdio").optional(),
  command: z.string().min(1, "Command cannot be empty"),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
});
export type McpStdioServer = z.infer<typeof McpStdioServerSchema>;
export const McpRemoteServerSchema = z.object({
  type: z.enum(["http", "sse"]),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});
export type McpRemoteServer = z.infer<typeof McpRemoteServerSchema>;
export const McpServerConfigSchema = z.discriminatedUnion("type", [
  McpStdioServerSchema,
  McpRemoteServerSchema,
]);
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
