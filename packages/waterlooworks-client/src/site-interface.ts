/**
 * The one place that knows how to drive WaterlooWorks pages. The extension (for
 * manual navigation) and the submission server (for approved application runs)
 * each supply a `WaterlooWorksBrowser`; everything site-specific lives here.
 */
export interface WaterlooWorksBrowser {
  open(url: string): Promise<number>;
  url(id: number): Promise<string>;
  /** `page` runs beside the site's own scripts; only use it to call the site's APIs. */
  evaluate<A, R>(id: number, fn: (arg: A) => R | Promise<R>, arg: A, world?: "page"): Promise<R>;
}

export type ApplicationEntryAction = { kind: "openWizard"; jobId: string; entry: Record<string, string> } | { kind: "inspect" };
export interface PageResult { failure: { name?: string; message: string } | null; postingId?: string | null }

/**
 * Injected: must stay self-contained. Posts only the source-verified read entry to
 * the fixed path, and leaves every form control to the user or the approved runner.
 */
export function applicationEntryControls(action: ApplicationEntryAction): PageResult {
  try {
    if (location.origin !== "https://waterlooworks.uwaterloo.ca") throw new Error("Application tab left WaterlooWorks");
    if (action.kind === "openWizard") {
      const entry = action.entry;
      if (!entry || entry.postingId !== action.jobId || !entry.action || entry.action.length > 1000 || Object.keys(entry).some(key => key !== "action" && key !== "postingId")) throw new Error("Application entry form changed");
      const navigation = document.createElement("form");
      navigation.setAttribute("data-wat-entry", "");
      navigation.method = "POST";
      navigation.action = "/myAccount/co-op/full/jobs.htm";
      for (const [name, value] of Object.entries(entry)) {
        const input = document.createElement("input"); input.type = "hidden"; input.name = name; input.value = value; navigation.append(input);
      }
      document.body.append(navigation);
      HTMLFormElement.prototype.submit.call(navigation);
    }
    // The tagged form only exists on the document being left: until it is replaced, nothing here counts as the wizard.
    const leaving = document.querySelector("form[data-wat-entry]");
    return { failure: null, postingId: leaving ? null : document.querySelector<HTMLInputElement>('#applyForm input[name="postingId"]')?.value ?? null };
  } catch (error) {
    return { failure: { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message.slice(0, 300) : "Application page unavailable" }, postingId: null };
  }
}

/**
 * Injected into the page world: must stay self-contained. Postings have no URL of
 * their own, so this asks the jobs page's data viewer to open its posting panel.
 */
export function showPostingPanel(jobId: string): PageResult {
  try {
    const root = document.querySelector("#dataViewerPlaceholder") as (Element & { __vue_app__?: { config?: { globalProperties?: { $dataViewer?: { viewUnloadedRecord?: (row: { id: string }) => void } } } } }) | null;
    const viewer = root?.__vue_app__?.config?.globalProperties?.$dataViewer;
    if (typeof viewer?.viewUnloadedRecord !== "function") return { failure: { message: "The jobs page is not ready" } };
    viewer.viewUnloadedRecord({ id: jobId });
    return { failure: null };
  } catch (error) {
    return { failure: { message: error instanceof Error ? error.message.slice(0, 300) : "Posting panel unavailable" } };
  }
}

/** Injected: must stay self-contained. Reports what the open posting panel shows. */
export function readPostingPanel(jobId: string): "loading" | "shown" | "failed" {
  const panel = document.querySelector(".modal.is--visible .modal__inner--document-overlay");
  if (!panel) return "loading";
  const text = panel.textContent ?? "";
  if (text.includes(jobId)) return "shown";
  return /error loading/i.test(text) ? "failed" : "loading";
}

export function isPostingId(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,16}$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class WaterlooWorksSite {
  constructor(private readonly browser: WaterlooWorksBrowser, private readonly pollMs = 200) {}

  private async entry(tabId: number, action: ApplicationEntryAction): Promise<PageResult> {
    const result = await this.browser.evaluate(tabId, applicationEntryControls, action);
    if (!result) throw new Error("Application page is unavailable");
    if (result.failure) { const error = new Error(result.failure.message); if (result.failure.name) error.name = result.failure.name; throw error; }
    return result;
  }

  /** Enters the application wizard and verifies it is for this posting. Never fills or advances it. */
  async enterApplication(tabId: number, jobId: string, entry: Record<string, string>, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let navigationError: unknown;
    try { await this.entry(tabId, { kind: "openWizard", jobId, entry }); }
    catch (error) { navigationError = error; } // Navigation can unload its injection frame.
    while (Date.now() < deadline) {
      try { if ((await this.entry(tabId, { kind: "inspect" })).postingId === jobId) return; }
      catch { /* The wizard may still be navigating. */ }
      await pause(this.pollMs);
    }
    throw navigationError ?? new Error("WaterlooWorks did not open the requested application form; inspect the opened tab");
  }

  /** Opens the posting's own panel on the jobs page and verifies that it loaded. */
  async showPosting(tabId: number, jobId: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let requested = false, failure = "WaterlooWorks did not open the posting; inspect the opened tab";
    while (Date.now() < deadline) {
      if (!requested) {
        const result = await this.browser.evaluate(tabId, showPostingPanel, jobId, "page");
        if (result?.failure) failure = result.failure.message; else requested = true;
      } else {
        const state = await this.browser.evaluate(tabId, readPostingPanel, jobId);
        if (state === "shown") return;
        if (state === "failed") throw new Error(`WaterlooWorks could not load posting ${jobId}. It may no longer be available to your account.`);
      }
      await pause(this.pollMs);
    }
    throw new Error(failure);
  }
}
