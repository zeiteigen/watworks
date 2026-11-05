import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { AttemptConflictError, AttemptLedger, type ReserveAttempt } from "./ledger.js";

const roots: string[] = [];
const ledgers: AttemptLedger[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "application-ledger-test-"));
  roots.push(root);
  return join(root, "state", "attempts.sqlite");
}
function open(path: string): AttemptLedger {
  const ledger = new AttemptLedger(path);
  ledgers.push(ledger);
  return ledger;
}
const attempt: ReserveAttempt = {
  attemptId: "attempt-one", accountKey: "a".repeat(64), operationKey: "b".repeat(64), manifestHash: "c".repeat(64), kind: "application",
};

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable application attempt ledger", () => {
  test("adds release audit columns when reopening a pre-release ledger", () => {
    const path = fixture();
    mkdirSync(join(path, ".."), { mode: 0o700 });
    const db = new Database(path);
    db.exec(`CREATE TABLE application_attempts (
      attemptId TEXT PRIMARY KEY, accountKey TEXT NOT NULL, operationKey TEXT NOT NULL UNIQUE,
      manifestHash TEXT NOT NULL, kind TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('reserved','staging','submitting','succeeded','failed','outcome_unknown')),
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, receiptId TEXT
    );
    CREATE UNIQUE INDEX application_attempts_active_account ON application_attempts (accountKey)
      WHERE state IN ('reserved','staging','submitting','outcome_unknown');`);
    const insert = db.query("INSERT INTO application_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    insert.run("legacy-receipt", attempt.accountKey, "d".repeat(64), attempt.manifestHash, "application", "succeeded", 1, 2, "verified-receipt");
    insert.run("legacy-unknown", "e".repeat(64), "f".repeat(64), attempt.manifestHash, "application", "outcome_unknown", 1, 2, null);
    db.close();
    chmodSync(path, 0o600);
    const ledger = open(path);
    expect(ledger.get("legacy-receipt")).toMatchObject({ state: "succeeded", receiptId: "verified-receipt", noRemoteMutation: 0 });
    expect(ledger.get("legacy-unknown")).toMatchObject({ state: "outcome_unknown", noRemoteMutation: 0 });
    expect(() => ledger.reserve({ ...attempt, attemptId: "blocked", accountKey: "e".repeat(64) })).toThrow(AttemptConflictError);
    expect(ledger.reserve(attempt).accountReleasedAt).toBeNull();
  });

  test("reserves before mutation and blocks the same operation across instances and reopen", () => {
    const path = fixture();
    const first = open(path);
    const second = open(path);
    const row = first.reserve(attempt);
    expect(row.state).toBe("reserved");
    expect(second.get(attempt.attemptId)).toEqual(row);
    expect(() => second.reserve({ ...attempt, attemptId: "other-process" })).toThrow(AttemptConflictError);
    first.close();
    second.close();
    const reopened = open(path);
    expect(reopened.get(attempt.attemptId)).toEqual(row);
    expect(() => reopened.reserve({ ...attempt, attemptId: "after-restart" })).toThrow(AttemptConflictError);
  });

  test.each(["shared operation", "different operations for one account"])("only one process reserves %s", async (scenario) => {
    const path = fixture();
    const module = new URL("./ledger.ts", import.meta.url).href;
    const children = Array.from({ length: 4 }, (_, index) => Bun.spawn([process.execPath, "-e", `
      import { AttemptLedger, AttemptConflictError } from ${JSON.stringify(module)};
      const ledger = new AttemptLedger(${JSON.stringify(path)});
      try {
        ledger.reserve(${JSON.stringify({ ...attempt, attemptId: `process-${index}`, operationKey: scenario === "shared operation" ? attempt.operationKey : String(index + 1).repeat(64) })});
      } catch (error) {
        if (!(error instanceof AttemptConflictError)) throw error;
        process.exitCode = 10;
      } finally { ledger.close(); }
    `], { stdout: "ignore", stderr: "pipe" }));
    const outcomes = await Promise.all(children.map(async (child) => {
      const [code, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(errors).toBe("");
      expect([0, 10]).toContain(code);
      return code;
    }));
    expect(outcomes.filter((value) => value === 0)).toHaveLength(1);
    expect(outcomes.filter((value) => value === 10)).toHaveLength(3);
  });

  test("a process killed after reservation leaves a durable block", async () => {
    const path = fixture();
    const module = new URL("./ledger.ts", import.meta.url).href;
    const child = Bun.spawn([process.execPath, "-e", `
      import { AttemptLedger } from ${JSON.stringify(module)};
      const ledger = new AttemptLedger(${JSON.stringify(path)});
      ledger.reserve(${JSON.stringify(attempt)});
      process.kill(process.pid, "SIGKILL");
    `], { stdout: "ignore", stderr: "pipe" });
    const [exitCode, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode).not.toBe(0);
    expect(errors).toBe("");
    const ledger = open(path);
    expect(ledger.get(attempt.attemptId)?.state).toBe("reserved");
    expect(() => ledger.reserve({ ...attempt, attemptId: "after-crash" })).toThrow(AttemptConflictError);
  });

  test("guards state transitions and preserves unknown and successful outcomes", () => {
    const path = fixture();
    const ledger = open(path);
    const reserved = ledger.reserve(attempt);
    expect(() => ledger.transition(attempt.attemptId, "succeeded")).toThrow("Illegal attempt transition");
    const staged = ledger.transition(attempt.attemptId, "staging");
    expect(staged.updatedAt).toBeGreaterThan(reserved.updatedAt);
    ledger.transition(attempt.attemptId, "submitting");
    expect(() => ledger.transition(attempt.attemptId, "failed")).toThrow("Illegal attempt transition");
    ledger.transition(attempt.attemptId, "outcome_unknown");
    ledger.close();
    const reopened = open(path);
    expect(reopened.get(attempt.attemptId)?.state).toBe("outcome_unknown");
    expect(() => reopened.reserve({ ...attempt, attemptId: "retry" })).toThrow(AttemptConflictError);
    const successful = reopened.transition(attempt.attemptId, "succeeded", "receipt-123");
    expect(successful.receiptId).toBe("receipt-123");
    expect(() => reopened.transition(attempt.attemptId, "staging")).toThrow("Illegal attempt transition");
    expect(() => reopened.reserve({ ...attempt, attemptId: "retry-success" })).toThrow(AttemptConflictError);
    expect(reopened.reserve({ ...attempt, attemptId: "next-posting", operationKey: "d".repeat(64) }).state).toBe("reserved");
  });

  test("every unresolved state serializes account mutations while another account can proceed", () => {
    const path = fixture();
    const ledger = open(path);
    const peer = open(path);
    ledger.reserve(attempt);
    const differentOperation = { ...attempt, attemptId: "different-posting", operationKey: "d".repeat(64) };
    for (const state of ["reserved", "staging", "submitting", "outcome_unknown"] as const) {
      if (state !== "reserved") ledger.transition(attempt.attemptId, state);
      try {
        peer.reserve(differentOperation);
        throw new Error("Expected unresolved account conflict");
      } catch (error) {
        expect(error).toBeInstanceOf(AttemptConflictError);
        expect((error as AttemptConflictError).reason).toBe("account");
        expect((error as AttemptConflictError).attempt.attemptId).toBe(attempt.attemptId);
      }
    }
    expect(peer.reserve({ ...differentOperation, accountKey: "e".repeat(64) }).state).toBe("reserved");
    ledger.close();
    peer.close();
    const reopened = open(path);
    expect(() => reopened.reserve({ ...differentOperation, attemptId: "after-restart", operationKey: "f".repeat(64) })).toThrow("Account has an unresolved");
  });

  test("audited release allows unrelated operations but never replays the unknown operation", () => {
    const path = fixture();
    const ledger = open(path);
    ledger.reserve(attempt);
    ledger.transition(attempt.attemptId, "staging");
    ledger.transition(attempt.attemptId, "submitting");
    ledger.transition(attempt.attemptId, "outcome_unknown");
    const ageDb = new Database(path);
    ageDb.query("UPDATE application_attempts SET createdAt = ?, updatedAt = ? WHERE attemptId = ?")
      .run(Date.now() - 180_000, Date.now() - 180_000, attempt.attemptId);
    ageDb.close();
    const evidence = { accountKey: attempt.accountKey, jobId: "486388", checkedAt: Date.now(), hasApplication: false as const, reason: "Read-only application list checked" };
    const released = ledger.releaseAccountQuarantine(attempt.attemptId, evidence);
    expect(released.state).toBe("outcome_unknown");
    expect(released.operationKey).toBe(attempt.operationKey);
    expect(released.accountReleasedAt).toBeNumber();
    expect(JSON.parse(released.accountReleaseEvidence!)).toEqual(evidence);
    ledger.close();
    const reopened = open(path);
    expect(reopened.get(attempt.attemptId)).toEqual(released);
    expect(() => reopened.reserve({ ...attempt, attemptId: "same-operation", operationKey: attempt.operationKey })).toThrow(AttemptConflictError);
    expect(reopened.reserve({ ...attempt, attemptId: "unrelated-operation", operationKey: "d".repeat(64) }).state).toBe("reserved");
  });

  test("manual application reconciliation releases only the account block and retains the uncertain attempt", () => {
    const path = fixture();
    const ledger = open(path);
    ledger.reserve(attempt);
    ledger.transition(attempt.attemptId, "staging");
    ledger.transition(attempt.attemptId, "submitting");
    ledger.transition(attempt.attemptId, "outcome_unknown");
    const ageDb = new Database(path);
    ageDb.query("UPDATE application_attempts SET createdAt = ?, updatedAt = ? WHERE attemptId = ?")
      .run(Date.now() - 180_000, Date.now() - 180_000, attempt.attemptId);
    ageDb.close();
    const evidence = { accountKey: attempt.accountKey, jobId: "491058", checkedAt: Date.now(), hasApplication: true as const,
      manualApplicationConfirmed: true as const, reason: "User confirmed manual application; authenticated read confirms presence" };
    expect(() => ledger.releaseAccountQuarantine(attempt.attemptId, { ...evidence, manualApplicationConfirmed: false } as any)).toThrow("explicit confirmation");
    const record = ledger.releaseAccountQuarantine(attempt.attemptId, evidence);
    expect(record.state).toBe("outcome_unknown");
    expect(record.receiptId).toBeNull();
    expect(JSON.parse(record.accountReleaseEvidence!)).toEqual(evidence);
    expect(() => ledger.reserve({ ...attempt, attemptId: "duplicate" })).toThrow(AttemptConflictError);
    expect(ledger.reserve({ ...attempt, attemptId: "unrelated", operationKey: "d".repeat(64) }).state).toBe("reserved");
  });

  test.each(["reserved", "staging", "submitting"] as const)("release rejects a %s attempt", (state) => {
    const ledger = open(fixture());
    ledger.reserve(attempt);
    if (state === "staging" || state === "submitting") ledger.transition(attempt.attemptId, "staging");
    if (state === "submitting") ledger.transition(attempt.attemptId, "submitting");
    const valid = { accountKey: attempt.accountKey, jobId: "486388", checkedAt: Date.now(), hasApplication: false as const, reason: "Checked" };
    expect(() => ledger.releaseAccountQuarantine(attempt.attemptId, valid)).toThrow("outcome_unknown");
  });

  test("release rejects recent, stale, future, and wrong-account evidence", () => {
    const ledger = open(fixture());
    ledger.reserve(attempt);
    ledger.transition(attempt.attemptId, "staging");
    ledger.transition(attempt.attemptId, "submitting");
    ledger.transition(attempt.attemptId, "outcome_unknown");
    const valid = { accountKey: attempt.accountKey, jobId: "486388", checkedAt: Date.now(), hasApplication: false as const, reason: "Checked" };
    expect(() => ledger.releaseAccountQuarantine(attempt.attemptId, valid)).toThrow("too recent");
    const ageDb = new Database(join(roots[roots.length - 1]!, "state", "attempts.sqlite"));
    ageDb.query("UPDATE application_attempts SET createdAt = ? WHERE attemptId = ?").run(Date.now() - 180_000, attempt.attemptId);
    expect(() => ledger.releaseAccountQuarantine(attempt.attemptId, valid)).toThrow("too recent");
    ageDb.query("UPDATE application_attempts SET updatedAt = ? WHERE attemptId = ?").run(Date.now() - 180_000, attempt.attemptId);
    ageDb.close();
    const expectReleaseError = (evidence: typeof valid, message: string) => {
      expect(() => ledger.releaseAccountQuarantine(attempt.attemptId, evidence)).toThrow(message);
    };
    expectReleaseError({ ...valid, accountKey: "e".repeat(64) }, "does not match");
    expectReleaseError({ ...valid, checkedAt: Date.now() - 61_000 }, "stale or in the future");
    expectReleaseError({ ...valid, checkedAt: Date.now() + 6_000 }, "stale or in the future");
    expectReleaseError({ ...valid, jobId: "abc" }, "Invalid job id");
  });

  test("does not recycle even a failed operation without explicit reconciliation", () => {
    const ledger = open(fixture());
    ledger.reserve(attempt);
    ledger.transition(attempt.attemptId, "failed");
    expect(() => ledger.reserve({ ...attempt, attemptId: "retry-failure" })).toThrow(AttemptConflictError);
    expect(ledger.reserve({ ...attempt, attemptId: "different-after-failure", operationKey: "d".repeat(64) }).state).toBe("reserved");
    expect(() => ledger.transition("missing", "failed")).toThrow("Attempt does not exist");
  });

  test("validates bounded metadata and only accepts a receipt on success", () => {
    const ledger = open(fixture());
    expect(() => ledger.reserve({ ...attempt, accountKey: "raw-account" })).toThrow("SHA-256");
    expect(() => ledger.reserve({ ...attempt, kind: "x".repeat(65) })).toThrow("Invalid attempt kind");
    expect(() => ledger.reserve({ ...attempt, attemptId: "id\nwith-control" })).toThrow("Invalid attempt id");
    ledger.reserve(attempt);
    expect(() => ledger.transition(attempt.attemptId, "staging", "receipt")).toThrow("only be recorded");
    ledger.transition(attempt.attemptId, "staging");
    ledger.transition(attempt.attemptId, "submitting");
    expect(() => ledger.transition(attempt.attemptId, "succeeded", "x".repeat(257))).toThrow("Invalid receipt id");
  });

  test.skipIf(process.getuid === undefined)("creates private directories and database including WAL sidecars", () => {
    const path = fixture();
    const ledger = open(path);
    ledger.reserve(attempt);
    expect(lstatSync(join(path, "..")).mode & 0o777).toBe(0o700);
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      expect(existsSync(file)).toBe(true);
      expect(lstatSync(file).mode & 0o777).toBe(0o600);
    }
  });

  test.skipIf(process.getuid === undefined)("rejects insecure existing parents without changing their permissions", () => {
    const path = fixture();
    mkdirSync(join(path, ".."), { mode: 0o755 });
    chmodSync(join(path, ".."), 0o755);
    expect(() => new AttemptLedger(path)).toThrow("mode 0700");
    expect(lstatSync(join(path, "..")).mode & 0o777).toBe(0o755);
    expect(existsSync(path)).toBe(false);
  });

  test.skipIf(process.getuid === undefined)("rejects insecure existing database and linked database or parent", () => {
    const path = fixture();
    const directory = join(path, "..");
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(path, "preserve", { mode: 0o644 });
    expect(() => new AttemptLedger(path)).toThrow("mode 0600");
    expect(readFileSync(path, "utf8")).toBe("preserve");
    chmodSync(path, 0o600);
    rmSync(path);
    const target = join(directory, "target");
    writeFileSync(target, "preserve", { mode: 0o600 });
    symlinkSync(target, path);
    expect(() => new AttemptLedger(path)).toThrow("regular");
    expect(readFileSync(target, "utf8")).toBe("preserve");
    const linked = join(directory, "link");
    symlinkSync(directory, linked);
    expect(() => new AttemptLedger(join(linked, "new.sqlite"))).toThrow("symlinks");
  });

  test("platforms without POSIX ownership APIs can open the ledger", () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    try {
      Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
      const ledger = open(fixture());
      expect(ledger.reserve(attempt).state).toBe("reserved");
    } finally {
      if (descriptor) Object.defineProperty(process, "getuid", descriptor);
      else Reflect.deleteProperty(process, "getuid");
    }
  });
});

