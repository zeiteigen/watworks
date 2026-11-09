import { captureDocuments, clearDocuments } from "./documents.js";
import { cloneJson, freezeJson, manifestHash } from "./manifest.js";
import { ReviewContinuation, ReviewBeforeMutationError, type CreatedReview, type CreateReviewInput, type JsonValue, type ReviewRecord, type ReviewState, type ReviewStatus } from "./types.js";
import { BrowserOperationError } from "../../shared/src/operation-failure.js";

const REVIEW_TTL_MS = 15 * 60 * 1000;
const MAX_REVIEWS = 128;
const MAX_RETAINED_DOCUMENT_BYTES = 32 * 1024 * 1024;

export interface ReviewServiceOptions {
  /** Clock injection for deterministic expiry verification. */
  now?: () => number;
}

/**
 * Holds each write's immutable manifest until the dashboard's approved click runs it.
 * There is no HTTP surface and no bearer capability: decisions arrive only in-process
 * from the dashboard service, which has verified a click-minted extension approval.
 */
export class ReviewService {
  private readonly reviews = new Map<string, ReviewRecord>();
  private readonly active = new Set<Promise<void>>();
  private readonly now: () => number;
  private closed = false;

  constructor(options: ReviewServiceOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  createReview(input: CreateReviewInput): CreatedReview {
    if (this.closed) throw new Error("Review service is closed");
    this.prune();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.id)) throw new Error("Invalid review operation ID");
    if (this.reviews.has(input.id)) throw new Error("Review operation ID already exists");
    if (this.reviews.size >= MAX_REVIEWS) throw new Error("Review service capacity reached");
    if (!input.actionLabel.trim() || input.actionLabel.length > 200) throw new Error("Invalid review action label");
    const manifest = freezeJson(cloneJson(input.manifest));
    if (manifestHash(manifest) !== input.manifestHash) throw new Error("Review manifest hash does not match");
    const documents = captureDocuments(input.documents);
    try {
      const retainedBytes = [...this.reviews.values()].reduce((total, review) => total + [...review.documents.values()].reduce((sum, document) => sum + document.bytes.byteLength, 0), 0);
      const addedBytes = [...documents.values()].reduce((sum, document) => sum + document.bytes.byteLength, 0);
      if (retainedBytes + addedBytes > MAX_RETAINED_DOCUMENT_BYTES) throw new Error("Review document memory capacity reached");
    } catch (error) {
      clearDocuments(documents);
      throw error;
    }
    this.reviews.set(input.id, {
      id: input.id,
      manifest,
      manifestHash: input.manifestHash,
      actionLabel: input.actionLabel,
      expiresAt: this.now() + REVIEW_TTL_MS,
      status: "awaiting_approval",
      execute: input.execute,
      revalidate: input.revalidate,
      documents,
    });
    return { operationId: input.id, status: "awaiting_approval" };
  }

  /** The exact manifest awaiting a decision, for an embedding UI to verify and display. */
  inspect(id: string): { manifest: JsonValue; manifestHash: string; status: ReviewState; documents: Array<{ id: string; name: string }> } | undefined {
    const review = this.get(id);
    return review && { manifest: review.manifest, manifestHash: review.manifestHash, status: review.status, documents: Array.from(review.documents.values(), ({ id, name }) => ({ id, name })) };
  }

  /** Bytes of a document captured for a review, for an embedding UI to display. */
  document(id: string, documentId: string): Uint8Array | undefined {
    return this.get(id)?.documents.get(documentId)?.bytes;
  }

  /**
   * Run a review exactly once, if its manifest hash still matches. The caller is the
   * dashboard service acting on a click whose extension approval it has verified.
   */
  approve(id: string, manifestHash: string): ReviewStatus | undefined {
    const review = this.get(id);
    if (this.closed || !review || review.status !== "awaiting_approval" || review.manifestHash !== manifestHash) return undefined;
    review.status = "executing";
    // Register work before invoking caller callbacks, including callbacks that close the service.
    const execution = Promise.resolve().then(() => this.run(review));
    this.active.add(execution);
    void execution.finally(() => this.active.delete(execution));
    return this.publicStatus(review);
  }

  getStatus(id: string): ReviewStatus | undefined {
    const review = this.get(id);
    return review ? this.publicStatus(review) : undefined;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const review of this.reviews.values()) {
      clearDocuments(review.documents);
      if (review.status === "awaiting_approval") review.status = "invalidated";
    }
    await Promise.all(this.active);
  }

  private get(id: string): ReviewRecord | undefined {
    const review = this.reviews.get(id);
    if (review && this.now() >= review.expiresAt) clearDocuments(review.documents);
    if (review?.status === "awaiting_approval" && this.now() >= review.expiresAt) review.status = "expired";
    return review;
  }

  private prune(): void {
    for (const [id, review] of this.reviews) {
      this.get(id);
      if (review.status !== "executing" && this.now() >= review.expiresAt + REVIEW_TTL_MS) {
        clearDocuments(review.documents);
        this.reviews.delete(id);
      }
    }
  }

  private publicStatus(review: ReviewRecord): ReviewStatus {
    return {
      operationId: review.id,
      status: review.status,
      ...(review.result === undefined ? {} : { result: cloneJson(review.result) }),
    };
  }

  private async run(review: ReviewRecord): Promise<void> {
    try {
      if (manifestHash(review.manifest) !== review.manifestHash) throw new Error("Manifest changed");
      await review.revalidate();
      if (this.closed) throw new Error("Review service closed during validation");
      if (this.now() >= review.expiresAt) throw new Error("Review expired during validation");
    } catch {
      review.status = "invalidated";
      return;
    }
    try {
      const result = await review.execute();
      review.result = freezeJson(cloneJson(result instanceof ReviewContinuation ? result.review : result));
      review.status = result instanceof ReviewContinuation ? "review_required" : "succeeded";
    } catch (error) {
      review.status = error instanceof ReviewBeforeMutationError ? "failed" : "outcome_unknown";
      if (error instanceof ReviewBeforeMutationError && error.code) review.result = { code: error.code };
      const failure = error instanceof BrowserOperationError ? error.failure : error instanceof ReviewBeforeMutationError ? error.failure : undefined;
      if (failure) review.result = freezeJson(cloneJson({ code: failure.code, failure }));
      if (error instanceof ReviewBeforeMutationError && error.blockingAttempt) {
        review.result = freezeJson(cloneJson({ code: "blocked_by_previous_attempt", operationId: error.blockingAttempt.operationId, state: error.blockingAttempt.state }));
      }
    }
  }
}
