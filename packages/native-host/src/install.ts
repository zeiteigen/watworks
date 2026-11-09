import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { WorkspacePaths, installRoot } from "../../workspace/src/paths.js";
import { NATIVE_HOST_NAME, NATIVE_HOST_ORIGIN } from "../../shared/src/native-host.js";
import { attemptLedgerPath } from "../../application-workflow/src/config.js";

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

export function nativeHostDirectories(home: string, platform = process.platform): string[] {
  if (platform === "linux") return ["google-chrome", "chromium", "microsoft-edge", "BraveSoftware/Brave-Browser"].map(browser => join(home, ".config", browser, "NativeMessagingHosts"));
  if (platform === "darwin") return ["Google/Chrome", "Chromium", "Microsoft Edge", "BraveSoftware/Brave-Browser"].map(browser => join(home, "Library/Application Support", browser, "NativeMessagingHosts"));
  return [];
}

/** Chrome does not inherit the agent's environment, so pin what must stay shared across launchers. */
export function nativeHostWrapper(options: { dataRoot: string; port: string; ledgerPath: string; command: string[]; documentRoots?: string | undefined }): string {
  return `#!/bin/sh\nexport WAT_DATA_DIR=${quote(options.dataRoot)}\nexport WAT_DASHBOARD_PORT=${quote(options.port)}\nexport WATERLOOWORKS_LEDGER_PATH=${quote(options.ledgerPath)}\n${options.documentRoots ? `export WATERLOOWORKS_DOCUMENT_ROOTS=${quote(options.documentRoots)}\n` : ""}exec ${options.command.map(quote).join(" ")} --native-host "$@"\n`;
}

/** Per-user registration; absolute paths also work when Chrome has no Bun on PATH. */
export async function installNativeHost(): Promise<string[]> {
  const root = installRoot();
  if (process.platform === "win32" && !Bun.isStandaloneExecutable) throw new Error("On Windows, use the compiled release with --install-native-host.");
  const directory = join(root, ".tools", "native-host");
  await mkdir(directory, { recursive: true });
  let executable = process.execPath;
  if (process.platform !== "win32") {
    executable = join(directory, "workspace-host");
    const command = Bun.isStandaloneExecutable ? [process.execPath] : [process.execPath, join(root, "packages/mcp-server/src/cli.ts")];
    await writeFile(executable, nativeHostWrapper({ dataRoot: new WorkspacePaths().root, port: process.env.WAT_DASHBOARD_PORT ?? "39452", ledgerPath: attemptLedgerPath(), command, documentRoots: process.env.WATERLOOWORKS_DOCUMENT_ROOTS }), { mode: 0o700 });
    await chmod(executable, 0o700);
  }
  const manifest = JSON.stringify({ name: NATIVE_HOST_NAME, description: "Start the WaterlooWorks workspace service", path: executable, type: "stdio", allowed_origins: [NATIVE_HOST_ORIGIN] }, null, 2) + "\n";
  const paths: string[] = [];
  const dirs = nativeHostDirectories(homedir());
  if (process.platform === "win32") dirs.push(directory);
  if (!dirs.length) throw new Error(`Native messaging installation is unsupported on ${process.platform}`);
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${NATIVE_HOST_NAME}.json`);
    await writeFile(path, manifest, { mode: 0o600 });
    paths.push(path);
  }
  if (process.platform === "win32") {
    const result = Bun.spawnSync(["reg.exe", "ADD", `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`, "/ve", "/t", "REG_SZ", "/d", paths[0]!, "/f"]);
    if (result.exitCode !== 0) throw new Error("Could not register the Chrome native messaging host");
  }
  return paths;
}

