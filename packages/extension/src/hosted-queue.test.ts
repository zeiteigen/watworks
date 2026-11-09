import { expect, test } from "bun:test";
import { hostedQueueNeedsPolling } from "./hosted-queue.js";

test("hosted queue refreshes only while operations are active", () => {
  expect(hostedQueueNeedsPolling({ jobs: [{ jobId: "1", status: "confirm_required" }], runs: [] })).toBe(true);
  expect(hostedQueueNeedsPolling({ jobs: [{ jobId: "2", status: "uncertain" }], runs: [] })).toBe(false);
  expect(hostedQueueNeedsPolling({ jobs: [], runs: [{ status: "running" }] })).toBe(true);
  expect(hostedQueueNeedsPolling({ jobs: [], runs: [{ status: "ready" }] })).toBe(false);
});
