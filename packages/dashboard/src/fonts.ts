// Bun embeds file imports in compiled releases, so fonts work offline there too.
import caveat from "../assets/caveat.ttf" with { type: "file" };
import nunito from "../assets/nunito-sans.ttf" with { type: "file" };

const fonts: Record<string, string> = { "/fonts/caveat.ttf": caveat, "/fonts/nunito-sans.ttf": nunito };
export function dashboardFont(path: string): ReturnType<typeof Bun.file> | undefined {
  const file = fonts[path];
  return file ? Bun.file(file) : undefined;
}
