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

function access(review: CreatedReview) {
  const url = new URL(review.reviewUrl);
  const token = new URLSearchParams(url.hash.slice(1)).get("token")!;
  return { origin: url.origin, endpoint: `${url.origin}/api/reviews/${review.operationId}`, token };
}

async function snapshot(review: CreatedReview): Promise<Record<string, any>> {
  const { endpoint, token } = access(review);
  const response = await fetch(endpoint, { headers: { authorization: `Bearer ${token}` } });
  expect(response.status).toBe(200);
  return response.json();
}

async function decide(review: CreatedReview, decision = "approve", body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const { origin, endpoint, token } = access(review);
  const data = body === undefined ? await snapshot(review) : undefined;
  return fetch(`${endpoint}/${decision}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, origin, "content-type": "application/json", ...headers },
    body: JSON.stringify(body ?? { manifestHash: data!.manifestHash, nonce: data!.nonce }),
  });
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

  test("authenticates draft-scoped PDF downloads and preserves captured bytes", async () => {
    const service = makeService();
    const bytes = new TextEncoder().encode("%PDF-1.7\noriginal captured contents\n%%EOF\n");
    const expected = new Uint8Array(bytes);
    const name = "Résumé's final.pdf";
    const review = service.createReview(input({ documents: [{ id: "resume", name, bytes }] }));
    const other = service.createReview(input({ id: "other-review" }));
    bytes.fill(0);
    const { endpoint, token } = access(review);
    const documentUrl = `${endpoint}/documents/resume`;
    expect((await fetch(documentUrl)).status).toBe(401);
    expect((await fetch(documentUrl, { headers: { authorization: `Bearer ${access(other).token}` } })).status).toBe(401);
    expect((await fetch(`${endpoint}/documents/missing`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
    expect((await fetch(`${endpoint}/documents/%2e%2e%2fsecret`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
    const response = await fetch(documentUrl, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toContain("filename*=UTF-8''R%C3%A9sum%C3%A9%27s%20final.pdf");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(expected);
    expect((await snapshot(review)).documents).toEqual([{ id: "resume", name, size: expected.byteLength }]);
    expect(service.getStatus(review.operationId)).toEqual({ operationId: review.operationId, status: "awaiting_approval" });
  });

  test("removes captured downloads at review expiry and after pruning", async () => {
    let now = 0;
    const service = makeService(() => now);
    const review = service.createReview(input({ documents: [{ id: "resume", name: "resume.pdf", bytes: new TextEncoder().encode("%PDF-1.7\n%%EOF\n") }] }));
    const { endpoint, token } = access(review);
    now = 15 * 60 * 1000;
    expect((await snapshot(review)).documents).toEqual([]);
    expect((await fetch(`${endpoint}/documents/resume`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
    now = 30 * 60 * 1000;
    service.createReview(input({ id: "new-review" }));
    expect((await fetch(`${endpoint}/documents/resume`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  test("stores an immutable hash-bound snapshot and returns only safe public state", async () => {
    const service = makeService();
    const request = input();
    const review = service.createReview(request);
    const { origin, token } = access(review);
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(service.getStatus(review.operationId)).toEqual({ operationId: review.operationId, status: "awaiting_approval" });
    (request.manifest as { jobId: string }).jobId = "changed-after-review";
    const data = await snapshot(review);
    expect(data.manifest.jobId).toBe("123");
    expect(data.manifestHash).toBe(manifestHash(data.manifest));
    expect(data).not.toHaveProperty("token");
    expect(service.getStatus("missing")).toBeUndefined();
    expect(() => service.createReview(input({ id: "other", manifestHash: "0".repeat(64) }))).toThrow("hash does not match");
  });

  test("requires the exact Host, POST Origin, bearer token, hash, and nonce", async () => {
    const service = makeService();
    let executions = 0;
    const review = service.createReview(input({ execute: async () => { executions++; return null; } }));
    const { origin, endpoint, token } = access(review);
    expect((await fetch(endpoint)).status).toBe(401);
    expect((await fetch(endpoint, { headers: { authorization: "Bearer invalid" } })).status).toBe(401);
    expect((await fetch(endpoint, { headers: { authorization: `Bearer ${token}`, host: "localhost:1234" } })).status).toBe(403);
    const data = await snapshot(review);
    const body = { manifestHash: data.manifestHash, nonce: data.nonce };
    expect((await decide(review, "approve", body, { origin: "https://attacker.example" })).status).toBe(403);
    expect((await fetch(`${endpoint}/approve`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
    })).status).toBe(403);
    expect((await decide(review, "approve", { ...body, nonce: "wrong" })).status).toBe(409);
    expect((await decide(review, "approve", { ...body, manifestHash: "wrong" })).status).toBe(409);
    expect((await fetch(`${endpoint}/approve`, { headers: { authorization: `Bearer ${token}`, origin } })).status).toBe(405);
    expect(executions).toBe(0);
    expect(service.getStatus(review.operationId)?.status).toBe("awaiting_approval");
  });

  test("serves a static protected page and script without mutation or CORS", async () => {
    const service = makeService();
    const review = service.createReview(input());
    const { origin, token } = access(review);
    const response = await fetch(origin);
    const html = await response.text();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("content-security-policy")).toContain("style-src 'self'");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(html).not.toContain(token);
    expect(html).not.toContain("receipt-1");
    const script = await (await fetch(`${origin}/review.js`)).text();
    expect(script).toContain("textContent");
    expect(script).not.toContain("innerHTML");
    expect(script).toContain("history.replaceState");
    const style = await fetch(`${origin}/review.css`);
    expect(style.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await style.text()).toContain("prefers-color-scheme");
    expect(html).toContain("<details><summary>Technical review details</summary>");
    expect((await fetch(`${origin}/api/reviews/${review.operationId}`, { method: "OPTIONS", headers: { origin: "https://attacker.example" } })).headers.get("access-control-allow-origin")).toBeNull();
    expect(service.getStatus(review.operationId)?.status).toBe("awaiting_approval");
  });

  test("rejects malformed and oversized decision bodies without consuming approval", async () => {
    const service = makeService();
    const review = service.createReview(input());
    expect((await decide(review, "approve", { manifestHash: "x", nonce: "y", extra: true })).status).toBe(400);
    expect((await decide(review, "approve", {}, { "content-type": "text/plain" })).status).toBe(400);
    const response = await decide(review, "approve", { nonce: "x".repeat(5000), manifestHash: "x" });
    expect([400, 413]).toContain(response.status);
    expect(service.getStatus(review.operationId)?.status).toBe("awaiting_approval");
  });
});

describe("human review lifecycle", () => {
  test("identifies a blocking attempt without exposing arbitrary error messages", async () => {
    const service = makeService();
    const review = service.createReview(input({ execute: async () => { throw new ReviewBeforeMutationError("private transport detail", { operationId: "prior-operation", state: "outcome_unknown" }); } }));
    expect((await decide(review)).status).toBe(202);
    await service.close();
    expect(service.getStatus(review.operationId)).toEqual({ operationId: review.operationId, status: "failed", result: { code: "blocked_by_previous_attempt", operationId: "prior-operation", state: "outcome_unknown" } });
    expect(JSON.stringify(service.getStatus(review.operationId))).not.toContain("private transport detail");
  });

  test("dispatches once asynchronously and blocks concurrent/replayed approval", async () => {
    const service = makeService();
    const gate = deferred();
    let executions = 0;
    const review = service.createReview(input({ execute: async () => { executions++; await gate.promise; return { receiptId: "safe-receipt" }; } }));
    const data = await snapshot(review);
    const body = { manifestHash: data.manifestHash, nonce: data.nonce };
    const responses = await Promise.all([decide(review, "approve", body), decide(review, "approve", body)]);
    expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
    expect(executions).toBe(1);
    expect(service.getStatus(review.operationId)?.status).toBe("executing");
    gate.resolve();
    await service.close();
    const state = service.getStatus(review.operationId)!;
    expect(state).toEqual({ operationId: review.operationId, status: "succeeded", result: { receiptId: "safe-receipt" } });
    (state.result as { receiptId: string }).receiptId = "mutated";
    expect(service.getStatus(review.operationId)?.result).toEqual({ receiptId: "safe-receipt" });
  });

  test("rejection consumes the nonce and never executes", async () => {
    const service = makeService();
    let executions = 0;
    const review = service.createReview(input({ execute: async () => { executions++; return null; } }));
    const data = await snapshot(review);
    const body = { manifestHash: data.manifestHash, nonce: data.nonce };
    expect((await decide(review, "reject", body)).status).toBe(200);
    expect((await decide(review, "approve", body)).status).toBe(409);
    expect(service.getStatus(review.operationId)?.status).toBe("rejected");
    expect(executions).toBe(0);
  });

  test("expires at fifteen minutes and never executes stale approval", async () => {
    let now = 0;
    const service = makeService(() => now);
    let executions = 0;
    const review = service.createReview(input({ execute: async () => { executions++; return null; } }));
    const data = await snapshot(review);
    now = 15 * 60 * 1000;
    expect((await decide(review, "approve", { manifestHash: data.manifestHash, nonce: data.nonce })).status).toBe(409);
    expect(service.getStatus(review.operationId)?.status).toBe("expired");
    expect((await snapshot(review)).nonce).toBeNull();
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
      expect((await decide(review)).status).toBe(202);
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
    expect((await decide(executing)).status).toBe(202);
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
    expect((await decide(review)).status).toBe(202);
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
    expect((await decide(review)).status).toBe(202);
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
    expect((await decide(review)).status).toBe(202);
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
