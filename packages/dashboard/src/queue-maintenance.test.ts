import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../../workspace/src/store.js";
import { JOB_STATES } from "../../workspace/src/schemas.js";
import { discardExpiredJobs } from "./queue-maintenance.js";

test("expiry uses Toronto time, retains unknown deadlines and application outcomes, and is idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wat-expiry-"));
  const workspace = new Workspace(dir);
  const clock = Date.parse("2026-11-02T14:00:00Z");
  try {
    for (const state of JOB_STATES) {
      const key = { source: "waterlooworks", jobId: state };
      await workspace.saveJob(key, { summary: { source: key.source, jobId: key.jobId, title: state, employer: "Example", requiredDocuments: [], deadline: "Nov 2, 2026 9:00 AM" }, posting: {} }, "Posting");
      await workspace.setStatus(key, { state });
    }
    for (const [jobId, deadline] of [["unknown", "2026-11-02"], ["future", "Nov 3, 2026 9:00 AM"], ["active", "Nov 2, 2026 9:00 AM"]]) {
      await workspace.saveJob({ source: "waterlooworks", jobId: jobId! }, { summary: { source: "waterlooworks", jobId: jobId!, title: jobId!, employer: "Example", requiredDocuments: [], deadline: deadline! }, posting: {} }, "Posting");
    }
    const active = (key: { jobId: string }) => key.jobId === "active";
    await discardExpiredJobs(workspace, active, clock);
    const jobs = await workspace.listJobs();
    expect(jobs.filter(job => job.status.removedFromQueueAt).map(job => job.key.split(":")[1]).sort()).toEqual(["failed", "found", "planned", "ready", "skipped"]);
    expect(jobs.filter(job => !job.status.removedFromQueueAt).map(job => job.key.split(":")[1]).sort()).toEqual(["active", "applied", "applying", "confirm_required", "form_filled", "future", "outcome_unknown", "unknown"]);
    const statuses = jobs.map(job => job.status);
    await discardExpiredJobs(workspace, active, clock + 60_000);
    expect((await workspace.listJobs()).map(job => job.status)).toEqual(statuses);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
