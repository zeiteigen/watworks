import { NATIVE_HOST_ORIGIN } from "../../shared/src/native-host.js";
import { ensureDashboard } from "../../dashboard/src/launcher.js";
import { Workspace } from "../../workspace/src/store.js";
import { encodeMessage, readMessage } from "./protocol.js";

/** This helper can only start the configured workspace; it cannot approve or execute commands. */
export async function handleNativeRequest(origin: string | undefined, message: unknown, start: () => Promise<unknown>): Promise<{ ok: boolean; error?: string }> {
  if (origin !== NATIVE_HOST_ORIGIN) return { ok: false, error: "Forbidden extension origin" };
  if (!message || typeof message !== "object" || Array.isArray(message) || Object.keys(message).length !== 1 || (message as { action?: unknown }).action !== "start") {
    return { ok: false, error: "Unsupported native request" };
  }
  try { await start(); return { ok: true }; }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : "Workspace could not start" }; }
}

export async function runNativeHost(origin: string | undefined): Promise<void> {
  // Do not consume stdin from an untrusted caller.
  if (origin !== NATIVE_HOST_ORIGIN) {
    await Bun.stdout.write(encodeMessage({ ok: false, error: "Forbidden extension origin" }));
    return;
  }
  const timeout = setTimeout(() => process.exit(1), 15_000);
  try {
    const message = await readMessage(Bun.stdin.stream());
    const result = await handleNativeRequest(origin, message, () => ensureDashboard(new Workspace()));
    await Bun.stdout.write(encodeMessage(result));
  } catch {
    await Bun.stdout.write(encodeMessage({ ok: false, error: "Invalid native message" }));
  } finally { clearTimeout(timeout); }
}
