import { createHash } from "node:crypto";
import type { JsonValue } from "./types.js";

const MAX_JSON_BYTES = 256 * 1024;

function assertJson(value: unknown, ancestors: Set<object>, depth: number): asserts value is JsonValue {
  if (depth > 100) throw new Error("Review data is too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || value === null || ancestors.has(value)) {
    throw new Error("Review data must be JSON-compatible");
  }
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error("Review data must contain only JSON objects");
  }
  ancestors.add(value);
  for (const child of Object.values(value)) assertJson(child, ancestors, depth + 1);
  ancestors.delete(value);
}

/** Clone through JSON so callers cannot mutate the approved snapshot or public results. */
export function cloneJson(value: unknown): JsonValue {
  assertJson(value, new Set(), 0);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > MAX_JSON_BYTES) throw new Error("Review data is too large");
  return JSON.parse(serialized) as JsonValue;
}

export function manifestHash(manifest: JsonValue): string {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

export function freezeJson(value: JsonValue): JsonValue {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
