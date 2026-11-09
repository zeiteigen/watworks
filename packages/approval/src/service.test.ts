import { afterEach, describe, expect, test } from "bun:test";
import { manifestHash, ReviewBeforeMutationError, ReviewService, type CreateReviewInput, type CreatedReview } from "./index.js";

const services: ReviewService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map((service) => service.close())); });

function makeService(now?: () => number): ReviewService {
  const service = new ReviewService(now === undefined ? {} : { now });
  services.push(service);
  return service;
}

function input(overrides: Partial<CreateReviewInput> = {}): CreateReviewInput {
  const manifest = { jobId: "123", documents: [{ name: "resume.pdf", sha256: "document-digest" }] };
  return {
    id: "operation-1",
    manifest,
    manifestHash: manifestHash(manifest),
    actionLabel: "Approve and submit application",
    revalidate: async () => {},
    execute: async () => ({ receiptId: "receipt-1" }),
    ...overrides,
  };
}

function snapshot(service: ReviewService, review: CreatedReview) {
  const data = service.inspect(review.operationId);
  if (!data) throw new Error("Review is missing");
  return data;
}

function approve(service: ReviewService, review: CreatedReview, hash = snapshot(service, review).manifestHash) {
  return service.approve(review.operationId, hash);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("human review service security", () => {
  test("bounds captured PDF memory across reviews and releases it at expiry", () => {
    let now = 0;
    const service = makeService(() => now);
    const bytes = new Uint8Array(4 * 1024 * 1024);
    bytes.set(new TextEncoder().encode("%PDF-1.7"));
    for (let i = 0; i < 8; i++) service.createReview(input({ id: `memory-${i}`, documents: [{ id: "pdf", name: "synthetic.pdf", bytes }] }));
    expect(() => service.createReview(input({ id: "overflow", documents: [{ id: "pdf", name: "synthetic.pdf", bytes }] }))).toThrow("memory capacity");
    now = 15 * 60 * 1000;
    expect(service.createReview(input({ id: "after-expiry", documents: [{ id: "pdf", name: "synthetic.pdf", bytes }] })).status).toBe("awaiting_approval");
  });

  test("preserves captured bytes and removes them at review expiry", () => {
    let now = 0;
    const service = makeService(() => now);
    const bytes = new TextEncoder().encode("%PDF-1.7\noriginal captured contents\n%%EOF\n");
    const expected = new Uint8Array(bytes);
    const review = service.createReview(input({ documents: [{ id: "resume", name: "resume.pdf", bytes }] }));
    bytes.fill(0);
    expect(service.document(review.operationId, "resume")).toEqual(expected);
    expect(service.document(review.operationId, "missing")).toBeUndefined();
    now = 15 * 60 * 1000;
    expect(service.document(review.operationId, "resume")).toBeUndefined();
    expect(snapshot(service, review).documents).toEqual([]);
  });

  test("stores an immutable hash-bound snapshot and issues no bearer capability", () => {
    const service = makeService();
    const request = input();
    const review = service.createReview(request);
    expect(review).toEqual({ operationId: "operation-1", status: "awaiting_approval" });
    expect(service.getStatus(review.operationId)).toEqual({ operationId: review.operationId, status: "awaiting_approval" });
    (request.manifest as { jobId: string }).jobId = "changed-after-review";
    const data = snapshot(service, review);
    expect((data.manifest as { jobId: string }).jobId).toBe("123");
    expect(data.manifestHash).toBe(manifestHash(data.manifest));
    expect(service.getStatus("missing")).toBeUndefined();
    expect(() => service.createReview(input({ id: "other", manifestHash: "0".repeat(64) }))).toThrow("hash does not match");
  });

  test("a mismatched hash neither executes nor consumes the review", () => {
    const service = makeService();
    let executions = 0;
    const review = service.createReview(input({ execute: async () => { executions++; return null; } }));
    expect(approve(service, review, "wrong")).toBeUndefined();
    expect(executions).toBe(0);
    expect(service.getStatus(review.operationId)?.status).toBe("awaiting_approval");
  });
});

describe("human review lifecycle", () => {
  test("identifies a blocking attempt without exposing arbitrary error messages", async () => {
    const service = makeService();
    const review = service.createReview(input({ execute: async () => { throw new ReviewBeforeMutationError("private transport detail", { operationId: "prior-operation", state: "outcome_unknown" }); } }));
    expect(approve(service, review)).toBeDefined();
    await Bun.sleep(0);
    await service.close();
    expect(service.getStatus(review.operationId)).toEqual({ operationId: review.operationId, status: "failed", result: { code: "blocked_by_previous_attempt", operationId: "prior-operation", state: "outcome_unknown" } });
    expect(JSON.stringify(service.getStatus(review.operationId))).not.toContain("private transport detail");
  });

  test("dispatches once asynchronously and blocks concurrent/replayed approval", async () => {
    const service = makeService();
    const gate = deferred();
    let executions = 0;
    const review = service.createReview(input({ execute: async () => { executions++; await gate.promise; return { receiptId: "safe-receipt" }; } }));
    const hash = snapshot(service, review).manifestHash;
    expect(approve(service, review, hash)).toBeDefined();
    expect(approve(service, review, hash)).toBeUndefined();
    await Bun.sleep(0);
    expect(executions).toBe(1);
    expect(service.getStatus(review.operationId)?.status).toBe("executing");
    gate.resolve();
    await service.close();
    const state = service.getStatus(review.operationId)!;
    expect(state).toEqual({ operationId: review.operationId, status: "succeeded", result: { receiptId: "safe-receipt" } });
    (state.result as { receiptId: string }).receiptId = "mutated";
    expect(service.getStatus(review.operationId)?.result).toEqual({ receiptId: "safe-receipt" });
  });

  test("expires at fifteen minutes and never executes stale approval", async () => {
    let now = 0;
    const service = makeService(() => now);
    let executions = 0;
    const review = service.createReview(input({ execute: async () => { executions++; return null; } }));
    const hash = snapshot(service, review).manifestHash;
    now = 15 * 60 * 1000;
    expect(approve(service, review, hash)).toBeUndefined();
    expect(service.getStatus(review.operationId)?.status).toBe("expired");
    expect(executions).toBe(0);
  });

  test("revalidates immediately before mutation and distinguishes execution outcomes", async () => {
    const service = makeService();
    const cases = [
      { id: "stale", revalidate: async () => { throw new Error("sensitive stale details"); }, execute: async () => { throw new Error("must not run"); }, expected: "invalidated" },
      { id: "pre-mutation", revalidate: async () => {}, execute: async () => { throw new ReviewBeforeMutationError("sensitive details"); }, expected: "failed" },
      { id: "uncertain", revalidate: async () => {}, execute: async () => { throw new Error("sensitive transport response"); }, expected: "outcome_unknown" },
    ] as const;
    for (const item of cases) {
      const review = service.createReview(input(item));
      expect(approve(service, review)).toBeDefined();
      await Bun.sleep(0);
    }
    await service.close();
    for (const item of cases) {
      expect(service.getStatus(item.id)).toEqual({ operationId: item.id, status: item.expected });
    }
  });

  test("close awaits execution and invalidates pending reviews", async () => {
    const service = makeService();
    const gate = deferred();
    const executing = service.createReview(input({ execute: async () => { await gate.promise; return null; } }));
    const pending = service.createReview(input({ id: "pending" }));
    expect(approve(service, executing)).toBeDefined();
    await Bun.sleep(0);
    let closed = false;
    const closing = service.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(service.getStatus(pending.operationId)?.status).toBe("invalidated");
    expect(() => service.createReview(input({ id: "after-close" }))).toThrow("closed");
    gate.resolve();
    await closing;
    expect(service.getStatus(executing.operationId)?.status).toBe("succeeded");
  });

  test("expiration during revalidation invalidates approval before mutation", async () => {
    let now = 0;
    let executions = 0;
    const service = makeService(() => now);
    const review = service.createReview(input({
      revalidate: async () => { now = 15 * 60 * 1000; },
      execute: async () => { executions++; return null; },
    }));
    expect(approve(service, review)).toBeDefined();
    await Bun.sleep(0);
    await service.close();
    expect(service.getStatus(review.operationId)?.status).toBe("invalidated");
    expect(executions).toBe(0);
  });

  test("closing during revalidation prevents the subsequent mutation", async () => {
    const service = makeService();
    const started = deferred();
    const gate = deferred();
    let executions = 0;
    const review = service.createReview(input({
      revalidate: async () => { started.resolve(); await gate.promise; },
      execute: async () => { executions++; return null; },
    }));
    expect(approve(service, review)).toBeDefined();
    await Bun.sleep(0);
    await started.promise;
    const closing = service.close();
    gate.resolve();
    await closing;
    expect(executions).toBe(0);
    expect(service.getStatus(review.operationId)?.status).toBe("invalidated");
  });

  test("never exposes arbitrary executor output and treats invalid results as uncertain", async () => {
    const service = makeService();
    const review = service.createReview(input({ execute: async () => new Error("sensitive details") }));
    expect(approve(service, review)).toBeDefined();
    await Bun.sleep(0);
    await service.close();
    expect(service.getStatus(review.operationId)).toEqual({ operationId: review.operationId, status: "outcome_unknown" });
  });

  test("bounds retained reviews and rejects duplicate IDs", () => {
    let now = 0;
    const service = makeService(() => now);
    service.createReview(input());
    expect(() => service.createReview(input())).toThrow("already exists");
    for (let i = 1; i < 128; i++) service.createReview(input({ id: `bounded-${i}` }));
    expect(() => service.createReview(input({ id: "overflow" }))).toThrow("capacity");
    now = 30 * 60 * 1000;
    expect(service.createReview(input({ id: "after-prune" })).status).toBe("awaiting_approval");
  });
});
