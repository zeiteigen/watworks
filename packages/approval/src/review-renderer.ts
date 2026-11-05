// Kept separate from transport and interaction code. All untrusted content becomes text nodes.
export const REVIEW_RENDERER = `
function renderManifest(root, manifest) {
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  };
  const internal = key => /^(accountKey|formVersion|nonce|token|sha256|manifestHash|operationKey)$/i.test(key) || /hash$/i.test(key);
  const label = key => key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ").replace(/^./, c => c.toUpperCase());
  const text = value => value === null || value === undefined ? "Not provided" : typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);
  const bytes = size => Number.isFinite(size) ? Number(size).toLocaleString() + " bytes" : text(size);
  const valueNode = value => {
    if (Array.isArray(value)) {
      if (value.length === 0) return element("span", "None");
      const list = element("ul");
      for (const item of value) { const li = element("li"); li.append(valueNode(item)); list.append(li); }
      return list;
    }
    if (object(value)) {
      const list = element("dl");
      for (const [key, child] of Object.entries(value)) {
        if (internal(key)) continue;
        list.append(element("dt", label(key)));
        const dd = element("dd"); dd.append(key === "size" ? element("span", bytes(child)) : valueNode(child)); list.append(dd);
      }
      return list;
    }
    return element("span", text(value));
  };
  const section = (heading, className) => {
    const node = element("section", undefined, className); node.append(element("h2", heading)); root.append(node); return node;
  };
  const detail = (list, heading, value) => {
    if (value === undefined) return;
    list.append(element("dt", heading)); const dd = element("dd"); dd.append(valueNode(value)); list.append(dd);
  };
  root.replaceChildren();
  if (!object(manifest)) { section("Action details").append(valueNode(manifest)); return; }
  const summary = element("dl");
  const summaryFields = { accountLabel: "Account", employer: "Employer", title: "Position", jobId: "Job ID", term: "Work term", deadline: "Application deadline" };
  for (const [key, heading] of Object.entries(summaryFields)) detail(summary, heading, manifest[key]);
  if (summary.children.length) section(manifest.kind === "application" || manifest.jobId !== undefined ? "Application details" : "Account").append(summary);
  if (Array.isArray(manifest.externalSteps) && manifest.externalSteps.length) {
    const warning = section("Additional steps required", "notice");
    warning.append(element("p", "Complete these steps separately. Submitting this action does not complete them."));
    warning.append(valueNode(manifest.externalSteps));
  }
  if (Array.isArray(manifest.documents)) {
    const documents = section(manifest.kind === "set_default_documents" ? "Default document selection" : manifest.kind === "processed_document" ? "Processed document" : "Documents to submit");
    if (!manifest.documents.length) documents.append(element("p", "No documents selected."));
    manifest.documents.forEach((entry, index) => {
      const card = element("article", undefined, "document");
      if (!object(entry)) { card.append(valueNode(entry)); documents.append(card); return; }
      card.append(element("h3", entry.label || entry.requirementLabel || "Document " + (index + 1)));
      const file = object(entry.file) ? entry.file : object(entry.document) ? entry.document : entry;
      const list = element("dl");
      detail(list, "Name", file.name || file.filename);
      if (file.size !== undefined) detail(list, "File size", bytes(file.size));
      detail(list, "Document ID", file.id);
      detail(list, "Revision", file.revision);
      detail(list, "Source", file.source);
      card.append(list);
      if (object(entry.storedDocument)) {
        card.append(element("h4", "Server-processed PDF — this is what will be submitted"));
        const stored = element("dl");
        detail(stored, "Name", entry.storedDocument.name);
        detail(stored, "Document ID", entry.storedDocument.id);
        detail(stored, "Verified PDF digest", entry.storedDocument.revision);
        card.append(stored);
      }
      documents.append(card);
    });
  }
  if (Array.isArray(manifest.answers)) {
    const answers = section("Your answers");
    if (!manifest.answers.length) answers.append(element("p", "No additional questions."));
    const list = element("dl");
    manifest.answers.forEach((answer, index) => {
      if (object(answer)) detail(list, answer.question || answer.label || "Question " + (index + 1), Object.hasOwn(answer, "displayValue") ? answer.displayValue : answer.value);
      else detail(list, "Answer " + (index + 1), answer);
    });
    answers.append(list);
  }
  const remaining = Object.fromEntries(Object.entries(manifest).filter(([key]) => !internal(key) && !Object.hasOwn(summaryFields, key) && !["kind", "documents", "answers", "externalSteps"].includes(key)));
  if (Object.keys(remaining).length) section("Action details").append(valueNode(remaining));
}
`;
