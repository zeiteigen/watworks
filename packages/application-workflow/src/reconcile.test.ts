import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewService } from "../../approval/src/index.js";
import { AttemptLedger } from "./ledger.js";
import { ApplicationWorkflow } from "./workflow.js";
import { fingerprint } from "./fingerprint.js";
import type { ApplicationGateway, ApplicationInventory } from "./types.js";

test("reconciliation releases account quarantine after verified absence but preserves the posting replay lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "wat-reconcile-"));
  const ledgerPath = join(root, "ledger.sqlite");
  const ledger = new AttemptLedger(ledgerPath);
  const accountKey = "a".repeat(64), operationKey = fingerprint(["application", accountKey, "123", "2027 - Winter"]);
  const clock = Date.now;
  try {
    Date.now = () => clock() - 180_000;
    ledger.reserve({ attemptId: "attempt", accountKey, operationKey, manifestHash: "b".repeat(64), kind: "application" });
    ledger.transition("attempt", "staging"); ledger.transition("attempt", "submitting"); ledger.transition("attempt", "outcome_unknown");
  } finally { Date.now = clock; }
  let hasApplication = false;
  const gateway = { getAccount: async () => ({ accountKey }), getApplicationStatus: async (jobId: string) => ({ jobId, hasApplication }) } as ApplicationGateway;
  const workflow = new ApplicationWorkflow({ gateway, ledgerPath, documentRoots: [], reviews: new ReviewService({ serve: false }) });
  const inventory: ApplicationInventory = { accountKey, checkedAt: new Date().toISOString(), termId: "437", applications: [] };
  try {
    hasApplication = true;
    await workflow.reconcileApplication("123", "2027 - Winter", inventory);
    expect(ledger.get("attempt")?.accountReleasedAt).toBeNull();
    hasApplication = false;
    await workflow.reconcileApplication("123", "2027 - Winter", inventory);
    expect(ledger.get("attempt")).toMatchObject({ state: "outcome_unknown", noRemoteMutation: 0, accountReleasedAt: expect.any(Number) });
    expect(() => ledger.reserve({ attemptId: "retry", accountKey, operationKey, manifestHash: "c".repeat(64), kind: "application" })).toThrow("Operation already");
    expect(ledger.reserve({ attemptId: "different-job", accountKey, operationKey: "d".repeat(64), manifestHash: "c".repeat(64), kind: "application" }).state).toBe("reserved");
    await expect(workflow.reconcileApplication("123", "2027 - Winter", { ...inventory, accountKey: "e".repeat(64) })).rejects.toThrow("account changed");
    hasApplication = true;
    inventory.applications.push({ applicationId: "900", jobId: "123", term: "2027 - Winter", status: "Applied", submittedAt: new Date().toISOString(), title: "Developer", employer: "Acme", location: "Toronto" });
    await workflow.reconcileApplication("123", "2027 - Winter", inventory);
    expect(ledger.get("attempt")).toMatchObject({ state: "succeeded", receiptId: "900" });
    expect(workflow.getOperationStatus("attempt")).toMatchObject({ status: "succeeded", receiptId: "900" });
  } finally { await workflow.close(); ledger.close(); await rm(root, { recursive: true, force: true }); }
});
