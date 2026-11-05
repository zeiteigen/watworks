import { afterEach, expect, test } from "bun:test";
import { openApplicationForm } from "./open-application-form.js";
import type { BrowserApplicationReads } from "./application-reads.js";

const originalChrome = globalThis.chrome;
afterEach(() => { globalThis.chrome = originalChrome; });

function fixture(options: { redirect?: boolean; navigationUnloads?: boolean } = {}) {
  const calls: unknown[] = [];
  const reads: Pick<BrowserApplicationReads, "getApplicationEntry"> = {
    getApplicationEntry: async jobId => {
      calls.push(["entry", jobId]);
      return { fields: { action: "fake-open-wizard", postingId: jobId }, formVersion: "v1" };
    },
  };
  globalThis.chrome = {
    tabs: {
      create: async () => { calls.push("tab"); return { id: 42 }; },
      get: async () => ({ status: "complete", url: options.redirect ? "https://login.microsoftonline.com/" : "https://waterlooworks.uwaterloo.ca/myAccount/co-op/full/jobs.htm" }),
    },
    scripting: { executeScript: async (details: { args: Array<{ kind: string; jobId?: string; entry?: unknown }> }) => {
      const action = details.args[0]!;
      calls.push(action);
      if (action.kind === "openWizard" && options.navigationUnloads) throw Error("Frame unloaded");
      return [{ result: { failure: null, postingId: action.kind === "inspect" ? "495378" : null } }];
    } },
  } as unknown as typeof chrome;
  return { reads, calls };
}

test("opens the selected job's wizard and verifies the form without filling or advancing it", async () => {
  const { reads, calls } = fixture();
  expect(await openApplicationForm("495378", reads)).toEqual({ jobId: "495378", tabId: 42 });
  expect(calls).toEqual([
    ["entry", "495378"], "tab",
    { kind: "openWizard", jobId: "495378", entry: { action: "fake-open-wizard", postingId: "495378" } },
    { kind: "inspect" },
  ]);
});

test("verifies the wizard even when navigation unloads its injection frame", async () => {
  const { reads } = fixture({ navigationUnloads: true });
  expect(await openApplicationForm("495378", reads)).toEqual({ jobId: "495378", tabId: 42 });
});

test("rejects sign-in redirects before navigating to the form", async () => {
  const { reads, calls } = fixture({ redirect: true });
  await expect(openApplicationForm("495378", reads)).rejects.toThrow("Sign in");
  expect(calls).toEqual([["entry", "495378"], "tab"]);
});

test("unavailable application routes stop before opening a tab", async () => {
  const { reads, calls } = fixture();
  reads.getApplicationEntry = async () => { throw Error("Posting already applied"); };
  await expect(openApplicationForm("495378", reads)).rejects.toThrow("already applied");
  expect(calls).toEqual([]);
});

test("rejects malformed posting IDs before reading or opening anything", async () => {
  const { reads, calls } = fixture();
  for (const id of [undefined, "", "123?other=456", "0", "9007199254740992"]) {
    await expect(openApplicationForm(id, reads)).rejects.toThrow("Invalid WaterlooWorks posting ID");
  }
  expect(calls).toEqual([]);
});
