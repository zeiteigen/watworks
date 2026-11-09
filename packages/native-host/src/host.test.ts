import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NATIVE_HOST_ORIGIN } from "../../shared/src/native-host.js";
import { nativeHostWrapper } from "./install.js";
import { handleNativeRequest } from "./host.js";
import { encodeMessage, readMessage } from "./protocol.js";
import { nativeHostDirectories } from "./install.js";

async function* chunks(...values: Uint8Array[]) { yield* values; }

test("native framing handles split headers and UTF-8 and rejects truncated or oversized input", async () => {
  const frame = encodeMessage({ text: "é🙂" });
  expect(await readMessage(chunks(frame.slice(0, 2), frame.slice(2, 5), frame.slice(5)))).toEqual({ text: "é🙂" });
  await expect(readMessage(chunks(frame.slice(0, -1)))).rejects.toThrow("Incomplete");
  await expect(readMessage(chunks(new Uint8Array([255, 255, 255, 255])))).rejects.toThrow("length");
  await expect(readMessage(chunks(new Uint8Array(2048)))).rejects.toThrow("large");
});

test("only the stable extension can request startup; arbitrary operations never run", async () => {
  let starts = 0;
  const start = async () => { starts++; };
  for (const message of [null, [], {}, { action: "apply" }, { action: "start", command: "evil" }]) {
    expect((await handleNativeRequest(NATIVE_HOST_ORIGIN, message, start)).ok).toBe(false);
  }
  expect((await handleNativeRequest("chrome-extension://foreign/", { action: "start" }, start)).ok).toBe(false);
  expect(starts).toBe(0);
  expect(await handleNativeRequest(NATIVE_HOST_ORIGIN, { action: "start" }, start)).toEqual({ ok: true });
  expect(starts).toBe(1);
  expect(await handleNativeRequest(NATIVE_HOST_ORIGIN, { action: "start" }, async () => { throw Error("Port occupied"); })).toEqual({ ok: false, error: "Port occupied" });
});

test("registration targets per-user browser host directories", () => {
  expect(nativeHostDirectories("/test/home", "linux")).toContain("/test/home/.config/google-chrome/NativeMessagingHosts");
  expect(nativeHostDirectories("/test/home", "darwin")).toContain("/test/home/Library/Application Support/Google/Chrome/NativeMessagingHosts");
});

test("Chrome-style native subprocess returns framed JSON and reuses the matching service", async () => {
  const root = await mkdtemp(join(tmpdir(), "wat-native-"));
  let probes = 0;
  const service = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    expect(new URL(request.url).pathname).toBe("/api/ping");
    probes++;
    return Response.json({ app: "wat-dashboard", dataDir: root });
  } });
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../mcp-server/src/cli.ts"), "--native-host", NATIVE_HOST_ORIGIN], {
    env: { ...process.env, WAT_DATA_DIR: root, WAT_DASHBOARD_PORT: String(service.port) },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  try {
    const logs = new Response(child.stderr).text();
    child.stdin.write(encodeMessage({ action: "start" }));
    child.stdin.end();
    expect(await readMessage(child.stdout)).toEqual({ ok: true });
    expect(await child.exited).toBe(0);
    expect(probes).toBe(1);
    expect(await logs).toBe("");
  } finally {
    child.kill();
    await child.exited;
    await service.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("the startup wrapper pins the data directory and attempt ledger", () => {
  const script = nativeHostWrapper({ dataRoot: "/data's", port: "39452", ledgerPath: "/state/attempts.sqlite", command: ["/bin/bun", "/repo/cli.ts"], documentRoots: "/docs" });
  expect(script).toContain("export WAT_DATA_DIR='/data'\\''s'\n");
  expect(script).toContain("export WATERLOOWORKS_LEDGER_PATH='/state/attempts.sqlite'\n");
  expect(script).toContain("export WATERLOOWORKS_DOCUMENT_ROOTS='/docs'\n");
  expect(script).toEndWith(`exec '/bin/bun' '/repo/cli.ts' --native-host "$@"\n`);
  expect(nativeHostWrapper({ dataRoot: "/d", port: "1", ledgerPath: "/l", command: ["/release/app"] })).not.toContain("DOCUMENT_ROOTS");
});
