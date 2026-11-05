import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { EXPECTED_EXTENSION_ID } from "../../shared/src/extension-protocol.js";

const manifest = await Bun.file(new URL("../manifest.json", import.meta.url)).json() as {
  key: string;
  permissions: string[];
  host_permissions: string[];
  optional_host_permissions?: string[];
  content_scripts: Array<{ matches: string[] }>;
  options_ui?: { page: string; open_in_tab: boolean };
};
const source = await Bun.file(new URL("./background.ts", import.meta.url)).text();
const connection = await Bun.file(new URL("./connection.ts", import.meta.url)).text();

function extensionIdFromPublicKey(key: string): string {
  const hash = createHash("sha256").update(Buffer.from(key, "base64")).digest();
  return [...hash.subarray(0, 16)].map(byte => `${String.fromCharCode(97 + (byte >> 4))}${String.fromCharCode(97 + (byte & 0x0f))}`).join("");
}

describe("WaterlooWorks extension security contract", () => {
  test("uses the stable ID derived from its manifest public key", () => {
    expect(extensionIdFromPublicKey(manifest.key)).toBe(EXPECTED_EXTENSION_ID);
  });

  test("keeps permanent host access bounded and requests configurable server hosts optionally", () => {
    expect(manifest.permissions).toEqual(["alarms", "storage", "notifications", "scripting", "nativeMessaging", "cookies"]);
    expect(manifest.host_permissions).toEqual([
      "https://watworks.alishahzad.dev/*",
      "https://waterlooworks.uwaterloo.ca/*",
      "http://127.0.0.1/*",
      "https://adfs.uwaterloo.ca/*",
      "https://sts.uwaterloo.ca/*",
    ]);
    expect(manifest.optional_host_permissions).toEqual([
      "https://*/*",
      "http://localhost/*",
      "http://[::1]/*",
    ]);
    expect(manifest.options_ui).toEqual({ page: "submission-settings.html", open_in_tab: true });
    expect(manifest.content_scripts.flatMap(script => script.matches)).not.toContain("https://login.microsoftonline.com/*");
    expect(manifest.host_permissions).not.toContain("<all_urls>");
    expect(manifest.host_permissions).not.toContain("*://*/*");
  });

  test("connection uses the extension broker without exporting cookies or credentials", () => {
    expect(connection).toContain("/extension");
    expect(connection).toContain("DEFAULT_BRIDGE_BASE_URL");
    expect(connection).not.toMatch(/chrome\.cookies|WATERLOOWORKS_JOBS_URL/i);
    expect(connection).not.toContain("/session");
    expect(connection).not.toMatch(/authorization|cookie|dashboard-token|credentials/i);
    expect(connection).not.toContain("<all_urls>");
    expect(source).not.toMatch(/chrome\.cookies\.getAll|cookie\.value|WATERLOOWORKS_JOBS_URL/i);
  });
});
