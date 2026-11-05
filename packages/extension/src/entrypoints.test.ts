import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { parseHTML } from "linkedom";

async function bundle(entry: "dashboard" | "popup"): Promise<string> {
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
        if (message.type === "startService") return { ok: true };
        if (message.type === "status") return { ok: true, value: { authenticated: true } };
        if (message.type === "discoveriesList") return { ok: true, value: [{ id: "discovery-1" }] };
        return { ok: true, value: null };
      },
      getURL: (path: string) => `chrome-extension://test/${path}`,
    },
    tabs: { create: async () => {} },
    permissions: { request: async () => true },
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
  test("dashboard bundle initializes its status element under Window.status semantics", async () => {
    const { document, window } = parseHTML("<html><body><header class='masthead'></header></body></html>");
    const context = browserContext(document as unknown as Document, window as unknown as Window);
    const script = await bundle("dashboard");
    expect(() => runInNewContext(script, context.global)).not.toThrow();

    await new Promise(resolve => setTimeout(resolve, 0));
    const status = document.querySelector<HTMLElement>(".masthead p[role=status]");
    expect(status).not.toBeNull();
    expect(status?.textContent).toBe("Workspace service is running.");
    expect(context.getWindowStatus()).not.toContain("[object HTMLParagraphElement]");
  });

  test("dashboard defaults to Cloudflare and hides overrides behind the debug shortcut", async () => {
    const {document,window}=parseHTML("<html><head></head><body><header class='masthead'></header><section id='settings-panel'></section></body></html>");
    const context=browserContext(document as unknown as Document,window as unknown as Window);
    runInNewContext(await bundle("dashboard"),context.global);
    const create=context.global.createSubmissionSettingsPanel as ()=>HTMLElement;
    expect(typeof create).toBe("function");
    document.querySelector("#settings-panel")!.append(create());
    await new Promise(resolve=>setTimeout(resolve,0));
    const endpoint=document.querySelector<HTMLInputElement>("#submission-endpoint")!;
    expect(endpoint.value).toBe("https://watworks.alishahzad.dev");
    const developer=document.querySelector<HTMLElement>("#submission-developer")!;
    expect(developer.hidden).toBe(true);
    const type=(target:EventTarget,word:string)=>{
      for(const key of word){
        const event=new (window as unknown as {Event:typeof Event}).Event("keydown",{bubbles:true});
        Object.assign(event,{key});target.dispatchEvent(event);
      }
    };
    type(endpoint,"debug");
    expect(developer.hidden).toBe(true);
    type(document,"debug");
    expect(developer.hidden).toBe(false);
    expect(document.querySelector("#submission-status")?.textContent).toContain("syncs automatically");
    endpoint.value="http://127.0.0.1:39453";
    document.querySelector<HTMLButtonElement>("#submission-hide-developer")!.click();
    expect(developer.hidden).toBe(true);
    await new Promise(resolve=>setTimeout(resolve,0));
    expect(endpoint.value).toBe("https://watworks.alishahzad.dev");
    expect(document.querySelector("#submission-save")?.textContent).toBe("Save endpoint and grant access");
    expect(document.querySelector("#submission-transfer")).toBeNull();
    expect(document.querySelector("#submission-clear")).toBeNull();
    expect(document.querySelector("dialog")).toBeNull();
    expect(document.querySelector('link[href="chrome-extension://test/submission-settings.css"]')).not.toBeNull();
  });

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
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.querySelector<HTMLElement>('[href="submission-settings.html"]')!.hidden).toBe(false);
  });
});
