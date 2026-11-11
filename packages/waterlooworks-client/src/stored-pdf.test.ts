import { expect, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { assertReadableStoredPdf, isUnreadableStoredPdf, UnreadableStoredPdfError, UNREADABLE_STORED_PDF } from "./stored-pdf.js";

async function validPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  return pdf.save();
}
async function failure(bytes: Uint8Array): Promise<UnreadableStoredPdfError> {
  try { await assertReadableStoredPdf(bytes); } catch (error) {
    expect(error).toBeInstanceOf(UnreadableStoredPdfError);
    expect((error as Error).message).toBe(UNREADABLE_STORED_PDF);
    return error as UnreadableStoredPdfError;
  }
  throw new Error("expected the stored PDF to be rejected");
}

test("a whole PDF with pages is accepted", async () => {
  await assertReadableStoredPdf(await validPdf());
});

test("each failed check is reported with bounded, content-free diagnostics", async () => {
  const html = new TextEncoder().encode("<!DOCTYPE html><p>Student Name</p>");
  expect((await failure(html)).diagnostic).toEqual({check: "header", bytes: html.length, starts: "html", trailer: false});
  expect((await failure(new Uint8Array())).diagnostic.starts).toBe("empty");

  const whole = await validPdf();
  const truncated = whole.subarray(0, whole.length - 1100);
  expect((await failure(truncated)).diagnostic).toMatchObject({check: "trailer", starts: "pdf", trailer: false});

  const broken = new TextEncoder().encode("%PDF-1.5\nnot a document\n%%EOF\n");
  const parse = (await failure(broken)).diagnostic;
  expect(parse).toMatchObject({starts: "pdf", trailer: true});
  expect(["parse", "pages"]).toContain(parse.check);
  expect(parse.parser).toMatch(/^[A-Za-z]+$/);
  expect(JSON.stringify(parse)).not.toContain("not a document");
});

test("the unreadable-PDF error is recognised by class or by its stable message", () => {
  expect(isUnreadableStoredPdf(new Error(UNREADABLE_STORED_PDF))).toBe(true);
  expect(isUnreadableStoredPdf(new Error("Document PDF could not be read"))).toBe(false);
});
