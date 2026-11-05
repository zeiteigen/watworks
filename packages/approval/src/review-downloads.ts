export const REVIEW_DOWNLOADS = `
function renderDownloads(root, documents, download) {
  root.replaceChildren();
  root.hidden = !Array.isArray(documents) || documents.length === 0;
  if (root.hidden) return;
  const heading = document.createElement("h2"); heading.textContent = "Review the captured PDFs"; root.append(heading);
  const explanation = document.createElement("p"); explanation.textContent = "Download these exact files to check their contents before approving."; root.append(explanation);
  const buttons = document.createElement("div"); buttons.className = "buttons";
  for (const entry of documents) {
    const button = document.createElement("button");
    button.type = "button"; button.className = "secondary";
    button.textContent = "Download " + entry.name + " (" + Number(entry.size).toLocaleString() + " bytes)";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try { await download(entry); } finally { button.disabled = false; }
    });
    buttons.append(button);
  }
  root.append(buttons);
}
`;
