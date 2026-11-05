import type { AttemptLedger } from "./ledger.js";
import type { ApplicationGateway } from "./types.js";

/** Called only by a human recovery click. Reads verify absence; submission needs a new approval. */
export async function authorizeApplicationRetry(gateway: ApplicationGateway, ledger: AttemptLedger,
  jobId: string, term: string, isExecuting: (id: string) => boolean) {
  const account = await gateway.getAccount();
  const attempts = ledger.recoveryAttempts(account.accountKey, jobId, term);
  if (attempts.some(attempt=>isExecuting(attempt.attemptId))) throw new Error("This application is still executing");
  const form = await gateway.getApplicationForm(jobId);
  // The posting's authoritative presence flag and a freshly open form can
  // establish absence even when the separate history viewer is unsupported.
  // An available inventory is an additional cross-check, never fabricated.
  const inventory = await gateway.listApplications?.().catch(()=>undefined);
  const status = await gateway.getApplicationStatus(jobId);
  const checkedAt = inventory ? Date.parse(inventory.checkedAt) : Date.now();
  if (!Number.isSafeInteger(checkedAt) || checkedAt < Date.now() - 60_000 || checkedAt > Date.now() + 5_000) throw new Error("Application status is stale. Refresh WaterlooWorks and try again.");
  if ((await gateway.getAccount()).accountKey !== account.accountKey || form.accountKey !== account.accountKey || (inventory && inventory.accountKey !== account.accountKey)) throw new Error("WaterlooWorks account changed");
  if (form.jobId !== jobId || form.term !== term || form.hasApplication || status.jobId !== jobId || status.hasApplication
    || inventory?.applications.some(item => item.jobId === jobId && item.term === term)) throw new Error("WaterlooWorks does not confirm this application is absent; retry remains locked");
  if (!form.canApply || form.blockers.length || Date.parse(form.deadline) <= Date.now()) throw new Error("The posting is no longer available for a supported application");
  if (attempts.some(attempt=>isExecuting(attempt.attemptId))) throw new Error("This application is still executing");
  return ledger.authorizeApplicationRetries(attempts, { accountKey: account.accountKey, jobId, term, checkedAt, inventoryChecked: !!inventory });
}
