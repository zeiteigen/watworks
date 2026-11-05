import { basename, dirname } from "node:path";
import { rm } from "node:fs/promises";

async function run(command: string[], cwd?: string): Promise<void> {
  const child = Bun.spawn(command, { ...(cwd === undefined ? {} : { cwd }), stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`Archive command failed: ${command[0]}`);
}

export async function createArchive(directory: string, archive: string): Promise<void> {
  await rm(archive, { force: true });
  if (!archive.endsWith(".zip")) {
    await run(["tar", "-czf", archive, "-C", dirname(directory), basename(directory)]);
  } else if (process.platform === "win32") {
    // Pass paths through environment variables rather than PowerShell code.
    const child = Bun.spawn([
      "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference = 'Stop'; Compress-Archive -LiteralPath $env:WAT_ARCHIVE_SOURCE -DestinationPath $env:WAT_ARCHIVE_DESTINATION -Force",
    ], {
      env: { ...process.env, WAT_ARCHIVE_SOURCE: directory, WAT_ARCHIVE_DESTINATION: archive },
      stdout: "inherit", stderr: "inherit",
    });
    if (await child.exited !== 0) throw new Error("Compress-Archive failed");
  } else {
    await run(["zip", "-qr", archive, basename(directory)], dirname(directory));
  }
}

export async function extractArchive(archive: string, directory: string): Promise<void> {
  if (archive.endsWith(".zip") && process.platform === "win32") {
    const child = Bun.spawn([
      "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:WAT_ARCHIVE_SOURCE -DestinationPath $env:WAT_ARCHIVE_DESTINATION -Force",
    ], {
      env: { ...process.env, WAT_ARCHIVE_SOURCE: archive, WAT_ARCHIVE_DESTINATION: directory },
      stdout: "inherit", stderr: "inherit",
    });
    if (await child.exited !== 0) throw new Error("Expand-Archive failed");
  } else if (archive.endsWith(".zip")) {
    await run(["unzip", "-q", archive, "-d", directory]);
  } else {
    await run(["tar", "--no-same-owner", "-xzf", archive, "-C", directory]);
  }
}
