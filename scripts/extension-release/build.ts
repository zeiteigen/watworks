import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { buildExtension } from "../../packages/extension/build.js";
import { EXPECTED_EXTENSION_ID } from "../../packages/shared/src/extension-protocol.js";
import { VERSION } from "../../packages/shared/src/version.js";
import { verifyCrx } from "./verify-crx.js";

const root = resolve(import.meta.dir, "../..");

async function main(): Promise<void> {
  const keyPath = process.env.WAT_EXTENSION_SIGNING_KEY_FILE;
  if (!keyPath) throw new Error("Set WAT_EXTENSION_SIGNING_KEY_FILE to the existing private PEM file");
  const manifest = await Bun.file(join(root, "packages/extension/manifest.json")).json();
  if (manifest.version !== VERSION) throw new Error("Extension and workspace versions must match");
  const tag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;
  if (tag && tag !== `extension-v${VERSION}`) throw new Error(`Expected release tag extension-v${VERSION}`);
  const key = createPrivateKey(await Bun.file(keyPath).text());
  const publicKey = createPublicKey(key).export({type: "spki", format: "der"});
  const id = createHash("sha256").update(publicKey).digest("hex").slice(0,32).replace(/[0-9a-f]/g, char => String.fromCharCode(97 + parseInt(char,16)));
  if (publicKey.toString("base64") !== manifest.key || id !== EXPECTED_EXTENSION_ID) throw new Error("Signing key does not match the manifest and trusted extension ID");
  const chrome = process.env.CHROME_BIN ?? Bun.which("chromium") ?? Bun.which("google-chrome");
  if (!chrome) throw new Error("Install Chromium/Chrome or set CHROME_BIN");
  const temporary = await mkdtemp(join(tmpdir(), "watworks-extension-release-"));
  try {
    const extension = join(temporary, "extension");
    await buildExtension(extension);
    const packed = Bun.spawnSync([chrome, "--headless", "--no-sandbox", "--disable-gpu", `--user-data-dir=${join(temporary,"profile")}`, `--pack-extension=${extension}`, `--pack-extension-key=${resolve(keyPath)}`], {stdout:"pipe",stderr:"pipe", timeout:30_000});
    if (packed.exitCode) throw new Error("Chrome could not pack the extension");
    const bytes = Buffer.from(await Bun.file(`${extension}.crx`).arrayBuffer());
    const zip = verifyCrx(bytes, manifest.key, EXPECTED_EXTENSION_ID);
    const output = join(root, "dist/releases");
    await mkdir(output, {recursive:true});
    const name = `waterlooworks-extension-v${VERSION}`;
    const checksums: string[] = [];
    for (const [suffix, content] of [["crx", bytes], ["zip", zip]] as const) {
      const path = join(output, `${name}.${suffix}`);
      await Bun.write(path, content);
      checksums.push(`${createHash("sha256").update(content).digest("hex")}  ${basename(path)}`);
      console.log(path);
    }
    await Bun.write(join(output, `${name}.sha256`), checksums.join("\n") + "\n");
  } finally { await rm(temporary, {recursive:true,force:true}); }
}

if (import.meta.main) await main();
