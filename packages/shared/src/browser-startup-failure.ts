/** Public diagnostics are fixed strings; launch errors can contain secrets. */
export const BROWSER_STARTUP_FAILURES = {
  browser_unavailable: "Submission browser could not start. Check the server browser configuration and availability.",
  browser_rate_limited: "Cloudflare Browser Run refused browser startup (HTTP 429). Check the hosting account's browser rate limits and daily browser-time quota; try again after the limit resets.",
  browser_quota_exceeded: "Cloudflare Browser Run's daily browser-time quota is exhausted. Wait until the next UTC day or upgrade the hosting account's Workers plan.",
} as const;
export type BrowserStartupCode = keyof typeof BROWSER_STARTUP_FAILURES;
