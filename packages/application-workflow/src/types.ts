export type Answer = string | boolean | number | string[];

export interface ApplicationQuestion {
  id: string;
  label: string;
  type: "text" | "single_choice" | "multiple_choice" | "boolean" | "number" | "unsupported";
  required: boolean;
  mustBeTrue?: boolean;
  options?: Array<{ id: string; label: string }>;
  maxLength?: number;
  min?: number;
  max?: number;
  /** Native number controls default to integer steps unless explicitly any. */
  integer?: boolean;
  /** Only explicitly understood conditional forms may be submitted. */
  condition?: { questionId: string; equals: string | boolean | number };
}

export interface LibraryDocument {
  id: string;
  typeId: string;
  name: string;
  revision: string;
  state: "ready" | "processing" | "archived" | "unknown";
  source: "library" | "system";
}

export interface DocumentRequirement {
  id: string;
  typeId: string;
  label: string;
  required: boolean;
  role: "resume" | "attachment" | "system";
  selectedDocument?: LibraryDocument;
}

export interface ApplicationForm {
  accountKey: string;
  accountLabel: string;
  jobId: string;
  title: string;
  employer: string;
  term: string;
  /** An unambiguous timestamp including offset, not the posting's display date. */
  deadline: string;
  canApply: boolean;
  hasApplication: boolean;
  version: string;
  requirements: DocumentRequirement[];
  questions: ApplicationQuestion[];
  blockers: string[];
  externalSteps: string[];
}

export interface PreparedFile {
  filename: string;
  size: number;
  sha256: string;
  bytes: Uint8Array;
}

export interface ApplicationInput {
  jobId: string;
  resumeDocumentId: string;
  attachments: Array<{ requirementId: string; filePath: string }>;
  answers: Array<{ questionId: string; value: Answer }>;
}

export type ApplicationExecutionMode = "submit" | "fill_only";

export interface ApplicationManifest {
  executionMode?: ApplicationExecutionMode;
  kind: "application";
  accountKey: string;
  accountLabel: string;
  jobId: string;
  title: string;
  employer: string;
  term: string;
  deadline: string;
  formVersion: string;
  documents: Array<{
    requirementId: string;
    label: string;
    document?: LibraryDocument;
    file?: { filename: string; size: number; sha256: string };
    /** The exact server-processed attachment verified and bound after upload. */
    storedDocument?: LibraryDocument;
  }>;
  answers: Array<{ questionId: string; question: string; value: Answer; displayValue: Answer }>;
  externalSteps: string[];
}

export interface SubmissionReceipt {
  /** Empty for form_filled: no application has been submitted. */
  applicationId: string;
  jobId: string;
  status: "submitted" | "form_filled";
  manifestHash: string;
  externalSteps: string[];
}

export interface ApplicationRecord {
  applicationId: string;
  jobId: string;
  title: string;
  employer: string;
  term: string;
  status: string;
  jobStatus?: string;
  submittedAt: string;
  location: string;
}
export interface ApplicationInventory {
  accountKey: string;
  checkedAt: string;
  termId: string;
  applications: ApplicationRecord[];
}

export interface StagedAttachment {
  requirementId: string;
  document: LibraryDocument;
  bytes: Uint8Array;
}

/** Implementations must verify each remote result; they must never retry writes. */
export interface ApplicationGateway {
  watchOperationProgress?(operationId:string,listener:(progress:import("../../shared/src/application-progress.js").ApplicationProgress)=>void):()=>void;
  getOperationProgress?(operationId: string): Promise<import("../../shared/src/application-progress.js").ApplicationProgress | null>;
  listApplications?(): Promise<ApplicationInventory>;
  /** Production transport proves whether any mutation was dispatched; never infers this from an HTTP error. */
  withMutationTracking?<T>(operation: () => Promise<T>): Promise<T>;
  getApplicationForm(jobId: string): Promise<ApplicationForm>;
  listDocuments(): Promise<LibraryDocument[]>;
  /** Return a fresh content revision for a selected library document. */
  getDocument?(documentId: string): Promise<LibraryDocument>;
  getDocumentSnapshot?(documentId: string): Promise<{ document: LibraryDocument; bytes: Uint8Array }>;
  stageAttachments?(manifest: ApplicationManifest, files: ReadonlyMap<string, PreparedFile>, attemptId?: string): Promise<StagedAttachment[]>;
  getAccount(): Promise<{ accountKey: string; accountLabel: string }>;
  uploadDocument(typeId: string, name: string, file: PreparedFile, accountKey: string, attemptId?: string): Promise<LibraryDocument>;
  setDefaultDocuments(typeId: string, documentIds: string[], accountKey: string): Promise<{ documentIds: string[] }>;
  submitApplication(
    manifest: ApplicationManifest,
    files: ReadonlyMap<string, PreparedFile>,
    beforeFinalSubmit: () => void,
    staged?: readonly StagedAttachment[],
    /** Durable approval/attempt identity; browser replay protection follows this attempt. */
    attemptId?: string,
  ): Promise<SubmissionReceipt>;
  getApplicationStatus(jobId: string): Promise<{ jobId: string; hasApplication: boolean; applicationId?: string }>;
  /** A production adapter must explicitly identify its verified write contracts. */
  capabilities: { upload: boolean; defaults: boolean; submit: boolean; reason?: string };
}
