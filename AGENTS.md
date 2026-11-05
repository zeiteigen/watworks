# Public local workspace

Use the skills in `.agents/skills/` for onboarding and application preparation.
Personal data lives in `data/` and must be written through workspace MCP tools.
Agents must never approve operations, open the extension dashboard, call its
approval routes, or operate its approval controls. Return the dashboard URL for
the user to review and approve.

Prefer focused files with one or two responsibilities. Run `bun run typecheck`,
`bun test`, and `bun run build:extension` after relevant changes. Reload the
installed extension through Chrome DevTools MCP and check `waterlooworks_status`
before claiming changes are active; report when those tools are unavailable.
Restart changed local services without interrupting active applications.
Never log or persist WaterlooWorks cookies. Session transfer goes directly from
the extension to the configured submission service. Never retry a mutation
automatically.

This is a generated one-way mirror. Submit changes through the upstream maintainer.
