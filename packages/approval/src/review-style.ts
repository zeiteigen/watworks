export const REVIEW_STYLE = `
:root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.55; color: #203044; background: #f1f4f8; }
* { box-sizing: border-box; }
body { margin: 0; padding: 32px 20px 60px; }
main { max-width: 860px; margin: 0 auto; }
h1 { font-size: 2rem; line-height: 1.2; margin: 8px 0 16px; }
h2 { font-size: 1.2rem; margin: 0 0 16px; }
h3 { font-size: 1rem; margin: 0 0 10px; }
p { margin: 8px 0; }
.eyebrow { font-weight: 650; letter-spacing: .04em; color: #476080; font-size: .85rem; }
.review-state { margin: 24px 0; border-left: 4px solid #3266a8; padding: 8px 20px; }
#status { font-weight: 700; }
#expiry { font-size: .9rem; }
section, details { border: 1px solid #dce3ec; border-radius: 12px; background: #fff; margin: 20px 0; padding: 24px; }
.notice { border: 2px solid #a5680b; background: #fff5dc; }
dl { margin: 0; }
dt { font-weight: 650; margin-top: 14px; }
dt:first-child { margin-top: 0; }
dd { margin: 3px 0 0; overflow-wrap: anywhere; white-space: pre-wrap; }
dd dl { border-left: 2px solid #dce3ec; padding-left: 16px; }
.document { border-top: 1px solid #dce3ec; padding: 18px 0; }
.document:first-of-type { border-top: 0; padding-top: 0; }
.document:last-child { padding-bottom: 0; }
ul { padding-left: 24px; }
li { margin: 6px 0; overflow-wrap: anywhere; }
.buttons { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 20px; }
button { border: 1px solid #235a9d; border-radius: 8px; padding: 12px 20px; background: #235a9d; color: white; font: inherit; font-weight: 650; cursor: pointer; }
button.secondary { color: #203044; border-color: #a1afbf; background: transparent; }
button:disabled { opacity: .55; cursor: default; }
button:focus-visible, summary:focus-visible { outline: 3px solid #e1a134; outline-offset: 3px; }
summary { cursor: pointer; font-weight: 600; }
pre, code { white-space: pre-wrap; overflow-wrap: anywhere; font-size: .85rem; }
details { font-size: .9rem; color: #526078; }
[hidden] { display: none !important; }
@media (prefers-color-scheme: dark) {
  :root { color: #e3eaf4; background: #141b25; }
  section, details { background: #202b3a; border-color: #3a495e; }
  .eyebrow, details { color: #adc2dd; }
  .notice { background: #3d301a; border-color: #bb8b3b; }
  .document, dd dl { border-color: #3a495e; }
  button.secondary { color: #e3eaf4; }
}
@media (max-width: 560px) { body { padding: 20px 12px; } section, details { padding: 20px; } h1 { font-size: 1.7rem; } }
`;
