import { delimiter, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import type { ApplicationGateway } from "./types.js";
import type { ReviewService } from "../../approval/src/index.js";
import { ExtensionApplicationGateway } from "../../bridge/src/extension-proxy.js";
import { ApplicationWorkflow } from "./workflow.js";
import { dataRoot } from "../../workspace/src/paths.js";

export function createApplicationWorkflow(options: { reviews?: ReviewService; gateway?:ApplicationGateway } = {}): ApplicationWorkflow {
  const configured = process.env.WATERLOOWORKS_DOCUMENT_ROOTS;
  let documentRoots: string[] = [];
  if (configured) {
    const parsed: unknown = configured.trim().startsWith("[") ? JSON.parse(configured) : configured.split(delimiter);
    if (!Array.isArray(parsed) || parsed.some(root => typeof root !== "string" || !isAbsolute(root))) throw new Error("WATERLOOWORKS_DOCUMENT_ROOTS must contain absolute directory paths");
    documentRoots = parsed as string[];
  }
  documentRoots = [...new Set([dataRoot(), ...documentRoots])];
  const base = process.platform === "win32" ? process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
    : process.platform === "darwin" ? join(homedir(), "Library", "Application Support")
      : process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  const ledgerPath = process.env.WATERLOOWORKS_LEDGER_PATH ?? join(base, "waterlooworks-mcp", "applications", "attempts.sqlite");
  return new ApplicationWorkflow({
    gateway: options.gateway ?? new ExtensionApplicationGateway(), documentRoots, ledgerPath,
    ...(options.reviews ? { reviews: options.reviews } : {}),
  });
}
