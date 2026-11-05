import { sha256 } from "../../shared/src/sha256.js";

export function fingerprint(value: unknown): string {
  return sha256(JSON.stringify(value));
}
