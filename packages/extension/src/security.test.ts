import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { EXPECTED_EXTENSION_ID } from "../../shared/src/extension-protocol.js";

const manifest = await Bun.file(new URL("../manifest.json", import.meta.url)).json() as {
  key: string;
  permissions: string[];
  host_permissions: string[];
  optional_host_permissions?: string[];
  content_scripts: Array<{ matches: string[] }>;
  options_ui?: unknown;
};
const source = await Bun.file(new URL("./background.ts", import.meta.url)).text();

function extensionIdFromPublicKey(key: string): string {
  const hash = createHash("sha256").update(Buffer.from(key, "base64")).digest();
  return [...hash.subarray(0, 16)].map(byte => `${String.fromCharCode(97 + (byte >> 4))}${String.fromCharCode(97 + (byte & 0x0f))}`).join("");
}

describe("WaterlooWorks extension security contract", () => {
  test("uses the stable ID derived from its manifest public key", () => {
    expect(extensionIdFromPublicKey(manifest.key)).toBe(EXPECTED_EXTENSION_ID);
  });

  test("asks for no local-network access at install and only 127.0.0.1 optionally, for ChatGPT sign-in", () => {
    expect(manifest.permissions).toEqual(["alarms", "storage", "scripting", "cookies"]);
    expect(manifest.host_permissions).toEqual([
      "https://watworks.alishahzad.dev/*",
      "https://waterlooworks.uwaterloo.ca/*",
      "https://adfs.uwaterloo.ca/*",
      "https://sts.uwaterloo.ca/*",
    ]);
    // The ChatGPT sign-in callback listens on loopback; nothing else is local.
    expect(manifest.optional_host_permissions).toEqual(["http://127.0.0.1/*"]);
    expect(manifest.host_permissions.some(host => /127\.0\.0\.1|localhost|\[::1\]/.test(host))).toBe(false);
    expect(manifest.options_ui).toBeUndefined();
    expect(manifest.content_scripts.flatMap(script => script.matches)).not.toContain("https://login.microsoftonline.com/*");
    expect(manifest.host_permissions).not.toContain("<all_urls>");
    expect(manifest.host_permissions).not.toContain("*://*/*");
  });

  test("the background worker never reads cookie values itself", () => {
    expect(source).not.toMatch(/chrome\.cookies\.getAll|cookie\.value|WATERLOOWORKS_JOBS_URL/i);
    expect(source).not.toMatch(/connectNative|sendNativeMessage|127\.0\.0\.1/);
  });
});
