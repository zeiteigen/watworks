import { REVIEW_RENDERER } from "./review-renderer.js";
import { REVIEW_DOWNLOADS } from "./review-downloads.js";

// This script is served as a separate same-origin asset; manifest content is never HTML.
export const REVIEW_SCRIPT = `"use strict";
(() => {
  ${REVIEW_RENDERER}
  ${REVIEW_DOWNLOADS}
  const fragment = new URLSearchParams(location.hash.slice(1));
  const id = fragment.get("review");
  const token = fragment.get("token");
  history.replaceState(null, "", "/");
  // A continuation on this origin must initialize with its own capability and snapshot.
  window.addEventListener("hashchange", () => {
    const next = new URLSearchParams(location.hash.slice(1));
    if (next.get("review") && next.get("token")) location.reload();
  });
  const status = document.getElementById("status");
  const approve = document.getElementById("approve");
  const reject = document.getElementById("reject");
  let snapshot;
  let busy = false;
  let timer;
  let documentsFingerprint;
  const setButtons = () => {
    approve.disabled = busy || !snapshot || snapshot.status !== "awaiting_approval";
    reject.disabled = approve.disabled;
  };
  const render = (data) => {
    const changed = !snapshot || data.manifestHash !== snapshot.manifestHash;
    snapshot = data;
    const statuses = {
      awaiting_approval: "Ready for your review", executing: "Processing your approved action…",
      review_required: "Uploads completed. Review the server-processed PDFs before submitting.",
      rejected: "You rejected this action", expired: "This review has expired",
      invalidated: "This review is no longer valid. Prepare a new review to continue.",
      failed: "The action failed before any remote change was attempted.",
      succeeded: "Action completed successfully",
      outcome_unknown: "The outcome is uncertain. Check WaterlooWorks before taking another action."
    };
    status.textContent = data.status === "failed" && data.result && data.result.code === "blocked_by_previous_attempt"
      ? "Blocked by previous operation " + data.result.operationId + " (" + data.result.state + "). This application made no remote changes. Ask the agent to reconcile that operation; do not retry it."
      : data.status === "failed" && data.result && data.result.code === "authentication_expired"
        ? "WaterlooWorks signed out before any write. Sign in and open a new review; no account lock was created."
        : statuses[data.status] || data.status;
    const titles = { processed_document: "Review processed document", application: "Review your application", upload_document: "Review document upload", set_default_documents: "Review default documents" };
    document.getElementById("title").textContent = data.manifest && titles[data.manifest.kind] || "Review WaterlooWorks action";
    if (changed) renderManifest(document.getElementById("review-content"), data.manifest);
    const nextDocumentsFingerprint = JSON.stringify(data.documents || []);
    if (nextDocumentsFingerprint !== documentsFingerprint) {
      renderDownloads(document.getElementById("document-downloads"), data.documents, downloadDocument);
      documentsFingerprint = nextDocumentsFingerprint;
    }
    document.getElementById("manifest").textContent = JSON.stringify(data.manifest, null, 2);
    document.getElementById("hash").textContent = data.manifestHash;
    document.getElementById("expiry").textContent = "Approval expires: " + new Date(data.expiresAt).toLocaleString();
    approve.textContent = data.actionLabel || "Approve and submit";
    document.getElementById("result").textContent = data.result === undefined ? "" : JSON.stringify(data.result, null, 2);
    document.getElementById("result-section").hidden = data.result === undefined;
    const resultSection = document.getElementById("result-section");
    const previous = document.getElementById("continue-review"); if (previous) previous.remove();
    if (data.status === "review_required" && data.result && typeof data.result.reviewUrl === "string") {
      const url = new URL(data.result.reviewUrl);
      if (url.protocol === "http:" && url.hostname === "127.0.0.1") {
        const link = document.createElement("a"); link.id = "continue-review"; link.href = url.href;
        link.target = "_blank"; link.rel = "noopener noreferrer";
        link.textContent = "Review processed PDFs and submit"; resultSection.append(link);
      }
    }
    setButtons();
  };
  const fetchReview = async (suffix = "", body) => {
    const response = await fetch("/api/reviews/" + encodeURIComponent(id) + suffix, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? { Authorization: "Bearer " + token } : {
        Authorization: "Bearer " + token, "Content-Type": "application/json"
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer"
    });
    if (!response.ok) throw new Error("Review request was refused (" + response.status + "). Reload the original review link to check its state.");
    return response;
  };
  const request = async (suffix = "", body) => (await fetchReview(suffix, body)).json();
  const downloadDocument = async (entry) => {
    try {
      const response = await fetchReview("/documents/" + encodeURIComponent(entry.id));
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      try {
        const link = document.createElement("a");
        link.href = objectUrl; link.download = entry.name; link.rel = "noopener";
        document.body.append(link); link.click(); link.remove();
      } finally { setTimeout(() => URL.revokeObjectURL(objectUrl), 1000); }
    } catch { status.textContent = "The PDF could not be downloaded. Open the original review link to try again."; }
  };
  const refresh = async () => {
    render(await request());
    if (["awaiting_approval", "executing"].includes(snapshot.status)) timer = setTimeout(poll, 1000);
  };
  const poll = async () => {
    try { await refresh(); } catch (error) { status.textContent = error.message; approve.disabled = reject.disabled = true; }
  };
  const decide = async (decision) => {
    if (busy || !snapshot || snapshot.status !== "awaiting_approval") return;
    busy = true; setButtons(); clearTimeout(timer);
    try {
      await request("/" + decision, { manifestHash: snapshot.manifestHash, nonce: snapshot.nonce });
      await refresh();
    } catch (error) {
      status.textContent = error.message;
      // Never automatically retry an approval after an uncertain network result.
    }
  };
  approve.addEventListener("click", () => decide("approve"));
  reject.addEventListener("click", () => decide("reject"));
  if (!id || !token) status.textContent = "Open the complete review link provided for this operation.";
  else void poll();
})();`;

