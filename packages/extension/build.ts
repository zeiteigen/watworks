import { DASHBOARD_PAGE, DASHBOARD_SCRIPT, DASHBOARD_STYLE } from "../dashboard/src/page.js";
import { join } from "node:path";

export async function buildExtension(outdir = join(import.meta.dir, "../../dist/packages/extension")): Promise<void> {
  const result = await Bun.build({
    entrypoints: ["background", "popup", "inbox", "dashboard", "diagnostics", "submission-settings", "hosted"].map(name => join(import.meta.dir, `src/${name}.ts`)),
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

  for (const name of ["popup.html", "popup.css", "popup-layout.css", "inbox.html", "diagnostics.html", "submission-settings.html", "submission-settings.css", "hosted.html", "hosted.css", "icon16.png", "icon32.png", "icon48.png", "icon128.png"]) await Bun.write(join(outdir,name),Bun.file(join(import.meta.dir,"src",name)));
  await Bun.write(join(outdir, "dashboard.html"), DASHBOARD_PAGE
    .replace('href="/dashboard.css"', 'href="dashboard.css"')
    .replace('<script src="/dashboard.js" defer></script>', '<script src="dashboard.js" defer></script><script src="dashboard-ui.js" defer></script>'));
  await Bun.write(join(outdir, "dashboard-ui.js"), DASHBOARD_SCRIPT);
  await Bun.write(join(outdir, "dashboard.css"), DASHBOARD_STYLE.replaceAll("url('/fonts/", "url('fonts/"));
  for (const font of ["caveat.ttf", "nunito-sans.ttf"]) {
    await Bun.write(join(outdir, "fonts", font), Bun.file(join(import.meta.dir, "../dashboard/assets", font)));
  }
  const manifest = await Bun.file(join(import.meta.dir, "manifest.json")).text();
  await Bun.write(join(outdir, "manifest.json"), manifest);
  console.error(`Built ${outdir}`);
}

if (import.meta.main) await buildExtension();
