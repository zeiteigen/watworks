import { NATIVE_HOST_NAME } from "../../shared/src/native-host.js";
import { WORKSPACE_SERVICE } from "./dashboard-api.js";

type Reply = { ok?: boolean; error?: string };

export function createServiceStarter(ping: () => Promise<boolean>, launch: () => Promise<Reply>) {
  let pending: Promise<void> | undefined;
  return () => {
    if (pending) return pending;
    pending = (async () => {
      if (await ping().catch(() => false)) return;
      let result: Reply;
      try { result = await launch(); }
      catch { throw new Error("Chrome could not start the workspace helper. Run bun run install:native-host once, then reload the extension."); }
      if (!result?.ok) throw new Error(result?.error ?? "The workspace service could not start.");
    })().finally(() => { pending = undefined; });
    return pending;
  };
}

export const startService = createServiceStarter(async () => {
  const response = await fetch(WORKSPACE_SERVICE + "/api/ping", { signal: AbortSignal.timeout(1000), credentials: "omit" });
  return response.ok && (await response.json()).app === "wat-dashboard";
}, () => chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { action: "start" }));
