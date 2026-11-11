import { PDFDocument } from "pdf-lib";
import { ProtocolChangedError } from "./errors.js";

export const UNREADABLE_STORED_PDF = "Stored document is not a readable PDF";

/** Bounded facts about a stored PDF that failed its check. Never its bytes or text. */
export interface StoredPdfDiagnostic {
  check: "header" | "trailer" | "parse" | "encrypted" | "pages";
  bytes: number;
  starts: "pdf" | "html" | "json" | "empty" | "other";
  trailer: boolean;
  parser?: string;
}

/** Keeps the public message unchanged, so callers and failure allowlists treat it as before. */
export class UnreadableStoredPdfError extends ProtocolChangedError {
  constructor(readonly diagnostic: StoredPdfDiagnostic, cause?: unknown) {
    super(UNREADABLE_STORED_PDF, cause);
  }
}

export function isUnreadableStoredPdf(error: unknown): boolean {
  return error instanceof UnreadableStoredPdfError || (error instanceof Error && error.message === UNREADABLE_STORED_PDF);
}

function parserName(error: unknown): string {
  const name = error instanceof Error ? error.constructor.name : typeof error;
  return /^[A-Za-z]{1,60}$/.test(name) ? name : "unknown";
}

/** Rejects a stored WaterlooWorks document that is not a whole, unencrypted PDF with pages. */
export async function assertReadableStoredPdf(bytes: Uint8Array): Promise<void> {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 16));
  const trailer = new TextDecoder("latin1").decode(bytes.subarray(-1024)).includes("%%EOF");
  const starts: StoredPdfDiagnostic["starts"] = !bytes.length ? "empty" : head.startsWith("%PDF-") ? "pdf"
    : /^\s*</.test(head) ? "html" : /^\s*[{[]/.test(head) ? "json" : "other";
  const fail = (check: StoredPdfDiagnostic["check"], parser?: string, cause?: unknown) =>
    new UnreadableStoredPdfError({ check, bytes: bytes.length, starts, trailer, ...(parser ? { parser } : {}) }, cause);
  if (starts !== "pdf") throw fail("header");
  if (!trailer) throw fail("trailer");
  let pdf: PDFDocument;
  try { pdf = await PDFDocument.load(bytes, { throwOnInvalidObject: true }); }
  catch (error) { throw fail("parse", parserName(error), error); }
  if (pdf.isEncrypted) throw fail("encrypted");
  // pdf-lib parses lazily: a damaged page tree can load and only fail when counted.
  let pages: number;
  try { pages = pdf.getPageCount(); }
  catch (error) { throw fail("pages", parserName(error), error); }
  if (pages < 1) throw fail("pages");
}
