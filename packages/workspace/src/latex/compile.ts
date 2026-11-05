import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { installRoot } from "../paths.js";

export interface LatexEngine { name: "tectonic" | "pdflatex"; path: string }

const exe = process.platform === "win32" ? ".exe" : "";

/** Tectonic is preferred (setup installs it into .tools/); an existing TeX Live pdflatex also works. */
export function findLatexEngine(): LatexEngine | undefined {
  const override = process.env.WAT_TECTONIC;
  if (override && existsSync(override)) return { name: "tectonic", path: override };
  const bundled = join(installRoot(), ".tools", "tectonic", `tectonic${exe}`);
  if (existsSync(bundled)) return { name: "tectonic", path: bundled };
  const tectonic = Bun.which("tectonic");
  if (tectonic) return { name: "tectonic", path: tectonic };
  const pdflatex = Bun.which("pdflatex");
  if (pdflatex) return { name: "pdflatex", path: pdflatex };
  return undefined;
}

export class LatexCompileError extends Error {
  constructor(message: string, readonly log: string) { super(message); }
}

export interface CompiledPdf { bytes: Uint8Array; pages: number; engine: LatexEngine["name"] }

/** Compile in an isolated temp directory so templates cannot read or write the workspace. */
export async function compileLatex(source: string, options: { timeoutMs?: number } = {}): Promise<CompiledPdf> {
  const engine = findLatexEngine();
  if (!engine) throw new Error("No LaTeX engine found. Run `bun run setup` to install Tectonic.");
  const dir = await mkdtemp(join(tmpdir(), "wat-latex-"));
  try {
    const tex = join(dir, "document.tex");
    await writeFile(tex, source);
    const args = engine.name === "tectonic"
      ? [engine.path, "--chatter", "minimal", "--untrusted", "--outdir", dir, tex]
      : [engine.path, "-interaction=nonstopmode", "-halt-on-error", "-no-shell-escape", `-output-directory=${dir}`, tex];
    const proc = Bun.spawn(args, { cwd: dir, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    // The first Tectonic run downloads its package bundle, so allow several minutes.
    const timer = setTimeout(() => proc.kill(), options.timeoutMs ?? 300_000);
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    const log = `${stdout}\n${stderr}`;
    if (code !== 0 || !existsSync(join(dir, "document.pdf"))) throw new LatexCompileError(`LaTeX compilation failed (${engine.name}):\n${errorLines(log)}`, log);
    const bytes = new Uint8Array(await readFile(join(dir, "document.pdf")));
    const pages = (await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount();
    return { bytes, pages, engine: engine.name };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function errorLines(log: string): string {
  const lines = log.split("\n");
  const interesting = lines.flatMap((line, index) => /^!|error:|Error/.test(line) ? lines.slice(index, index + 3) : []);
  return (interesting.length ? interesting : lines.slice(-20)).join("\n").slice(0, 4000);
}
