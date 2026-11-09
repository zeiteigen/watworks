import { WATERLOOWORKS_ORIGIN } from "../../shared/src/protocol.js";
import type { WaterlooWorksBrowser } from "../../waterlooworks-client/src/site-interface.js";

/** The user's own Chrome as a WaterlooWorks browser: visible tabs, for manual navigation only. */
export const chromeWaterlooWorksBrowser: WaterlooWorksBrowser = {
  async open(url) {
    const tab = await chrome.tabs.create({ url, active: true });
    if (tab.id === undefined) throw new Error("Could not open WaterlooWorks");
    const deadline = Date.now() + 30_000;
    while ((await chrome.tabs.get(tab.id)).status !== "complete") {
      if (Date.now() >= deadline) throw new Error("WaterlooWorks did not finish loading");
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!(await chrome.tabs.get(tab.id)).url?.startsWith(WATERLOOWORKS_ORIGIN + "/")) throw new Error("Sign in to WaterlooWorks in the opened tab, then try again");
    return tab.id;
  },
  async url(id) { return (await chrome.tabs.get(id)).url ?? ""; },
  async evaluate<A, R>(id: number, fn: (arg: A) => R | Promise<R>, arg: A, world?: "page") {
    const injection = { target: { tabId: id }, func: fn, args: [arg], ...(world === "page" ? { world: "MAIN" as const } : {}) };
    const results = await chrome.scripting.executeScript(injection as unknown as chrome.scripting.ScriptInjection<[A], R>);
    return results[0]?.result as R;
  },
};
