/** Static markup shared by extension options and dashboard settings. */
export const SUBMISSION_SETTINGS_MARKUP = `<h2>WatWorks connection</h2><p>WatWorks hosts your approved WaterlooWorks submissions and daily Discoveries. Your WaterlooWorks session syncs automatically when needed.</p>
<fieldset id="submission-developer" hidden><legend>Developer mode</legend><p>Override the hosted server for development or self-hosting. Saving changes reconnects your session when needed.</p>
<label for="submission-endpoint">Endpoint URL</label><input id="submission-endpoint" type="url" placeholder="http://127.0.0.1:39453" autocomplete="off" spellcheck="false"><small>Use HTTPS for a remote server, or HTTP on loopback for a local server.</small>
<label for="submission-headers">Proxy headers (JSON)</label><textarea id="submission-headers" rows="5" autocomplete="off" spellcheck="false">{}</textarea><small>Optional credentials for your HTTPS proxy. The proxy determines your user identity; a user-routing header cannot be configured here.</small>
<div><button id="submission-save">Save endpoint</button><button id="submission-default">Use Cloudflare default</button><button id="submission-hide-developer">Hide developer settings</button></div></fieldset>
<button id="submission-test">Check connection</button>
<h3>WaterlooWorks session</h3><p>WaterlooWorks cookies and your browser user agent sync automatically to the saved endpoint when needed. Only configure a server you trust.</p><p id="submission-destination"></p>
<p id="submission-account-status" role="status" aria-live="polite"></p><p id="submission-status" role="status" aria-live="polite"></p>`;
