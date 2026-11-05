import { chmod, cp, mkdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { buildExtension } from "../packages/extension/build.js";
import { createArchive } from "./archive.js";
import { parseReleaseTarget, releasePaths, REPO_ROOT, validateReleaseVersion } from "./release-target.js";

async function main(): Promise<void> {
  const target = parseReleaseTarget(process.argv.slice(2));
  await validateReleaseVersion(process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined);
  const { directory, archive, executable } = releasePaths(target);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  await mkdir(dirname(archive), { recursive: true });

  const result = await Bun.build({
    entrypoints: [join(REPO_ROOT, "packages/mcp-server/src/cli.ts")],
    target: "bun",
    minify: true,
    sourcemap: "linked",
    compile: {
      target: `bun-${target}`,
      outfile: join(directory, executable),
      autoloadDotenv: false,
      autoloadBunfig: false,
      autoloadTsconfig: false,
      autoloadPackageJson: false,
    },
  });
  if (!result.success) {
    for (const message of result.logs) console.error(message);
    throw new Error("MCP executable build failed");
  }
  if (!target.startsWith("windows")) await chmod(join(directory, executable), 0o755);
  await buildExtension(join(directory, "extension"));
  await cp(join(REPO_ROOT, ".agents/skills"), join(directory, "skills"), { recursive: true });
  await cp(join(REPO_ROOT, "templates"), join(directory, "templates"), { recursive: true });
  await cp(join(REPO_ROOT, "README.md"), join(directory, "README.md"));
  await createArchive(directory, archive);
  const hash = new Bun.CryptoHasher("sha256").update(await Bun.file(archive).arrayBuffer()).digest("hex");
  await Bun.write(`${archive}.sha256`, `${hash}  ${basename(archive)}\n`);
  console.error(`Release archive: ${archive}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
