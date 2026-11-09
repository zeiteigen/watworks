import { z } from "zod";
import { requireHostedSession } from "./hosted-client.js";
import { hostedSettings } from "./hosted-settings.js";
import { browserResearch } from "./research.js";
import { currentWaterlooWorksSession } from "./waterlooworks-session.js";
import { unexpiredCookie } from "../../shared/src/session-cookies.js";

const rejectedKey = "hosted:rejected-session";
const importedSchema = z.object({ accountKey: z.string().min(1), sessionId: z.string().min(1) });

/** On demand only: send credentials directly to the hosted execution endpoint. */
export async function prepareHostedSubmissionSession(): Promise<void> {
  await navigator.locks.request("hosted:session-import", { mode: "exclusive" }, async () => {
    if (!(await browserResearch.health()).authenticated) throw new Error("Sign in to WaterlooWorks before starting a search or application.");
    const identity = await requireHostedSession();
    const { payload, fingerprint } = await currentWaterlooWorksSession();
    payload.cookies = payload.cookies.filter(cookie => unexpiredCookie(cookie));
    if (!payload.cookies.length) throw new Error("Sign in to WaterlooWorks before starting a search or application.");
    if ((await chrome.storage.session.get(rejectedKey))[rejectedKey] === fingerprint) throw new Error("These WaterlooWorks credentials were rejected. Sign in again before retrying.");
    const response = await fetch(`${hostedSettings().endpoint}/v1/session`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${identity.token}` },
      body: JSON.stringify(payload), credentials: "omit", redirect: "error", cache: "no-store",
      referrerPolicy: "no-referrer", signal: AbortSignal.timeout(60_000),
    });
    const value = await response.json() as { code?: string; error?: string };
    if (!response.ok) {
      if (value.code === "session_invalid") await chrome.storage.session.set({ [rejectedKey]: fingerprint });
      throw new Error(value.error ?? `Hosted session verification failed (HTTP ${response.status}).`);
    }
    importedSchema.parse(value);
    if ((await currentWaterlooWorksSession()).fingerprint !== fingerprint) throw new Error("WaterlooWorks connection changed. Prepare again before starting a search or application.");
    await chrome.storage.session.remove(rejectedKey);
  });
}
