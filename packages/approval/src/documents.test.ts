import { describe, expect, test } from "bun:test";
import { attachmentDisposition, captureDocuments, clearDocuments } from "./documents.js";

const pdf = () => new TextEncoder().encode("%PDF-1.7\nfixture\n%%EOF\n");

describe("captured review PDFs", () => {
  test("copies bytes and erases private copies on cleanup", () => {
    const original = pdf();
    const captured = captureDocuments([{ id: "resume", name: "Résumé.pdf", bytes: original }]);
    const privateCopy = captured.get("resume")!.bytes;
    original.fill(65);
    expect(Buffer.from(privateCopy).toString()).toStartWith("%PDF-");
    clearDocuments(captured);
    expect(captured.size).toBe(0);
    expect(privateCopy.every(byte => byte === 0)).toBe(true);
    expect(original.every(byte => byte === 65)).toBe(true);
  });

  test("validates IDs, filenames, PDF signatures, document count, and byte limits", () => {
    const document = { id: "resume", name: "resume.pdf", bytes: pdf() };
    expect(() => captureDocuments([{ ...document, id: "../resume" }])).toThrow("document ID");
    expect(() => captureDocuments([document, document])).toThrow("document ID");
    expect(() => captureDocuments([{ ...document, name: "resume\r\nInjected: x.pdf" }])).toThrow("document name");
    expect(() => captureDocuments([{ ...document, bytes: new TextEncoder().encode("not a PDF") }])).toThrow("not a PDF");
    expect(() => captureDocuments([{ ...document, bytes: new Uint8Array([0xa5, 0xd0, 0xc4, 0xc6, 0xad]) }])).toThrow("not a PDF");
    expect(() => captureDocuments(Array.from({ length: 9 }, (_, index) => ({ ...document, id: String(index) })))).toThrow("eight");
    expect(() => captureDocuments([{ ...document, bytes: new Uint8Array(5 * 1024 * 1024) }])).toThrow("smaller than 5 MiB");
    const large = new Uint8Array(4.5 * 1024 * 1024);
    large.set(pdf());
    expect(() => captureDocuments(Array.from({ length: 8 }, (_, index) => ({ ...document, id: String(index), bytes: large })))).toThrow("32 MiB");
  });

  test("encodes an attachment filename without header or path syntax", () => {
    const header = attachmentDisposition("folder/Résumé's \"copy\".pdf");
    expect(header).toBe("attachment; filename=\"document.pdf\"; filename*=UTF-8''folder_R%C3%A9sum%C3%A9%27s%20%22copy%22.pdf");
  });
});
