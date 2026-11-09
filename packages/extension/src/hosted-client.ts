import { HOSTED_INSIDER_SESSION_KEY, readInsiderSession } from "./insider-session.js";
import { getHostedAccount } from "./insider-account.js";
import { hostedSettings } from "./hosted-settings.js";

export const HOSTED_WORKSPACE_ENDPOINT = "https://watworks.alishahzad.dev/v1/workspace";

export interface HostedProfile {
  roles: string[];
  citizenshipCountries: string[];
  permanentResidencyCountries: string[];
  fluentLanguages: string[];
  canada: "yes" | "no" | "unknown";
  unitedStates: "yes" | "no" | "unknown";
  minimumHourlyPay: number | null;
  locations: string[];
  notes: string;
  scheduleHour: number;
  workTerm: string;
  eightMonthEligible: "yes" | "no" | "unknown";
  backgroundNotes?: string;
  workingMemory?: string;
}
export interface HostedAi {
  available: boolean; reason: string; connected?: boolean; chatgptConnected?: boolean; apiKeyUnreadable?: boolean;
  apiKey?: { style: "openai" | "anthropic"; model: string; baseUrl: string | null; keyHint: string | null } | null;
}
export interface HostedResume { id: string; name: string; size: number }
export interface HostedWorkspace { profile: HostedProfile | null; resumes: HostedResume[]; runs: Array<{ status?: string; [key: string]: unknown }>; jobs: import("./hosted-queue.js").HostedJob[]; ai: HostedAi; resumeReview?: import("../../shared/src/resume-changes.js").ResumeReviewMode }

/** The server answered without running the action, or the request was never sent. A retry cannot repeat a write. */
export class HostedRejection extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

export async function requireHostedSession() {
  const account = await getHostedAccount();
  if (!account.insider) throw new Error(account.reason ?? `No Insider access for ${account.email ?? "this WaterlooWorks account"}${account.term ? ` in ${account.term}` : ""}. Check the email and term in the admin dashboard.`);
  const session = await readInsiderSession(hostedSettings(), HOSTED_INSIDER_SESSION_KEY);
  if (!session) throw new Error(account.reason ?? "Verify your WaterlooWorks account to continue.");
  return session;
}

export async function hostedRequest<T>(path = "", init: RequestInit = {}): Promise<T> {
  let session: Awaited<ReturnType<typeof requireHostedSession>>;
  try { session = await requireHostedSession(); }
  catch (error) { throw new HostedRejection(error instanceof Error ? error.message : String(error)); }
  const response = await fetch(`${HOSTED_WORKSPACE_ENDPOINT}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${session.token}`, ...init.headers },
    credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer",
    signal: AbortSignal.timeout(/^\/jobs\/\d+\/(prepare|confirm|custom-resume\/choices)$/.test(path) ? 420_000 : path === "/ai-key" ? 45_000 : 30_000), // The key check itself may take the server 30 seconds.
  });
  if (response.ok && ["application/pdf", "application/x-tex"].some(type => response.headers.get("content-type")?.toLowerCase().startsWith(type))) return await response.blob() as T;
  const data = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) {
    const failure = data.error ?? `Hosted workspace returned HTTP ${response.status}`;
    // Other 5xx responses may follow a reservation, so they stay uncertain.
    throw response.status < 500 || response.status === 503 ? new HostedRejection(failure, response.status) : new Error(failure);
  }
  return data as T;
}

export async function streamHostedEvents(onEvent: (value: unknown) => void, signal: AbortSignal, initialAfter = 0, onCursor?: (value: number) => void): Promise<void> {
  let after = initialAfter;
  while (!signal.aborted) {
    try {
      const session = await requireHostedSession();
      const timeout = AbortSignal.timeout(28_000);
      const response = await fetch(`${HOSTED_WORKSPACE_ENDPOINT}/events?after=${after}`, {
        headers: { authorization: `Bearer ${session.token}`, accept: "text/event-stream" },
        credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer",
        signal: AbortSignal.any([signal, timeout]),
      });
      if (!response.ok || !response.body) throw new Error(`Hosted events returned HTTP ${response.status}`);
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = "", eventId = "", data = "";
      const dispatch = () => {
        if (data) { try { onEvent(JSON.parse(data)); } catch { /* Ignore malformed event payloads. */ } }
        if (/^\d+$/.test(eventId)) { after = Math.max(after, Number(eventId)); onCursor?.(after); }
        eventId = ""; data = "";
      };
      try {
        while (!signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline).replace(/\r$/, ""); buffer = buffer.slice(newline + 1);
            if (!line) { dispatch(); continue; }
            if (line.startsWith("id:")) eventId = line.slice(3).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
        }
      } finally { await reader.cancel().catch(() => {}); }
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof Error && error.name !== "TimeoutError" && error.name !== "AbortError") throw error;
    }
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 500);
      signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
}
