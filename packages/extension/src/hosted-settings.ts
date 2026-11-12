/** The Cloudflare endpoint that owns hosted identity, research and execution. */
export const DEFAULT_SUBMISSION_ENDPOINT = "https://watworks.alishahzad.dev";
export interface HostedSettings { endpoint: string; headers: Record<string, string>; revision: string }

/** Hosted identity and execution always use the Cloudflare endpoint, with no custom headers. */
export function hostedSettings(): HostedSettings {
  return { endpoint: DEFAULT_SUBMISSION_ENDPOINT, headers: {}, revision: "00000000-0000-4000-8000-000000000001" };
}
