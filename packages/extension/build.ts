import { join } from "node:path";
import { rm } from "node:fs/promises";

export async function buildExtension(outdir = join(import.meta.dir, "../../dist/packages/extension")): Promise<void> {
  // The output directory belongs to this build; stale pages from older builds must not ship.
  await rm(outdir, { recursive: true, force: true });
  const result = await Bun.build({
    entrypoints: ["background", "popup", "diagnostics", "hosted"].map(name => join(import.meta.dir, `src/${name}.ts`)),
    define: {__WAT_EXTENSION_BUILD__:JSON.stringify(new Date().toISOString())},
    outdir,
    target: "browser",
    format: "esm",
    sourcemap: "external",
  });

  if (!result.success) {
    for (const message of result.logs) console.error(message);
    throw new Error("Extension build failed");
  }

  const content = await Bun.build({
    entrypoints: [join(import.meta.dir, "src/page-content.ts")], outdir,
    target: "browser", format: "iife", sourcemap: "external",
  });
  if (!content.success) throw new Error(`Content script build failed: ${content.logs.join("\n")}`);

  for (const name of ["popup.html", "popup.css", "popup-layout.css", "dashboard.css", "diagnostics.html", "hosted.html", "hosted.css", "icon16.png", "icon32.png", "icon48.png", "icon128.png"]) await Bun.write(join(outdir,name),Bun.file(join(import.meta.dir,"src",name)));
  for (const font of ["caveat.ttf", "nunito-sans.ttf"]) {
    await Bun.write(join(outdir, "fonts", font), Bun.file(join(import.meta.dir, "assets/fonts", font)));
  }
  // pdf.js renders resume previews in the hosted page; its worker must be a packaged file.
  await Bun.write(join(outdir, "pdf.worker.min.mjs"), Bun.file(Bun.resolveSync("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.dir)));
  const manifest = await Bun.file(join(import.meta.dir, "manifest.json")).text();
  await Bun.write(join(outdir, "manifest.json"), manifest);
  console.error(`Built ${outdir}`);
}

if (import.meta.main) await buildExtension();
