import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { readApplicationPdf } from "./files.js";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "application-pdf-test-"));
  roots.push(root);
  const allowed = join(root, "allowed");
  await mkdir(allowed);
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const bytes = await pdf.save();
  const path = join(allowed, "letter.pdf");
  await writeFile(path, bytes);
  return { root, allowed, path, bytes };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("bounded application PDF capture", () => {
  test("captures a real PDF with exact size and SHA-256, preserving immutable bytes", async () => {
    const f = await fixture();
    const file = await readApplicationPdf(f.path, [f.allowed]);
    expect(file.filename).toBe("letter.pdf");
    expect(file.size).toBe(f.bytes.length);
    expect(file.sha256).toBe(createHash("sha256").update(f.bytes).digest("hex"));
    await writeFile(f.path, "replaced after capture");
    expect(file.bytes).toEqual(new Uint8Array(f.bytes));
  });

  test("requires absolute accessible paths and configured document roots", async () => {
    const f = await fixture();
    await expect(readApplicationPdf("letter.pdf", [f.allowed])).rejects.toThrow("absolute");
    await expect(readApplicationPdf(f.path, [])).rejects.toThrow("DOCUMENT_ROOTS");
    await expect(readApplicationPdf(join(f.allowed, "missing.pdf"), [f.allowed])).rejects.toThrow("not accessible");
    const outside = join(f.root, "outside.pdf");
    await writeFile(outside, f.bytes);
    await expect(readApplicationPdf(outside, [f.allowed])).rejects.toThrow("outside configured");
    const escape = join(f.allowed, "escape.pdf");
    await symlink(outside, escape);
    await expect(readApplicationPdf(escape, [f.allowed])).rejects.toThrow("outside configured");
  });

  test("rejects invalid filenames, empty and oversized files, and PDF directories", async () => {
    const f = await fixture();
    const wrong = join(f.allowed, "letter.txt");
    await writeFile(wrong, f.bytes);
    await expect(readApplicationPdf(wrong, [f.allowed])).rejects.toThrow("valid filename");
    await writeFile(f.path, "");
    await expect(readApplicationPdf(f.path, [f.allowed])).rejects.toThrow("between 16 bytes and 5 MB");
    await writeFile(f.path, new Uint8Array(5_000_001));
    await expect(readApplicationPdf(f.path, [f.allowed])).rejects.toThrow("between 16 bytes and 5 MB");
    const directory = join(f.allowed, "directory.pdf");
    await mkdir(directory);
    await expect(readApplicationPdf(directory, [f.allowed])).rejects.toThrow("regular file");
  });

  test("rejects truncated, forged, and zero-page PDFs", async () => {
    const f = await fixture();
    await writeFile(f.path, f.bytes.subarray(0, 40));
    await expect(readApplicationPdf(f.path, [f.allowed])).rejects.toThrow("Invalid PDF structure");
    await writeFile(f.path, "%PDF-1.7\nthis is not a PDF document\n%%EOF\n");
    await expect(readApplicationPdf(f.path, [f.allowed])).rejects.toThrow("corrupt");
    const empty = await PDFDocument.create();
    await writeFile(f.path, await empty.save({ addDefaultPage: false }));
    await expect(readApplicationPdf(f.path, [f.allowed])).rejects.toThrow("no pages");
  });
});
