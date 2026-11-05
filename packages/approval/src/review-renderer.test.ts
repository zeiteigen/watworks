import { describe, expect, test } from "bun:test";
import { REVIEW_RENDERER } from "./review-renderer.js";
import { REVIEW_SCRIPT } from "./review-script.js";
import { REVIEW_DOWNLOADS } from "./review-downloads.js";

/** Minimal text-only DOM verifies rendering behavior without a browser or HTML parser. */
class TextElement {
  readonly children: TextElement[] = [];
  className = "";
  hidden = false;
  disabled = false;
  private readonly listeners = new Map<string, () => Promise<void>>();
  private text = "";
  constructor(readonly tag: string) {}
  get textContent(): string { return [this.text, ...this.children.map(child => child.textContent)].join("\n"); }
  set textContent(value: string) { this.text = value; this.children.length = 0; }
  append(...nodes: TextElement[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: TextElement[]) { this.text = ""; this.children.splice(0, this.children.length, ...nodes); }
  addEventListener(event: string, listener: () => Promise<void>) { this.listeners.set(event, listener); }
  async click() { await this.listeners.get("click")?.(); }
}

function render(manifest: unknown): TextElement {
  const root = new TextElement("div");
  const renderer = new Function("document", `${REVIEW_RENDERER}; return renderManifest;`)({
    createElement: (tag: string) => new TextElement(tag),
  }) as (root: TextElement, manifest: unknown) => void;
  renderer(root, manifest);
  return root;
}

describe("human-readable review manifest", () => {
  test("shows the application, selected document identities, answer labels, and external steps", () => {
    const root = render({
      kind: "application", accountLabel: "Student account", accountKey: "hidden-account-key", formVersion: "hidden-form-version",
      employer: "Example Employer", title: "Software Developer", jobId: "12345", term: "Winter 2027", deadline: "Tomorrow",
      documents: [
        { label: "Résumé", document: { id: "library-42", name: "My résumé", revision: "revision-3", source: "library" } },
        { label: "Cover letter", file: { filename: "cover.pdf", size: 4096, sha256: "hidden-document-hash" } },
      ],
      answers: [{ questionId: "hidden-question-id", question: "Available for eight months?", value: "hidden-option-id", displayValue: "Yes, eight months" }],
      externalSteps: ["Complete the employer website application"],
    });
    const text = root.textContent;
    for (const expected of ["Account", "Student account", "Employer", "Example Employer", "Software Developer", "12345", "Winter 2027", "Résumé", "My résumé", "library-42", "revision-3", "cover.pdf", "4,096 bytes", "Available for eight months?", "Yes, eight months", "Complete the employer website application"]) expect(text).toContain(expected);
    for (const hidden of ["hidden-account-key", "hidden-form-version", "hidden-document-hash", "hidden-option-id", "hidden-question-id"]) expect(text).not.toContain(hidden);
    expect(root.children.some(section => section.className === "notice" && section.textContent.includes("Additional steps required"))).toBe(true);
  });

  test("renders other action objects as readable fields and suppresses internal identifiers", () => {
    const root = render({
      kind: "upload", accountKey: "hidden-key", manifestHash: "hidden-hash", formVersion: "hidden-version",
      typeLabel: "Résumé", file: { filename: "<script>alert(1)</script>.pdf", size: 1200, sha256: "hidden-sha" },
      makeDefault: false,
    });
    expect(root.textContent).toContain("Type Label");
    expect(root.textContent).toContain("Make Default");
    expect(root.textContent).toContain("No");
    expect(root.textContent).toContain("1,200 bytes");
    expect(root.textContent).toContain("<script>alert(1)</script>.pdf");
    expect(root.textContent).not.toContain("hidden-");
    expect(REVIEW_RENDERER).not.toContain("innerHTML");
  });

  test("assembles a syntactically valid browser script", () => {
    expect(() => new Function(REVIEW_SCRIPT)).not.toThrow();
  });

  test("offers downloads as text-only buttons and disables a button while downloading", async () => {
    const root = new TextElement("section");
    const renderer = new Function("document", `${REVIEW_DOWNLOADS}; return renderDownloads;`)({
      createElement: (tag: string) => new TextElement(tag),
    }) as (root: TextElement, documents: unknown[], download: (entry: unknown) => Promise<void>) => void;
    let finish!: () => void;
    let selected: unknown;
    const entry = { id: "resume", name: "<sample>.pdf", size: 1234 };
    renderer(root, [entry], async document => { selected = document; await new Promise<void>(resolve => { finish = resolve; }); });
    const button = root.children[2]!.children[0]!;
    expect(button.textContent).toContain("Download <sample>.pdf (1,234 bytes)");
    const clicking = button.click();
    expect(selected).toEqual(entry);
    expect(button.disabled).toBe(true);
    finish();
    await clicking;
    expect(button.disabled).toBe(false);
    renderer(root, [], async () => {});
    expect(root.hidden).toBe(true);
  });
});
