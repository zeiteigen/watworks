import { AuthenticationExpiredError } from "../../waterlooworks-client/src/errors.js";
import { ensureSignIn } from "./signin.js";

// These commands use local extension storage and can return cached data while signed out.
const LOCAL_COMMANDS = new Set(["discoveryPolicyGet", "discoveryPolicySave", "discoveriesList", "discoveryStatus"]);

function authenticationFailure(error: unknown): boolean {
  // The research HTTP client wraps fetch errors, including opaque SSO redirects.
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error)) {
    if (error instanceof AuthenticationExpiredError) return true;
    seen.add(error);
    error = error.cause;
  }
  return false;
}

/** Open sign-in on authentication failure without ever replaying the command. */
export async function withSignInRecovery<T>(method: string, run: () => Promise<T>): Promise<T> {
  if (LOCAL_COMMANDS.has(method) || method === "health") return run();
  try {
    return await run();
  } catch (error) {
    if (authenticationFailure(error)) {
      // A browser tab failure must not obscure the original operation outcome.
      await ensureSignIn().catch(() => undefined);
    }
    throw error;
  }
}
