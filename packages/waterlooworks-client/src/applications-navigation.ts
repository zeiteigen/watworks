import { fieldsRecord, pageDocument, text } from "./application-fields.js";
import { parsePageLiteral } from "./bootstrap.js";
import { ProtocolChangedError } from "./errors.js";

/** Literal read navigation used by the Full-Cycle My Applications stat card. */
export function applicationsNavigation(html: string) {
  const document = pageDocument(html);
  const links = [...document.querySelectorAll("a"), ...[...document.querySelectorAll("template")].flatMap(template => [...template.content.querySelectorAll("a")])];
  const link = links.find(node => text(node.textContent) === "My Applications" && node.getAttribute("@click") === "goToApplicationsGrid");
  if (!link) throw new ProtocolChangedError("Missing My Applications navigation");
  const matches = [...html.matchAll(/\bgoToApplicationsGrid\s*\(\s*\)\s*\{\s*orbisApp\.buildForm\(\s*(\{[^{}]*\})\s*,\s*["']\/myAccount\/co-op\/full\/applications\.htm["']\s*\)\.submit\(\);?\s*\}/g)];
  if (matches.length !== 1) throw new ProtocolChangedError("Applications navigation changed");
  const fields = fieldsRecord(parsePageLiteral(matches[0]![1]!));
  if (!fields.action || fields.numOfDays !== "0" || fields.comingFromNp !== "true" || fields.refreshSearch !== "true" || Object.keys(fields).length !== 4) throw new ProtocolChangedError("Applications navigation parameters changed");
  return fields;
}
