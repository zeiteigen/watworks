import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { POSTING_CONTENT_SCRIPT } from "./posting-content.js";

function render(text: string) {
  const { document } = parseHTML("<main></main>");
  const make = (tag: string, props: Record<string, unknown>, ...children: unknown[]) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (key === "class") node.className = String(value);
      else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child as Node);
    return node;
  };
  const execute = new Function("document", "URL", `${POSTING_CONTENT_SCRIPT}; return renderPosting;`);
  const renderer = execute(document, URL) as (value: string, element: typeof make) => HTMLElement;
  return renderer(text, make);
}

describe("posting Markdown renderer", () => {
  test("renders titles, subsections, paragraphs, lists, bold, and safe links", () => {
    const root = render(`# Software Developer\n\n## Responsibilities\nBuild **useful tools**.\n\n- Design systems\n- [Read more](https://example.com/jobs)\n\n1. First\n2. Second`);
    expect(root.querySelector("h3")?.textContent).toBe("Software Developer");
    expect(root.querySelector("h4")?.textContent).toBe("Responsibilities");
    expect(root.querySelector("strong")?.textContent).toBe("useful tools");
    expect(root.querySelector("ul")?.textContent).toBe("Design systemsRead more");
    expect(root.querySelector("ol")?.textContent).toBe("FirstSecond");
    expect(root.querySelector("a")?.getAttribute("href")).toBe("https://example.com/jobs");
    expect(root.querySelector("a")?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  test("keeps HTML inert and rejects unsafe link protocols", () => {
    const root = render('<script>alert(1)</script>\n\n[run](javascript:alert(1))\n\n[also run](data:text/html,hi)');
    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelectorAll("a")).toHaveLength(0);
    expect(root.textContent).toContain("<script>alert(1)</script>");
    expect(root.textContent).toContain("[run](javascript:alert(1))");
    expect(root.textContent).toContain("[also run](data:text/html,hi)");
  });
});
