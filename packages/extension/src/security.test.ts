import { describe, expect, test } from "bun:test";

const manifest = await Bun.file(new URL("../manifest.json", import.meta.url)).json();
const source = await Bun.file(new URL("./background.ts", import.meta.url)).text();

describe("WaterlooWorks extension security contract", () => {
  test("requests only narrow permissions", () => {
    expect(manifest.permissions).toEqual(["cookies", "nativeMessaging"]);
    expect(manifest.host_permissions).toEqual(["https://waterlooworks.uwaterloo.ca/*"]);
    expect(manifest.permissions).not.toContain("tabs");
    expect(manifest.permissions).not.toContain("storage");
    expect(manifest.host_permissions).not.toContain("<all_urls>");
  });

  test("queries and exports only WaterlooWorks-domain cookies", () => {
    expect(source).toContain("chrome.cookies.getAll({ url: WATERLOOWORKS_JOBS_URL })");
    expect(source).toContain("cookies.filter(isWaterlooWorksCookie).map(narrowCookie)");
    expect(source).toContain("chrome.cookies.onChanged.addListener");
    expect(source).toContain("scheduleSessionExport");
    expect(source).toContain("if (!isBridgeRequest(message)) return;");
    expect(source).toContain("chrome.runtime.lastError");
    expect(source).toContain("if (nativePort !== port) return false;");
    expect(source).not.toContain("<all_urls>");
    expect(source).not.toMatch(/microsoft|duo|sso/i);
  });
});
