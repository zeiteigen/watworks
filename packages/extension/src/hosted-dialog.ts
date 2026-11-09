export const HOSTED_DIALOG_CLOSED = "hosted-dialog-closed";

/** Modal shell for per-job panels. Queue refreshes pause while one is open. */
export function hostedDialog(title: string, body: HTMLElement): { dialog: HTMLDialogElement; open: () => void; close: () => void } {
  const dialog = document.createElement("dialog"), header = document.createElement("div"), heading = document.createElement("h3"), dismiss = document.createElement("button");
  dialog.className = "job-dialog"; header.className = "job-dialog-heading"; heading.textContent = title;
  dismiss.type = "button"; dismiss.className = "secondary"; dismiss.textContent = "Close"; dismiss.setAttribute("aria-label", `Close ${title}`);
  header.append(heading, dismiss); dialog.append(header, body);
  const EventType = () => dialog.ownerDocument.defaultView?.Event ?? Event;
  // `close` does not bubble; announce it so the view can apply refreshes it deferred.
  dialog.addEventListener("close", () => dialog.dispatchEvent(new (EventType())(HOSTED_DIALOG_CLOSED, { bubbles: true })));
  const close = () => {
    if (typeof dialog.close === "function") dialog.close();
    else { dialog.removeAttribute("open"); dialog.dispatchEvent(new (EventType())("close")); }
  };
  dismiss.addEventListener("click", close);
  // Clicking the backdrop (the dialog element itself) closes it.
  dialog.addEventListener("click", event => { if (event.target === dialog) close(); });
  const open = () => { if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", ""); };
  return { dialog, open, close };
}