test("manual release refuses active, recent, changed, and already released attempts", () => {
  const ledger = open(fixture());
  const clock = Date.now;
  try {
    Date.now = () => clock() - 180_000;
    ledger.reserve(attempt);
    ledger.transition(attempt.attemptId, "staging");
  } finally { Date.now = clock; }
  const active = ledger.get(attempt.attemptId)!;
  expect(() => ledger.releaseAccountBlockManually(active.attemptId, active.updatedAt, "I inspected it")).toThrow("active operation");
  ledger.transition(active.attemptId, "outcome_unknown");
  const recent = ledger.get(active.attemptId)!;
  expect(() => ledger.releaseAccountBlockManually(active.attemptId, recent.updatedAt, "I inspected it")).toThrow("two minutes");
  expect(() => ledger.releaseAccountBlockManually(active.attemptId, active.updatedAt, "I inspected it")).toThrow("changed");
  expect(() => ledger.releaseAccountBlockManually(active.attemptId, recent.updatedAt, " ")).toThrow("required");
  expect(ledger.listAccountBlocks()).toHaveLength(1);
  try {
    Date.now = () => clock() + 180_000;
    ledger.releaseAccountBlockManually(active.attemptId, recent.updatedAt, "I checked the site; unblock other applications");
    expect(ledger.listAccountBlocks()).toHaveLength(0);
    expect(() => ledger.releaseAccountBlockManually(active.attemptId, recent.updatedAt, "Again")).toThrow("no longer exists");
  } finally { Date.now = clock; }
});

test("a user can release an abandoned in-progress operation after five minutes, retaining its replay lock", () => {
  const ledger = open(fixture());
  const clock = Date.now;
  try {
    Date.now = () => clock() - 360_000;
    ledger.reserve(attempt);
    ledger.transition(attempt.attemptId, "staging");
    ledger.transition(attempt.attemptId, "submitting");
  } finally { Date.now = clock; }
  const previous = ledger.get(attempt.attemptId)!;
  ledger.releaseAccountBlockManually(previous.attemptId, previous.updatedAt, "The browser closed; unblock other jobs");
  const retained = ledger.get(previous.attemptId)!;
  expect(retained.state).toBe("outcome_unknown");
  expect(JSON.parse(retained.accountReleaseEvidence!)).toMatchObject({ previousState: "submitting", source: "dashboard_user" });
  expect(() => ledger.reserve({ ...attempt, attemptId: "duplicate" })).toThrow("Operation already");
});
