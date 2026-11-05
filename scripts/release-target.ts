import { join } from "node:path";
import { VERSION } from "../packages/shared/src/version.js";

export const REPO_ROOT = join(import.meta.dir, "..");
export const RELEASE_TARGETS = ["windows-x64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"] as const;
export type ReleaseTarget = typeof RELEASE_TARGETS[number];

export function parseReleaseTarget(args: string[]): ReleaseTarget {
  const target = args.length === 0
    ? `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
    : args.length === 2 && args[0] === "--target" ? args[1] : undefined;
  if (!RELEASE_TARGETS.includes(target as ReleaseTarget)) {
    throw new Error(`Usage: --target <${RELEASE_TARGETS.join(" | ")}> (defaults to the current platform)`);
  }
  return target as ReleaseTarget;
}

export function releasePaths(target: ReleaseTarget) {
  const name = `waterlooworks-mcp-v${VERSION}-${target}`;
  const directory = join(REPO_ROOT, "dist", "release", target, name);
  const archive = join(REPO_ROOT, "dist", "releases", `${name}.${target.startsWith("windows") ? "zip" : "tar.gz"}`);
  const executable = target.startsWith("windows") ? "waterlooworks-mcp.exe" : "waterlooworks-mcp";
  return { name, directory, archive, executable };
}

export async function validateReleaseVersion(tag?: string): Promise<void> {
  const manifest = await Bun.file(join(REPO_ROOT, "packages/extension/manifest.json")).json();
  if (manifest.version !== VERSION) {
    throw new Error(`Extension version ${manifest.version} must match package version ${VERSION}`);
  }
  if (tag !== undefined && tag !== `v${VERSION}`) {
    throw new Error(`Release tag ${tag} must match v${VERSION}`);
  }
}
