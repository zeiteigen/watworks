import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { DEFAULT_BRIDGE_PORT, LOOPBACK_BRIDGE_HOST } from "../packages/shared/src/protocol.js";
import { VERSION } from "../packages/shared/src/version.js";
import { extractArchive } from "./archive.js";
import { smokeMcp, withTimeout } from "./mcp-smoke.js";
import { parseReleaseTarget, releasePaths } from "./release-target.js";

async function main(): Promise<void> {
  const target = parseReleaseTarget(process.argv.slice(2));
  assert.equal(target, parseReleaseTarget([]), "Run release verification on the matching OS and architecture");
  const { name, archive, executable } = releasePaths(target);
  const checksum = await Bun.file(`${archive}.sha256`).text();
  const hash = new Bun.CryptoHasher("sha256").update(await Bun.file(archive).arrayBuffer()).digest("hex");
  assert.equal(checksum, `${hash}  ${basename(archive)}\n`);
  const temporary = await mkdtemp(join(tmpdir(), "WaterlooWorks release check "));
  try {
    await extractArchive(archive, temporary);
    const directory = join(temporary, name);
    const command = join(directory, executable);
    const cwd = join(temporary, "unrelated working directory");
    await mkdir(cwd);
    const manifest = await Bun.file(join(directory, "extension/manifest.json")).json();
    assert.equal(manifest.version, VERSION);
    assert.ok(await Bun.file(join(directory, "extension", manifest.background.service_worker)).exists());
    assert.ok(await Bun.file(join(directory, "skills/apply-job/SKILL.md")).exists());
    assert.ok(await Bun.file(join(directory, "skills/onboard/SKILL.md")).exists());
    assert.ok(await Bun.file(join(directory, "templates/resume/jake.tex")).exists());
    assert.ok(await Bun.file(join(directory, "README.md")).exists());
    assert.ok(!await Bun.file(join(directory, "package.json")).exists());
    if (process.platform !== "win32") assert.ok((await stat(command)).mode & 0o111, "Archive must preserve executable permissions");

    async function run(...args: string[]) {
      const child = Bun.spawn([command, ...args], {
        cwd, env: { ...process.env, PATH: "" }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      try {
        const [code, stdout, stderr] = await withTimeout(Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]), args.join(" ") || "port conflict");
        return { code, stdout, stderr };
      } finally {
        if (child.exitCode === null) {
          child.kill();
          await child.exited;
        }
      }
    }

    // Occupy the bridge port: informational commands must still succeed.
    const occupied = Bun.serve({ hostname: LOOPBACK_BRIDGE_HOST, port: DEFAULT_BRIDGE_PORT, fetch: () => new Response("probe") });
    try {
      assert.deepEqual(await run("--version"), { code: 0, stdout: `${VERSION}\n`, stderr: "" });
      const help = await run("--help");
      assert.equal(help.code, 0);
      assert.equal(help.stderr, "");
      assert.ok(help.stdout.includes("--print-config"));
      const config = await run("--print-config");
      assert.equal(config.code, 0);
      assert.equal(config.stderr, "");
      const generated = JSON.parse(config.stdout);
      assert.deepEqual(Object.keys(generated.mcpServers), ["waterlooworks"]);
      assert.deepEqual(generated.mcpServers.waterlooworks.args, []);
      assert.ok(isAbsolute(generated.mcpServers.waterlooworks.command));
      // macOS may resolve /var to /private/var when reporting process.execPath.
      assert.equal(await realpath(generated.mcpServers.waterlooworks.command), await realpath(command));
      const invalid = await run("--unknown");
      assert.equal(invalid.code, 1);
      assert.equal(invalid.stdout, "");
      assert.ok(invalid.stderr.includes("--help"));
      const conflict = await run();
      assert.equal(conflict.code, 1);
      assert.equal(conflict.stdout, "");
      assert.ok(conflict.stderr.includes("no compatible WaterlooWorks bridge responded"), conflict.stderr);
    } finally {
      occupied.stop(true);
    }
    await smokeMcp(command, cwd);
    console.error(`Verified extracted ${target} release without a runtime or checkout`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
