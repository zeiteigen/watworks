import type { ReviewDocument } from "./types.js";

const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d];

export function captureDocuments(input: ReviewDocument[] = []): Map<string, ReviewDocument> {
  if (!Array.isArray(input) || input.length > 8) throw new Error("A review supports at most eight PDF documents");
  const documents = new Map<string, ReviewDocument>();
  let total = 0;
  try {
    for (const document of input) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(document.id) || documents.has(document.id)) throw new Error("Invalid or duplicate review document ID");
      if (typeof document.name !== "string" || !document.name.trim() || document.name.length > 255 || /[\x00-\x1f\x7f]/.test(document.name)) throw new Error("Invalid review document name");
      // Ensure the filename can be encoded safely as RFC 5987, including rejecting lone surrogates.
      encodeURIComponent(document.name);
      if (!(document.bytes instanceof Uint8Array) || document.bytes.byteLength >= MAX_DOCUMENT_BYTES) throw new Error("Review PDFs must be smaller than 5 MiB");
      total += document.bytes.byteLength;
      if (total > MAX_TOTAL_BYTES) throw new Error("Review PDFs exceed the 32 MiB total limit");
      const bytes = new Uint8Array(document.bytes);
      if (!PDF_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
        bytes.fill(0);
        throw new Error("Review document is not a PDF");
      }
      documents.set(document.id, { id: document.id, name: document.name, bytes });
    }
    return documents;
  } catch (error) {
    clearDocuments(documents);
    throw error;
  }
}

export function clearDocuments(documents: Map<string, ReviewDocument>): void {
  for (const document of documents.values()) document.bytes.fill(0);
  documents.clear();
}

export function attachmentDisposition(name: string): string {
  const filename = name.replace(/[/\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="document.pdf"; filename*=UTF-8''${encoded}`;
}
