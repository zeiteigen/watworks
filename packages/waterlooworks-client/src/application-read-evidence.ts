import { pageDocument } from "./application-fields.js";

/** Source structure for diagnosing a changed read request; no literal values leave the browser. */
export function applicationReadEvidence(html: string) {
  const document = pageDocument(html);
  const scripts = [...document.querySelectorAll("script")];
  const snippets: string[] = [];
  for (const script of scripts) {
    // Redact the whole script before taking snippets, so a multiline string
    // cannot be exposed by starting a snippet halfway through it.
    const safeSource = (script.textContent ?? "").replace(/(['"`])(?:\\[\s\S]|(?!\1)[^\\])*?\1/g, value => {
      const key = value.slice(1,-1);
      return (/^(action|studentId|postingModuleId|selectedTerm|numOfDays|status|page|itemsPerPage|sort|filters|isDataViewer)$/.test(key) ? JSON.stringify(key) : '"VALUE"') + "\n".repeat((value.match(/\n/g) ?? []).length);
    }).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, value => "\n".repeat((value.match(/\n/g) ?? []).length)).replace(/\b\d+(?:\.\d+)?\b/g,"0");
    const lines = safeSource.split(/\r?\n/);
    for (let i = 0; i < lines.length && snippets.join("\n").length < 10_000; i++) {
      if (!/\brequest\b|dataViewer|DataViewer|selectedTerm|applicationSubmittedOn|applications/i.test(lines[i]!)) continue;
      const source = lines.slice(Math.max(0,i-2),Math.min(lines.length,i+4)).join("\n");
      snippets.push(source.slice(0,2500));
      i += 3;
    }
  }
  return { scriptCount: scripts.length,
    inlineScripts: scripts.filter(script=>!!script.textContent?.trim()).length,
    literalRequestMentions: (html.match(/\brequest\b/g) ?? []).length,
    pageKind: /\bapplications\b/i.test(document.querySelector("h1")?.textContent ?? "") ? "applications" : /\bdocuments\b/i.test(document.querySelector("h1")?.textContent ?? "") ? "documents" : "other",
    forms: [...document.querySelectorAll("form[id]")].map(form=>form.id).filter(id=>/^[a-zA-Z_][\w-]{0,79}$/.test(id)).slice(0,20),
    navigation: [...document.querySelectorAll("a")].filter(link=>/application|document/i.test(link.textContent ?? "")).slice(0,12).map(link=>{
      const href=link.getAttribute("href") ?? "";
      return {label:(link.textContent ?? "").replace(/\s+/g," ").trim().slice(0,60),
        path:/^\/[a-zA-Z/_.-]{1,120}(?:\?|$)/.exec(href)?.[0]?.replace(/\?$/,"") ?? null,
        handler:/^\s*(?:return\s+)?([a-zA-Z_][\w.]{0,79})\s*\(/.exec(link.getAttribute("onclick") ?? "")?.[1] ?? null};
    }),
    scriptFiles: scripts.map(script=>(script.getAttribute("src") ?? "").split("?")[0]!.split("/").at(-1)).filter((name): name is string=>!!name && /^[a-zA-Z][\w.-]{0,79}\.js$/.test(name)).slice(-20),
    fields: [...document.querySelectorAll("input[name],select[name]")].map(e=>e.getAttribute("name")).filter((name): name is string=>!!name && /^[a-zA-Z_][\w-]{0,79}$/.test(name)).slice(0,40),
    snippets: snippets.slice(0,12) };
}
