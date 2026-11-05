import { AuthenticationExpiredError } from "../../waterlooworks-client/src/errors.js";
import { WaterlooWorksClient } from "../../waterlooworks-client/src/client.js";
import { WATERLOOWORKS_ORIGIN } from "../../shared/src/protocol.js";

/** Browser-managed authentication: session material never leaves the browser. */
export const browserFetch: import("../../waterlooworks-client/src/session.js").FetchLike = async (input, init) => {
  const url = new URL(String(input));
  if (url.origin !== WATERLOOWORKS_ORIGIN) throw new Error("Unsupported WaterlooWorks destination");
  const headers = new Headers(init?.headers);
  for (const name of ["cookie", "origin", "referer"]) headers.delete(name);
  const response = await fetch(url, { ...init, headers, credentials: "include", redirect: "manual", signal: init?.signal ?? AbortSignal.timeout(30_000) });
  if (response.type === "opaqueredirect") throw new AuthenticationExpiredError("WaterlooWorks sign-in required");
  return response;
};

export const browserResearch = new WaterlooWorksClient({
  getSession: async () => ({ cookies: [], obtainedAt: new Date().toISOString() }),
}, { fetchImpl: browserFetch });
