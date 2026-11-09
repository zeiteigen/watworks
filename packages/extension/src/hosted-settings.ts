import { DEFAULT_SUBMISSION_ENDPOINT, type SubmissionSettings } from "./submission-client.js";

/** Hosted identity and execution never inherit an advanced local endpoint override. */
export function hostedSettings(): SubmissionSettings {
  return { endpoint: DEFAULT_SUBMISSION_ENDPOINT, headers: {}, revision: "00000000-0000-4000-8000-000000000001" };
}
