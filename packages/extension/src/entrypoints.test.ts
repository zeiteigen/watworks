import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { parseHTML } from "linkedom";

async function bundle(entry: "popup"): Promise<string> {
  const result = await Bun.build({
    entrypoints: [`${import.meta.dir}/${entry}.ts`],
    target: "browser",
    format: "esm",
  });
  if (!result.success) throw new Error(result.logs.map(log => log.message).join("\n"));
  return result.outputs[0]!.text();
}


function chromeApi() {
  return {
    storage: {local:{setAccessLevel:async()=>{},get:async()=>({})},session:{setAccessLevel:async()=>{},get:async()=>({})}},
    runtime: {
      sendMessage: async (message: { type: string }) => {
        if (message.type === "status") return { ok: true, value: { authenticated: true } };
        return { ok: true, value: null };
      },
      getURL: (path: string) => `chrome-extension://test/${path}`,
    },
    tabs: { create: async () => {} },
  };
}

function browserContext(document: Document, window: Window) {
  let windowStatus = "";
  const global = Object.create({
    get status() { return windowStatus; },
    set status(value: unknown) { windowStatus = String(value); },
  }) as Record<string, unknown>;
  Object.assign(global, {
    document,
    window,
    chrome: chromeApi(),
    Event: (window as unknown as { Event: typeof Event }).Event,
    fetch: async () => { throw new Error("fetch should not run in this test"); },
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    URL, AbortSignal, TextEncoder, TextDecoder, atob, btoa,
  });
  return { global, getWindowStatus: () => windowStatus };
}

describe("extension entrypoint bundles", () => {
  test("popup bundle updates its status element under Window.status semantics", async () => {
    const { document, window } = parseHTML(await Bun.file(`${import.meta.dir}/popup.html`).text());
    const context = browserContext(document as unknown as Document, window as unknown as Window);
    const script = await bundle("popup");
    expect(() => runInNewContext(script, context.global)).not.toThrow();

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.querySelector("#status")?.textContent).toBe("Signed in to WaterlooWorks.");
    expect(context.getWindowStatus()).not.toContain("[object HTMLElement]");
    expect(document.querySelector(".wordmark")?.textContent).toBe("watworks");
    expect(document.querySelector("#signin")).toBeNull();
    const diagnostics = document.querySelector<HTMLAnchorElement>('[href="diagnostics.html"]')!;
    expect(diagnostics.hidden).toBe(true);
    for (const key of "debug") {
      const event = new (window as unknown as { Event: typeof Event }).Event("keydown", { bubbles: true });
      Object.assign(event, { key });
      document.dispatchEvent(event);
    }
    expect(diagnostics.hidden).toBe(false);
    for (const removed of ["dashboard.html", "inbox.html", "submission-settings.html"]) expect(document.querySelector(`[href="${removed}"]`)).toBeNull();
    expect(document.querySelector("#start-service")).toBeNull();
  });
});
