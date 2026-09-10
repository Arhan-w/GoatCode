/** Shared tunables (named constants per coding-style rules). */
export const DEFAULT_HOOK_TIMEOUT_MS = 60_000;
export const MAX_WEBFETCH_BYTES = 200_000;
export const WEBFETCH_TIMEOUT_MS = 30_000;
/** Sub-agent step budget — smaller than the main loop's 40. */
export const SUBAGENT_MAX_STEPS = 25;
/** Single source of truth for the version string — keep in lock-step with
 *  package.json (enforced by a test) and the git tag you cut. */
export const VERSION = "2.1.3";
export const REPO_SLUG = "Arhan-w/GoatCode";
/** Default port for `goat web`. */
export const WEB_DEFAULT_PORT = 4847;
