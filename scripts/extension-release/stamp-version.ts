import { join, resolve } from "node:path";

/** Chrome accepts one to four dot-separated integers from 0 to 65535, without leading zeros. */
const MAX_PART = 65535;

/** `major.minor` from the committed version, with the build number as the patch. */
export function buildVersion(base: string, build: number): string {
  const match = /^(\d+)\.(\d+)\.\d+$/.exec(base);
  if (!match) throw new Error(`Expected a major.minor.patch version, got ${base}`);
  if (!Number.isInteger(build) || build < 1 || build > MAX_PART) throw new Error(`Build number must be between 1 and ${MAX_PART}`);
  return `${Number(match[1])}.${Number(match[2])}.${build}`;
}

/**
 * Release builds only: writes the version into this checkout's package.json and
 * extension manifest so both agree. The committed versions stay as the base.
 */
async function main(): Promise<void> {
  const build = Number(process.argv[2]);
  const root = resolve(import.meta.dir, "../..");
  const files = [join(root, "package.json"), join(root, "packages/extension/manifest.json")];
  const [packageJson, manifest] = await Promise.all(files.map(file => Bun.file(file).json()));
  if (packageJson.version !== manifest.version) throw new Error("Extension and workspace versions must match");
  const version = buildVersion(packageJson.version, build);
  packageJson.version = version; manifest.version = version;
  await Bun.write(files[0]!, JSON.stringify(packageJson, null, 2) + "\n");
  await Bun.write(files[1]!, JSON.stringify(manifest, null, 2) + "\n");
  console.log(version);
}

if (import.meta.main) await main();
