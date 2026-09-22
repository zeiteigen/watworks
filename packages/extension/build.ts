const result = await Bun.build({
  entrypoints: ["packages/extension/src/background.ts"],
  outdir: "packages/extension/dist",
  target: "browser",
  format: "esm",
  sourcemap: "external",
});

if (!result.success) {
  for (const message of result.logs) console.error(message);
  throw new Error("Extension build failed");
}

const manifest = await Bun.file("packages/extension/manifest.json").text();
await Bun.write("packages/extension/dist/manifest.json", manifest);
console.error("Built packages/extension/dist");
