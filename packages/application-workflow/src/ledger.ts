import { ReviewBeforeMutationError } from "../../approval/src/types.js";
import { operationFailureSchema, type OperationFailure } from "../../shared/src/operation-failure.js";
import { fingerprint } from "./fingerprint.js";
import { migrateAttemptLedger } from "./ledger-schema.js";
import { Database } from "bun:sqlite";
import { closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

export type AttemptState = "reserved" | "staging" | "submitting" | "succeeded" | "failed" | "outcome_unknown";

export interface ReserveAttempt {
  attemptId: string;
  accountKey: string;
  operationKey: string;
  manifestHash: string;
  kind: string;
}

export interface AttemptRecord extends ReserveAttempt {
  state: AttemptState;
  createdAt: number;
  updatedAt: number;
  receiptId: string | null;
  accountReleasedAt: number | null;
  accountReleaseEvidence: string | null;
  noRemoteMutation: number;
  retryAuthorizedAt: number | null;
  retryEvidence: string | null;
}

interface AccountReleaseBase {
  accountKey: string;
  jobId: string;
  checkedAt: number;
  reason: string;
}

export type AccountReleaseEvidence = AccountReleaseBase & (
  | { hasApplication: false }
  | { hasApplication: true; manualApplicationConfirmed: true }
);

interface ApplicationRetryEvidence {
  accountKey: string;
  jobId: string;
  term: string;
  checkedAt: number;
  inventoryChecked: boolean;
}

export class AttemptConflictError extends Error {
  constructor(public readonly attempt: AttemptRecord, public readonly reason: "operation" | "account" = "operation") {
    super(`${reason === "operation" ? "Operation already has" : "Account has an unresolved"} attempt ${attempt.attemptId} (${attempt.state})`);
    this.name = "AttemptConflictError";
  }
}

const transitions: Record<AttemptState, readonly AttemptState[]> = {
  reserved: ["staging", "failed"],
  staging: ["submitting", "failed", "outcome_unknown"],
  submitting: ["succeeded", "outcome_unknown"],
  // Reconciliation may resolve an unknown outcome, but must never resubmit it.
  outcome_unknown: ["succeeded"],
  succeeded: [],
  failed: [],
};

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function secureDatabasePath(path: string): string {
  if (!isAbsolute(path)) throw new Error("Attempt ledger path must be absolute");
  const absolute = resolve(path);
  const parent = dirname(absolute);
  const uid = process.getuid?.();
  let current = parse(parent).root;
  // Inspect each component before creating it; recursive mkdir would follow links.
  for (const component of parent.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      const entry = lstatSync(current);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Attempt ledger directory must not contain symlinks");
    } catch (error) {
      if (!missing(error)) throw error;
      try { mkdirSync(current, { mode: 0o700 }); }
      catch (createError) {
        if ((createError as NodeJS.ErrnoException).code !== "EEXIST") throw createError;
      }
      const entry = lstatSync(current);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Attempt ledger directory must not contain symlinks");
    }
  }
  const directory = lstatSync(parent);
  if (uid !== undefined && ((directory.mode & 0o777) !== 0o700 || directory.uid !== uid)) {
    throw new Error("Attempt ledger parent must be owned by the current user with mode 0700");
  }
  try {
    const descriptor = openSync(absolute, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    closeSync(descriptor);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  for (const candidate of [absolute, `${absolute}-wal`, `${absolute}-shm`, `${absolute}-journal`]) {
    try {
      const entry = lstatSync(candidate);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || (uid !== undefined && (entry.uid !== uid || (entry.mode & 0o777) !== 0o600))) {
        throw new Error("Attempt ledger files must be regular, privately owned files with mode 0600");
      }
    } catch (error) {
      if (candidate === absolute || !missing(error)) throw error;
    }
  }
  return absolute;
}

function boundedText(value: string, name: string, maximum: number): void {
  if (typeof value !== "string" || !value.length || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid ${name}`);
  }
}

/** Durable, user-local duplicate protection. Records intentionally contain no application contents. */
export class AttemptLedger {
  private readonly database: Database;

  constructor(path: string) {
    this.database = new Database(secureDatabasePath(path), { strict: true });
    try {
      this.database.exec("PRAGMA busy_timeout = 5000;");
      // Concurrent first opens can race while SQLite switches journal modes.
      // The busy handler does not wait for every journal-mode lock upgrade.
      const deadline = Date.now() + 5000;
      for (;;) {
        try { this.database.exec("PRAGMA journal_mode = WAL;"); break; }
        catch (error) {
          if ((error as { code?: string }).code !== "SQLITE_BUSY" || Date.now() >= deadline) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      this.database.exec("PRAGMA synchronous = FULL;");
      migrateAttemptLedger(this.database);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  reserve(input: ReserveAttempt): AttemptRecord {
    boundedText(input.attemptId, "attempt id", 128);
    boundedText(input.kind, "attempt kind", 64);
    for (const [name, value] of Object.entries({ accountKey: input.accountKey, operationKey: input.operationKey, manifestHash: input.manifestHash })) {
      if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid ${name}: expected a SHA-256 hex digest`);
    }
    return this.database.transaction(() => {
      const existing = this.findOperation(input.operationKey);
      if (existing) throw new AttemptConflictError(existing);
      const active = this.database.query<AttemptRecord, [string]>(`SELECT * FROM application_attempts
        WHERE accountKey = ? AND state IN ('reserved','staging','submitting','outcome_unknown')
          AND (state != 'outcome_unknown' OR accountReleasedAt IS NULL)`).get(input.accountKey);
      if (active) throw new AttemptConflictError(active, "account");
      const now = Date.now();
      this.database.query(`INSERT INTO application_attempts
        (attemptId, accountKey, operationKey, manifestHash, kind, state, createdAt, updatedAt, receiptId)
        VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?, NULL)`)
        .run(input.attemptId, input.accountKey, input.operationKey, input.manifestHash, input.kind, now, now);
      this.recordEvent(input.attemptId, "reserved");
      return this.get(input.attemptId)!;
    }).immediate();
  }

  /** Release only the account-wide block after a recent, audited read-only reconciliation. */
  releaseAccountQuarantine(attemptId: string, evidence: AccountReleaseEvidence): AttemptRecord {
    if (!evidence || typeof evidence !== "object") throw new Error("Invalid account release evidence");
    if (!/^[a-f0-9]{64}$/.test(evidence.accountKey)) throw new Error("Invalid accountKey: expected a SHA-256 hex digest");
    if (typeof evidence.jobId !== "string" || !/^\d{1,32}$/.test(evidence.jobId)) throw new Error("Invalid job id");
    if (typeof evidence.checkedAt !== "number" || !Number.isSafeInteger(evidence.checkedAt)) throw new Error("Invalid checkedAt");
    if (evidence.hasApplication !== false && !(evidence.hasApplication === true && evidence.manualApplicationConfirmed === true)) {
      throw new Error("Account release requires no application or explicit confirmation of a manual application");
    }
    boundedText(evidence.reason, "account release reason", 500);
    return this.database.transaction(() => {
      const existing = this.get(attemptId);
      if (!existing) throw new Error("Attempt does not exist");
      if (existing.state !== "outcome_unknown") throw new Error("Only an outcome_unknown attempt can release account quarantine");
      if (existing.accountReleasedAt !== null) throw new Error("Account quarantine was already released");
      if (existing.accountKey !== evidence.accountKey) throw new Error("Evidence account does not match attempt account");
      const now = Date.now();
      if (Math.max(existing.createdAt, existing.updatedAt) > now - 120_000) throw new Error("Attempt is too recent to release account quarantine");
      if (evidence.checkedAt < now - 60_000 || evidence.checkedAt > now + 5_000) throw new Error("Reconciliation evidence is stale or in the future");
      const audit = JSON.stringify({ accountKey: evidence.accountKey, jobId: evidence.jobId, checkedAt: evidence.checkedAt, hasApplication: evidence.hasApplication, ...(evidence.hasApplication ? { manualApplicationConfirmed: true } : {}), reason: evidence.reason });
      this.database.query("UPDATE application_attempts SET accountReleasedAt = ?, accountReleaseEvidence = ? WHERE attemptId = ?")
        .run(now, audit, attemptId);
      return this.get(attemptId)!;
    }).immediate();
  }

  listAccountBlocks(): AttemptRecord[] {
    return this.database.query<AttemptRecord, []>(`SELECT * FROM application_attempts
      WHERE state IN ('reserved','staging','submitting','outcome_unknown')
        AND (state != 'outcome_unknown' OR accountReleasedAt IS NULL)
      ORDER BY createdAt`).all();
  }

  /** A human may release other jobs without claiming the uncertain attempt succeeded or is retryable. */
  releaseAccountBlockManually(attemptId: string, expectedUpdatedAt: number, reason: string): AttemptRecord {
    boundedText(reason, "release reason", 500);
    if (!reason.trim()) throw new Error("A release reason is required");
    return this.database.transaction(() => {
      const attempt = this.get(attemptId);
      if (!attempt || attempt.accountReleasedAt !== null) throw new Error("This block no longer exists; refresh the dashboard");
      if (attempt.updatedAt !== expectedUpdatedAt) throw new Error("This attempt changed; refresh before releasing it");
      if (!["reserved", "staging", "submitting", "outcome_unknown"].includes(attempt.state)) throw new Error("This attempt no longer blocks the account");
      const now = Date.now();
      const delay = attempt.state === "outcome_unknown" ? 120_000 : 300_000;
      if (Math.max(attempt.createdAt, attempt.updatedAt) > now - delay) throw new Error(attempt.state === "outcome_unknown" ? "Wait two minutes after the uncertain attempt before releasing its block" : "An active operation cannot be released until five minutes without updates");
      this.database.query("UPDATE application_attempts SET state = 'outcome_unknown', accountReleasedAt = ?, accountReleaseEvidence = ? WHERE attemptId = ?")
        .run(now, JSON.stringify({ source: "dashboard_user", previousState: attempt.state, action: "release_account_block", reason: reason.trim(), acknowledgedUncertainOutcome: true, releasedAt: now }), attemptId);
      return this.get(attemptId)!;
    }).immediate();
  }

  /** Only a transport proof that no write was dispatched can make an operation retryable. */
  failBeforeMutation(attemptId: string, proof: ReviewBeforeMutationError): AttemptRecord {
    if (!(proof instanceof ReviewBeforeMutationError)) throw new Error("Missing no-mutation proof");
    return this.database.transaction(() => {
      const existing = this.get(attemptId);
      if (!existing || !["staging", "submitting"].includes(existing.state)) throw new Error("Attempt cannot be failed before mutation");
      this.database.query("UPDATE application_attempts SET state = 'failed', noRemoteMutation = 1, updatedAt = ? WHERE attemptId = ?")
        .run(Math.max(Date.now(), existing.updatedAt + 1), attemptId);
      this.recordEvent(attemptId, "failed_before_mutation");
      return this.get(attemptId)!;
    }).immediate();
  }

  /** Only mark failed when the caller has established that no remote effect occurred. */
  transition(attemptId: string, state: Exclude<AttemptState, "reserved">, receiptId?: string): AttemptRecord {
    if (receiptId !== undefined) {
      boundedText(receiptId, "receipt id", 256);
      if (state !== "succeeded") throw new Error("A receipt can only be recorded for a succeeded attempt");
    }
    return this.database.transaction(() => {
      const existing = this.get(attemptId);
      if (!existing) throw new Error("Attempt does not exist");
      if (!transitions[existing.state].includes(state)) throw new Error(`Illegal attempt transition: ${existing.state} -> ${state}`);
      this.database.query("UPDATE application_attempts SET state = ?, updatedAt = ?, receiptId = ? WHERE attemptId = ?")
        .run(state, Math.max(Date.now(), existing.updatedAt + 1), receiptId ?? null, attemptId);
      this.recordEvent(attemptId, state);
      return this.get(attemptId)!;
    }).immediate();
  }

  get(attemptId: string): AttemptRecord | null {
    return this.database.query<AttemptRecord, [string]>("SELECT * FROM application_attempts WHERE attemptId = ?").get(attemptId);
  }

  findOperation(operationKey: string): AttemptRecord | null {
    return this.database.query<AttemptRecord, [string]>("SELECT * FROM application_attempts WHERE operationKey = ? AND noRemoteMutation = 0 AND retryAuthorizedAt IS NULL").get(operationKey);
  }

  /** Human-authorized recovery retains the original uncertain history and its evidence. */
  authorizeApplicationRetry(attemptId: string, expectedUpdatedAt: number, evidence: ApplicationRetryEvidence & { operationKey: string }, source: "dashboard_user" | "filled_form_check" = "dashboard_user"): AttemptRecord {
    return this.database.transaction(() => {
      const attempt = this.get(attemptId);
      const now = Date.now();
      const filled = attempt?.kind === "application" && attempt.state === "succeeded" && attempt.receiptId === null;
      const staged = attempt?.kind === "stage_application_documents" && attempt.state === "succeeded";
      const eligible = source === "filled_form_check" ? filled || staged : attempt && (["failed", "outcome_unknown"].includes(attempt.state) || staged);
      if (!attempt || !["application", "stage_application_documents"].includes(attempt.kind) || !eligible || attempt.retryAuthorizedAt !== null) throw new Error("This application attempt cannot be unlocked");
      if (attempt.updatedAt !== expectedUpdatedAt || Math.max(attempt.createdAt, attempt.updatedAt) > now - 120_000) throw new Error("The attempt changed or is too recent; refresh and wait two minutes");
      const expectedKey = attempt.kind === "application" ? fingerprint(["application", evidence.accountKey, evidence.jobId, evidence.term]) : fingerprint(["stage_documents", evidence.accountKey, evidence.jobId, attempt.manifestHash]);
      if (attempt.accountKey !== evidence.accountKey || attempt.operationKey !== evidence.operationKey || evidence.operationKey !== expectedKey || !/^\d{1,32}$/.test(evidence.jobId) || !evidence.term) throw new Error("Retry evidence does not match the application");
      if (!Number.isSafeInteger(evidence.checkedAt) || evidence.checkedAt < now - 60_000 || evidence.checkedAt > now + 5_000) throw new Error("Retry evidence is stale");
      this.database.query(`UPDATE application_attempts SET retryAuthorizedAt = ?, retryEvidence = ?, accountReleasedAt = COALESCE(accountReleasedAt, ?) WHERE attemptId = ?`)
        .run(now, JSON.stringify({ ...evidence, source, hasApplication: false, formOpen: source === "dashboard_user", inventoryAbsent: evidence.inventoryChecked ? true : null, uploadsMayExist: attempt.kind === "stage_application_documents", freshApprovalRequired: true }), now, attemptId);
      this.recordEvent(attemptId, "retry_authorized");
      return this.get(attemptId)!;
    }).immediate();
  }

  recordEvent(attemptId: string, event: string, failure?: OperationFailure): void {
    this.database.query("INSERT INTO application_events(attemptId, at, event, failure) VALUES (?, ?, ?, ?)")
      .run(attemptId, Date.now(), event, failure ? JSON.stringify(operationFailureSchema.parse(failure)) : null);
  }

  events(attemptId: string) {
    return this.database.query<{ at: number; event: string; failure: string | null }, [string]>("SELECT at, event, failure FROM application_events WHERE attemptId = ? ORDER BY id").all(attemptId)
      .map(row => ({ at: row.at, event: row.event, ...(row.failure ? { failure: operationFailureSchema.parse(JSON.parse(row.failure)) } : {}) }));
  }

  recoveryAttempts(accountKey: string, jobId: string, term: string): AttemptRecord[] {
    return this.database.query<AttemptRecord, [string]>("SELECT * FROM application_attempts WHERE accountKey = ? AND noRemoteMutation = 0 AND retryAuthorizedAt IS NULL ORDER BY createdAt DESC").all(accountKey)
      .filter(attempt => attempt.kind === "application" ? attempt.operationKey === fingerprint(["application",accountKey,jobId,term])
        : attempt.kind === "stage_application_documents" && attempt.operationKey === fingerprint(["stage_documents",accountKey,jobId,attempt.manifestHash]));
  }

  authorizeApplicationRetries(attempts: AttemptRecord[], evidence: ApplicationRetryEvidence, source: "dashboard_user" | "filled_form_check" = "dashboard_user"): AttemptRecord[] {
    return this.database.transaction(() => attempts.map(attempt => this.authorizeApplicationRetry(attempt.attemptId, attempt.updatedAt, {...evidence,operationKey:attempt.operationKey}, source))).immediate();
  }

  close(): void {
    this.database.close();
  }
}
