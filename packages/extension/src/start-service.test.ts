import { expect, test } from "bun:test";
import { createServiceStarter } from "./start-service.js";

test("an existing service needs no native process", async () => {
  const start = createServiceStarter(async () => true, async () => { throw Error("Must not launch"); });
  await start();
});

test("offline startup coalesces concurrent requests and can restart after a later failure", async () => {
  let launches = 0;
  const start = createServiceStarter(async () => false, async () => { launches++; return { ok: true }; });
  await Promise.all([start(), start(), start()]);
  expect(launches).toBe(1);
  await start();
  expect(launches).toBe(2);
});

test("missing registration and service errors are surfaced, without submitting anything", async () => {
  const missing = createServiceStarter(async () => false, async () => { throw Error("Host not found"); });
  await expect(missing()).rejects.toThrow("install:native-host");
  const failed = createServiceStarter(async () => false, async () => ({ ok: false, error: "Port occupied" }));
  await expect(failed()).rejects.toThrow("Port occupied");
});
