# WatWorks extension (public mirror)

The extension opens the hosted WatWorks workspace; there is no local agent workflow.
Never add code that approves WaterlooWorks writes on the user's behalf: every upload and
submission needs the user's own click in the workspace.

Prefer focused files with one or two responsibilities. Run `bun run typecheck`,
`bun test`, and `bun run build:extension` after relevant changes. Reload the
installed extension in `chrome://extensions` before claiming changes are active.
Never log or persist WaterlooWorks cookies. Session transfer goes directly from
the extension to the hosted service. Never retry a mutation automatically.

This is a generated one-way mirror. Submit changes through the upstream maintainer.
