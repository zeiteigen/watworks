import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { parseHTML } from "linkedom";
import { applicationEntryControls, isPostingId, readPostingPanel, showPostingPanel, WaterlooWorksSite, type ApplicationEntryAction, type PageResult, type WaterlooWorksBrowser } from "./site-interface.js";

function entryPage(html: string, submit: (form: HTMLFormElement) => void, origin = "https://waterlooworks.uwaterloo.ca") {
  const { document, window } = parseHTML(html);
  return (action: ApplicationEntryAction) => runInNewContext(`(${applicationEntryControls.toString()})(action)`, {
    action, document, location: { origin }, Error,
    HTMLFormElement: { prototype: { submit(this: HTMLFormElement) { submit(this); } } }, HTMLInputElement: window.HTMLInputElement,
  }) as PageResult;
}

test("wizard navigation posts only the source-verified read entry to the fixed WaterlooWorks path", () => {
  const posts: Array<{ path: string; method: string; fields: Record<string, string> }> = [];
  const run = entryPage(`<html><body></body></html>`, form => posts.push({ path: form.action, method: form.method, fields: Object.fromEntries([...form.querySelectorAll<HTMLInputElement>("input")].map(e => [e.name, e.value])) }));
  expect(run({ kind: "openWizard", jobId: "123", entry: { action: "fake-read-wizard", postingId: "123" } }).failure).toBeNull();
  expect(posts).toEqual([{ path: "/myAccount/co-op/full/jobs.htm", method: "POST", fields: { action: "fake-read-wizard", postingId: "123" } }]);
  for (const entry of [{ action: "fake-read-wizard", postingId: "999" }, { action: "fake-read-wizard", postingId: "123", unsafe: "field" }]) {
    expect(run({ kind: "openWizard", jobId: "123", entry }).failure?.message).toBe("Application entry form changed");
  }
  expect(posts).toHaveLength(1);
});

test("a page that already has an application form is not mistaken for the wizard while it navigates away", () => {
  const run = entryPage(`<html><body><form id="applyForm"><input name="postingId" value="123"></form></body></html>`, () => {});
  expect(run({ kind: "inspect" }).postingId).toBe("123");
  expect(run({ kind: "openWizard", jobId: "123", entry: { action: "open", postingId: "123" } }).postingId).toBeNull();
  expect(run({ kind: "inspect" }).postingId).toBeNull();
});

test("wizard controls refuse to run away from WaterlooWorks", () => {
  const run = entryPage(`<html><body></body></html>`, () => { throw new Error("must not submit"); }, "https://elsewhere.example");
  expect(run({ kind: "inspect" }).failure?.message).toBe("Application tab left WaterlooWorks");
});

function postingBrowser(pages: { show: PageResult[]; panel: Array<"loading" | "shown" | "failed"> }) {
  const calls: Array<{ fn: string; arg: unknown; world?: string }> = [];
  const browser: WaterlooWorksBrowser = {
    open: async () => 1, url: async () => "",
    evaluate: async <A, R>(_id: number, fn: (arg: A) => R | Promise<R>, arg: A, world?: "page") => {
      calls.push({ fn: fn.name, arg, ...(world ? { world } : {}) });
      return (fn === (showPostingPanel as unknown) ? pages.show.shift() : pages.panel.shift() ?? "loading") as R;
    },
  };
  return { site: new WaterlooWorksSite(browser, 1), calls };
}

test("a posting opens through the page's own viewer once ready, then is verified from the isolated world", async () => {
  const { site, calls } = postingBrowser({ show: [{ failure: { message: "The jobs page is not ready" } }, { failure: null }], panel: ["loading", "shown"] });
  await site.showPosting(1, "495981");
  expect(calls.map(call => call.fn)).toEqual(["showPostingPanel", "showPostingPanel", "readPostingPanel", "readPostingPanel"]);
  expect(calls.filter(call => call.fn === "showPostingPanel").every(call => call.world === "page" && call.arg === "495981")).toBe(true);
  expect(calls.filter(call => call.fn === "readPostingPanel").every(call => call.world === undefined)).toBe(true);
});

test("a posting the site cannot load is reported instead of leaving a silent error panel", async () => {
  const { site } = postingBrowser({ show: [{ failure: null }], panel: ["failed"] });
  await expect(site.showPosting(1, "1")).rejects.toThrow("could not load posting 1");
});

test("a jobs page without the viewer times out with its reason", async () => {
  const { site } = postingBrowser({ show: Array.from({ length: 50 }, () => ({ failure: { message: "The jobs page is not ready" } })), panel: [] });
  await expect(site.showPosting(1, "1", 20)).rejects.toThrow("not ready");
});

test("posting panel state comes from the visible panel only", () => {
  const read = (html: string, id: string) => runInNewContext(`(${readPostingPanel.toString()})(id)`, { id, document: parseHTML(html).document }) as ReturnType<typeof readPostingPanel>;
  expect(read(`<html><body><div class="modal"><div class="modal__inner--document-overlay">495981</div></div></body></html>`, "495981")).toBe("loading");
  expect(read(`<html><body><div class="modal is--visible"><div class="modal__inner--document-overlay">495981 Developer</div></div></body></html>`, "495981")).toBe("shown");
  expect(read(`<html><body><div class="modal is--visible"><div class="modal__inner--document-overlay">There was an error loading that job posting</div></div></body></html>`, "495981")).toBe("failed");
});

test("the viewer is asked for the posting by row ID, and a missing viewer is a failure", () => {
  const { document } = parseHTML(`<html><body><div id="dataViewerPlaceholder"></div></body></html>`);
  const run = (id: string) => runInNewContext(`(${showPostingPanel.toString()})(id)`, { id, document, Error }) as PageResult;
  expect(run("1").failure?.message).toBe("The jobs page is not ready");
  const rows: unknown[] = [];
  Object.assign(document.querySelector("#dataViewerPlaceholder")!, { __vue_app__: { config: { globalProperties: { $dataViewer: { viewUnloadedRecord: (row: unknown) => rows.push(row) } } } } });
  expect(run("42").failure).toBeNull();
  expect(rows).toHaveLength(1); expect((rows[0] as { id: string }).id).toBe("42");
});

test("posting IDs are positive safe integers", () => {
  for (const value of [undefined, "", "123?x=1", "0", "9007199254740992", 5]) expect(isPostingId(value)).toBe(false);
  expect(isPostingId("495981")).toBe(true);
});
