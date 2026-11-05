import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import type { PreparedFile } from "./types.js";

const MAX_PDF_BYTES = 5_000_000;

function contains(root: string, file: string): boolean {
  const child = relative(root, file);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

/** Capture immutable PDF bytes before review; no path is sent to WaterlooWorks. */
export async function readApplicationPdf(filePath: string, allowedRoots: readonly string[]): Promise<PreparedFile> {
  if (!isAbsolute(filePath)) throw new Error("Document paths must be absolute");
  if (allowedRoots.length === 0) throw new Error("Configure WATERLOOWORKS_DOCUMENT_ROOTS before reading documents");
  const file = await realpath(filePath).catch(() => { throw new Error("Document is not accessible"); });
  // A configured root that does not exist yet (for example a fresh data/) simply matches nothing.
  const roots = await Promise.all(allowedRoots.map(root => realpath(root).catch(() => undefined)));
  if (!roots.some(root => root !== undefined && contains(root, file))) throw new Error("Document is outside configured document roots");
  const filename = basename(file);
  if (!/\.pdf$/i.test(filename) || /[\x00-\x1f\x7f]/.test(filename)) throw new Error("Select a PDF with a valid filename");
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes: Buffer;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 16 || before.size > MAX_PDF_BYTES) throw new Error("PDF must be a regular file between 16 bytes and 5 MB");
    // Bound reads even if another process grows the file after stat().
    bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (offset !== before.size || after.size !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || await realpath(filePath) !== file) {
      throw new Error("Document changed while being read; prepare it again");
    }
    bytes = bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
  if (!bytes.subarray(0, 8).toString("ascii").startsWith("%PDF-") || !bytes.subarray(-1024).toString("latin1").includes("%%EOF")) throw new Error("Invalid PDF structure");
  try {
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
    if (pdf.isEncrypted || pdf.getPageCount() < 1) throw new Error("Invalid PDF");
  } catch {
    throw new Error("PDF is corrupt, encrypted, or has no pages");
  }
  return { filename, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: new Uint8Array(bytes) };
}
