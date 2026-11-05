import type { OperationFailure } from "../../shared/src/operation-failure.js";
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type ReviewState =
  | "awaiting_approval"
  | "executing"
  | "review_required"
  | "rejected"
  | "expired"
  | "invalidated"
  | "failed"
  | "succeeded"
  | "outcome_unknown";

export interface ReviewStatus {
  operationId: string;
  status: ReviewState;
  result?: JsonValue;
}

export interface CreateReviewInput {
  id: string;
  manifest: JsonValue;
  /** SHA-256 hex digest of JSON.stringify(manifest). */
  manifestHash: string;
  actionLabel: string;
  /** Captured local PDFs offered only within this authenticated review. */
  documents?: ReviewDocument[];
  revalidate: () => Promise<void>;
  /** Return only safe public domain data, never credentials or raw transport responses. */
  execute: () => Promise<unknown>;
}

export interface ReviewDocument {
  id: string;
  name: string;
  bytes: Uint8Array;
}

export interface CreatedReview {
  operationId: string;
  status: "awaiting_approval";
  reviewUrl: string;
}

/** Throw only when the executor knows that no remote mutation was attempted. */
export class ReviewBeforeMutationError extends Error {
  override readonly name = "ReviewBeforeMutationError";
  constructor(message: string, public readonly blockingAttempt?: { operationId: string; state: string }, public readonly code?: "authentication_expired" | "no_remote_mutation", public readonly failure?: OperationFailure) {
    super(message);
  }
}

export interface ReviewRecord {
  id: string;
  manifest: JsonValue;
  manifestHash: string;
  actionLabel: string;
  token: string;
  nonce: string | null;
  expiresAt: number;
  status: ReviewState;
  result?: JsonValue;
  documents: Map<string, ReviewDocument>;
  revalidate: () => Promise<void>;
  execute: () => Promise<unknown>;
}

/** A completed staging action requires a separate human decision before submission. */
export class ReviewContinuation {
  constructor(public readonly review: CreatedReview) {}
}
