export const REVIEW_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Review WaterlooWorks action</title><link rel="stylesheet" href="/review.css"><script src="/review.js" defer></script></head>
<body><main><header><p class="eyebrow">WaterlooWorks · Action review</p><h1 id="title">Review WaterlooWorks action</h1>
<p>Check the details below. Approving authorizes this exact action once.</p></header>
<div class="review-state"><p id="status" role="status" aria-live="polite">Loading review…</p><p id="expiry"></p></div>
<div id="review-content"></div>
<section id="document-downloads" hidden></section>
<section class="decision"><h2>Your decision</h2><p>Approve only when all the details above are correct.</p>
<div class="buttons"><button id="approve" type="button" disabled>Approve and submit</button><button id="reject" class="secondary" type="button" disabled>Reject</button></div></section>
<section id="result-section" hidden><h2>Result</h2><pre id="result"></pre></section>
<details><summary>Technical review details</summary><p>Manifest SHA-256: <code id="hash"></code></p><pre id="manifest"></pre></details>
</main></body></html>`;
