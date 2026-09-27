/**
 * Error taxonomy with actionable messages and suggested fixes.
 * Each error class has a unique code for programmatic handling.
 */

export type ErrorCode =
  | 'ERR_PROVIDER_AUTH'
  | 'ERR_PROVIDER_RATE_LIMIT'
  | 'ERR_PROVIDER_UNAVAILABLE'
  | 'ERR_TOOL_PERMISSION'
  | 'ERR_TOOL_EXECUTION'
  | 'ERR_INDEX_STALE'
  | 'ERR_INDEX_CORRUPT'
  | 'ERR_PLUGIN_LOAD'
  | 'ERR_PLUGIN_SANDBOX'
  | 'ERR_SESSION_CORRUPT'
  | 'ERR_SESSION_RESUME'
  | 'ERR_CONFIG_INVALID'
  | 'ERR_NETWORK_TIMEOUT'
  | 'ERR_VALIDATION'
  | 'ERR_GENERIC';

export abstract class GoatError extends Error {
  readonly code: ErrorCode;
  readonly suggestion?: string;
  readonly context?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, opts?: { suggestion?: string; context?: Record<string, unknown> }) {
    super(message);
    this.code = code;
    this.suggestion = opts?.suggestion;
    this.context = opts?.context;
    this.name = this.constructor.name;
  }
}

export class ConfigError extends GoatError {
  constructor(message: string, opts?: { suggestion?: string }) {
    super('ERR_CONFIG_INVALID', message, opts);
  }
}

export class AuthError extends GoatError {
  constructor(provider: string, message?: string) {
    super('ERR_PROVIDER_AUTH', message ?? `Authentication failed for ${provider}`, {
      suggestion: `Run: goat auth ${provider} --oauth (or set API key via environment variable)`
    });
  }
}

export class ProviderError extends GoatError {
  constructor(public readonly providerId: string, message?: string, public readonly retryAfter?: number) {
    super('ERR_PROVIDER_UNAVAILABLE', message ?? `Provider ${providerId} unavailable`, {
      suggestion: retryAfter ? `Retry after ${retryAfter}s or use fallback provider` : 'Check provider status or configure fallbacks'
    });
  }
}

export class RateLimitError extends ProviderError {
  constructor(providerId: string, retryAfter?: number) {
    super(providerId, 'Rate limit exceeded', retryAfter);
  }
}

export class ToolError extends GoatError {
  constructor(tool: string, message?: string, opts?: { suggestion?: string }) {
    super('ERR_TOOL_EXECUTION', `${tool}: ${message ?? 'execution failed'}`, opts);
  }
}

export class PermissionError extends ToolError {
  constructor(tool: string) {
    super(tool, 'Permission denied', {
      suggestion: `Use /permissions to allow ${tool} or run with --bypass`
    });
  }
}

export class IndexError extends GoatError {
  constructor(message?: string, opts?: { suggestion?: string }) {
    super('ERR_INDEX_STALE', message ?? 'Index error', opts);
  }
}

export class PluginError extends GoatError {
  constructor(plugin: string, message?: string, public readonly kind: 'load' | 'sandbox' | 'manifest' = 'load') {
    super(kind === 'sandbox' ? 'ERR_PLUGIN_SANDBOX' : 'ERR_PLUGIN_LOAD',
          `${plugin}: ${message ?? 'plugin error'}`,
          { suggestion: `Run 'goat plugin remove ${plugin}' and reinstall` });
    this.name = 'PluginError';
  }
}

export class SessionError extends GoatError {
  constructor(message?: string, public readonly sessionId?: string) {
    super('ERR_SESSION_CORRUPT', message ?? 'Session error', {
      suggestion: sessionId ? `Try: goat resume ${sessionId}` : 'Start a new session with /new'
    });
  }
}

export class NetworkError extends GoatError {
  constructor(public readonly url: string, message?: string) {
    super('ERR_NETWORK_TIMEOUT', message ?? `Network error: ${url}`, {
      suggestion: 'Check connection or try again'
    });
  }
}

export class ValidationError extends GoatError {
  constructor(field: string, message?: string) {
    super('ERR_VALIDATION', `${field}: ${message ?? 'validation failed'}`);
  }
}

/** Wrap errors with actionable context */
export function withSuggestion(error: Error, suggestion: string): GoatError {
  if (error instanceof GoatError) {
    (error as any).suggestion = suggestion;
    return error;
  }
  return new GenericError(error.message, { suggestion });
}

export class GenericError extends GoatError {
  constructor(message: string, opts?: { suggestion?: string }) {
    super('ERR_GENERIC', message, opts);
  }
}

/** Format error for display */
export function formatError(error: Error): string {
  if (error instanceof GoatError) {
    let msg = `\n[${error.code}] ${error.message}`;
    if (error.suggestion) msg += `\n  [help] ${error.suggestion}`;
    return msg;
  }
  return `\n${error.name}: ${error.message}`;
}
