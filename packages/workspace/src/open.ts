import { spawn } from "node:child_process";

export type FileOpener = (path: string) => boolean;

/**
 * Open a file in the user's default viewer without blocking or touching stdio
 * (stdout is the MCP channel). Set WAT_OPEN_DOCUMENTS=0 to disable.
 */
export const openInDefaultViewer: FileOpener = path => {
  if (process.env.WAT_OPEN_DOCUMENTS === "0") return false;
  const [command, ...args] = process.platform === "darwin" ? ["open", path]
    : process.platform === "win32" ? ["cmd", "/c", "start", "", path]
      : ["xdg-open", path];
  try {
    const child = spawn(command!, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
};
