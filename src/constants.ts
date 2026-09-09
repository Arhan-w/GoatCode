/** Shared tunables (named constants per coding-style rules). */
export const DEFAULT_HOOK_TIMEOUT_MS = 60_000;
export const MAX_WEBFETCH_BYTES = 200_000;
export const WEBFETCH_TIMEOUT_MS = 30_000;
/** Sub-agent step budget — smaller than the main loop's 40. */
export const SUBAGENT_MAX_STEPS = 25;
