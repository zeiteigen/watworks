# Connect a submission service

The local workspace and Chrome extension prepare applications. Execution-time
validation, uploads, submission, and scheduled discovery use an external service.
Its implementation and deployment configuration are maintained separately.

The extension defaults to `https://watworks.alishahzad.dev`. Hosted submissions
and discovery require Insider access. Open **Submission server** in extension
settings to configure another trusted endpoint when supported by your account.
Ask the service operator for its endpoint and any required authorization headers.

On execution or discovery demand, the extension transfers the signed-in
WaterlooWorks session directly to the configured service. Credentials do not
pass through the local broker, dashboard, or agent. Only configure an endpoint
you trust with your session. Sessions remain in server memory.

Review documents and answers in the dashboard and approve each application
there. A service that supports **Fill form only** can leave final submission to
you. An uncertain write must be reconciled through the dashboard; it is never
automatically retried.
