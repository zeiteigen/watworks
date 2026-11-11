import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dashboardStopHelp, pullLatest, UpdateError, type Git } from "./update.js";

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function gitIn(cwd: string): Git {
  return args => {
    const result = Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "init.defaultBranch=main", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode ?? 1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  };
}
/** A published repository, a user's clone of it, and a way to publish a new snapshot. */
function checkout() {
  const base = mkdtempSync(join(tmpdir(), "wat-update-"));
  temporary.push(base);
  const published = join(base, "published"), clone = join(base, "clone");
  gitIn(base)(["init", "--quiet", published]);
  writeFileSync(join(published, "README.md"), "v1\n");
  writeFileSync(join(published, ".gitignore"), "data/\n");
  gitIn(published)(["add", "."]);
  gitIn(published)(["commit", "--quiet", "-m", "First snapshot"]);
  gitIn(base)(["clone", "--quiet", published, clone]);
  const publish = (content: string, message: string) => {
    writeFileSync(join(published, "README.md"), content);
    gitIn(published)(["commit", "--quiet", "-am", message]);
  };
  return { clone, git: gitIn(clone), publish };
}

test("fast-forwards to the latest snapshot and lists what changed, leaving data/ alone", () => {
  const { clone, git, publish } = checkout();
  Bun.spawnSync(["mkdir", "-p", join(clone, "data")]);
  writeFileSync(join(clone, "data", "profile.json"), "{\"private\":true}");
  publish("v2\n", "Second snapshot");
  publish("v3\n", "Third snapshot");
  const result = pullLatest(git);
  expect(result.commits.map(line => line.slice(8))).toEqual(["Third snapshot", "Second snapshot"]);
  expect(readFileSync(join(clone, "README.md"), "utf8")).toBe("v3\n");
  expect(readFileSync(join(clone, "data", "profile.json"), "utf8")).toBe("{\"private\":true}");
  expect(pullLatest(git).commits).toEqual([]);
});

test("stops before changing anything when tracked files were edited", () => {
  const { clone, git, publish } = checkout();
  publish("v2\n", "Second snapshot");
  writeFileSync(join(clone, "README.md"), "my edit\n");
  expect(() => pullLatest(git)).toThrow(UpdateError);
  expect(() => pullLatest(git)).toThrow(/README\.md[\s\S]*git stash/);
  expect(readFileSync(join(clone, "README.md"), "utf8")).toBe("my edit\n");
});

test("refuses to rewrite local commits that are not in the published version", () => {
  const { clone, git, publish } = checkout();
  writeFileSync(join(clone, "notes.txt"), "mine\n");
  git(["add", "notes.txt"]);
  git(["commit", "--quiet", "-m", "Local work"]);
  publish("v2\n", "Second snapshot");
  const before = git(["rev-parse", "HEAD"]).stdout;
  expect(() => pullLatest(git)).toThrow(/fast-forward[\s\S]*git rebase/);
  expect(git(["rev-parse", "HEAD"]).stdout).toBe(before);
});

test("explains detached checkouts and folders that are not Git checkouts", () => {
  const { git } = checkout();
  git(["checkout", "--quiet", "--detach"]);
  expect(() => pullLatest(git)).toThrow(/not on a branch/);
  const plain = mkdtempSync(join(tmpdir(), "wat-update-plain-"));
  temporary.push(plain);
  expect(() => pullLatest(gitIn(plain))).toThrow(/not a Git checkout/);
});

test("dashboard help names the port and a platform-appropriate stop command", () => {
  expect(dashboardStopHelp(39452, "linux")).toContain("lsof -ti tcp:39452");
  expect(dashboardStopHelp(39452, "win32")).toContain("Get-NetTCPConnection -LocalPort 39452");
  expect(dashboardStopHelp(39452, "darwin")).toMatch(/uploading or submitting/);
});
