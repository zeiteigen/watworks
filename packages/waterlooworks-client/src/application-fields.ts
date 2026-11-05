import { parseHTML } from "linkedom";
import { parsePageLiteral } from "./bootstrap.js";
import { ProtocolChangedError } from "./errors.js";

export function pageDocument(html: string) { return parseHTML(html).document; }
export function text(value: string | null | undefined): string { return (value ?? "").replace(/\s+/g, " ").trim(); }
export function fieldsRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProtocolChangedError("Invalid application field map");
  const fields: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[\w-]+$/.test(key) || (typeof item !== "string" && typeof item !== "boolean" && typeof item !== "number" && item !== null)) throw new ProtocolChangedError("Unsupported application field value");
    fields[key] = item === null ? "" : String(item);
  }
  return fields;
}
export function navigationFields(html: string, label: string): Record<string, string> {
  const matches = [...pageDocument(html).querySelectorAll("a,button")].filter(node => text(node.textContent) === label && /buildForm\(/.test(node.getAttribute("onclick") ?? ""));
  if (!matches.length) throw new ProtocolChangedError(`Missing document navigation: ${label}`);
  return buildFormFields(matches[0]!.getAttribute("onclick")!);
}
export function buildFormFields(onclick: string): Record<string, string> {
  const literal = /buildForm\(\s*(\{[^}]*\})/.exec(onclick)?.[1];
  if (!literal) throw new ProtocolChangedError("Unsupported document navigation");
  return fieldsRecord(parsePageLiteral(literal));
}
export function hiddenFields(form: Element): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const input of form.querySelectorAll("input[type=hidden][name]")) {
    const name = input.getAttribute("name")!;
    if (name.includes("${")) continue;
    if (Object.hasOwn(fields, name)) throw new ProtocolChangedError("Duplicate hidden form field");
    fields[name] = input.getAttribute("value") ?? "";
  }
  return fields;
}
export function jsonObject(body: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(body); } catch { throw new ProtocolChangedError("Expected an application JSON response"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProtocolChangedError("Invalid application response");
  return value as Record<string, unknown>;
}
export function sourceAction(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start < 0) throw new ProtocolChangedError("Missing application operation");
  const action = /\baction\s*:\s*(['"])(.*?)\1/.exec(source.slice(start, start + 12_000))?.[2];
  if (!action) throw new ProtocolChangedError("Missing application operation action");
  return action;
}
