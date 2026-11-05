import { expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { REVIEW_PAGE } from "./review-page.js";
import { REVIEW_SCRIPT } from "./review-script.js";

test("processed-PDF continuation opens a fresh page and hash navigation cannot retain the old review", async () => {
  const { document } = parseHTML(REVIEW_PAGE);
  const events = new Map<string, () => void>();
  let reloads = 0;
  const location = { hash: "#review=parent&token=parent-capability", reload: () => { reloads++; } };
  const requests: RequestInit[] = [];
  const nextUrl = "http://127.0.0.1:1234/#review=processed&token=processed-capability";
  const run = new Function("document", "window", "location", "history", "fetch", "setTimeout", "clearTimeout", REVIEW_SCRIPT);
  run(document, { addEventListener: (name: string, callback: () => void) => events.set(name, callback) }, location,
    { replaceState: () => { location.hash = ""; } },
    async (_url: string, init: RequestInit) => {
      requests.push(init);
      return Response.json({ status: "review_required", manifestHash: "parent-hash", manifest: { kind: "application", documents: [], answers: [] }, expiresAt: Date.now() + 60_000,
        documents: [], result: { reviewUrl: nextUrl }, nonce: null });
    }, () => 0, () => {});
  for (let i = 0; i < 10 && !document.querySelector("#continue-review"); i++) await Bun.sleep(0);
  const link = document.querySelector("#continue-review")!;
  expect(link.getAttribute("href")).toBe(nextUrl);
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  expect(document.querySelector("#approve")!.hasAttribute("disabled")).toBe(true);
  expect(requests).toHaveLength(1);
  expect(requests[0]!.method).toBe("GET");
  location.hash = "#review=processed&token=processed-capability";
  events.get("hashchange")!();
  expect(reloads).toBe(1);
  location.hash = "#unrelated";
  events.get("hashchange")!();
  expect(reloads).toBe(1);
});
