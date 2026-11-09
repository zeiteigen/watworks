import { expect, test } from "bun:test";
import { createAccountSync } from "./hosted-signin.js";

test("a signal during a check runs exactly one more pass", async () => {
  let calls = 0, release = () => {};
  const sync = createAccountSync(async () => { calls++; if (calls === 1) await new Promise<void>(resolve => { release = resolve; }); });
  const first = sync.run();
  void sync.run(); void sync.run();
  expect(calls).toBe(1);
  release();
  await first;
  expect(calls).toBe(2);
});

test("a burst of scheduled signals collapses into one check", async () => {
  let calls = 0;
  const sync = createAccountSync(async () => { calls++; }, 5);
  sync.schedule(); sync.schedule(); sync.schedule();
  await Bun.sleep(25);
  expect(calls).toBe(1);
});

test("stop cancels a scheduled check", async () => {
  let calls = 0;
  const sync = createAccountSync(async () => { calls++; }, 5);
  sync.schedule(); sync.stop();
  await Bun.sleep(25);
  expect(calls).toBe(0);
});

test("a failed check does not wedge later checks", async () => {
  let calls = 0;
  const sync = createAccountSync(async () => { if (++calls === 1) throw new Error("offline"); });
  await expect(sync.run()).rejects.toThrow("offline");
  await sync.run();
  expect(calls).toBe(2);
});
