import { describe, expect, test } from "bun:test";
import { createDashboardRequest, createWriteApprovalMinter, WORKSPACE_OFFLINE, WORKSPACE_SERVICE } from "./dashboard-api.js";

describe("extension dashboard data", () => {
  test("write approvals come from the background worker and surface its refusal", async () => {
    const messages: Record<string, unknown>[] = [];
    const mint = createWriteApprovalMinter(async message => { messages.push(message); return { ok: true, value: { token: "minted" } }; });
    expect(await mint("apply", "waterlooworks:123")).toBe("minted");
    expect(messages).toEqual([{ type: "mintWriteApproval", action: "apply", target: "waterlooworks:123" }]);
    await expect(createWriteApprovalMinter(async () => ({ ok: false, error: "Refused" }))("apply", "x")).rejects.toThrow("Refused");
  });

  test("prepares the submission session through the native extension route", async () => {
    const messages: Record<string, unknown>[] = [];
    const api = createDashboardRequest(async message => {
      messages.push(message);
      return { ok: true, value: { authenticated: true } };
    }, (() => { throw Error("Must not contact localhost"); }) as unknown as typeof fetch);
    expect(await api("/api/submission/prepare", {})).toEqual({ authenticated: true });
    expect(messages).toEqual([{ type: "prepareSubmissionSession" }]);
  });

  test("opens manual postings through the extension without contacting the workspace service", async () => {
    const messages: Record<string, unknown>[] = [];
    const api = createDashboardRequest(async message => {
      messages.push(message);
      return { ok: true, value: { jobId: "123", tabId: 7 } };
    }, (() => { throw Error("Must not contact localhost"); }) as unknown as typeof fetch);
    expect(await api("/api/jobs/waterlooworks/123/open-application-form", {})).toEqual({ jobId: "123", tabId: 7 });
    expect(messages).toEqual([{ type: "openApplicationForm", jobId: "123" }]);
  });

  test("discovery, settings, and applications work with no local service", async () => {
    const messages: Record<string, unknown>[] = [];
    const api = createDashboardRequest(async message => {
      messages.push(message);
      return { ok: true, value: message.type === "discoveriesList" ? [{ id: "123" }] : { enabled: true } };
    }, (() => { throw Error("Must not contact localhost"); }) as unknown as unknown as typeof fetch);
    expect(await api("/api/discoveries")).toEqual({ discoveries: [{ id: "123" }] });
    expect(await api("/api/discovery-policy")).toEqual({ policy: { enabled: true } });
    await api("/api/discovery-policy", { policy: { enabled: false } });
    await api("/api/applications");
    expect(messages.map(message => message.type)).toEqual(["discoveriesList", "discoveryPolicyGet", "discoveryPolicySave", "listApplications"]);
    expect(messages[2]!.policy).toEqual({ enabled: false });
  });

  test("offline state is explicit and writes are never accepted or replayed", async () => {
    let attempts = 0;
    const api = createDashboardRequest(async () => ({ ok: true, value: { authenticated: true } }), (async () => {
      attempts++;
      throw new TypeError("Connection refused");
    }) as unknown as typeof fetch);
    expect(await api("/api/state")).toMatchObject({ workspaceOffline: true, jobs: [], health: { authenticated: true } });
    await expect(api("/api/jobs/waterlooworks/123/apply", { approvalHash: "hash" })).rejects.toThrow(WORKSPACE_OFFLINE);
    expect(attempts).toBe(2);
  });

  test("sends review hashes and reads PDF bytes through the workspace API", async () => {
    const requests: Array<{ url: unknown; init: RequestInit | undefined }> = [];
    const api = createDashboardRequest(async () => ({ ok: true }), (async (url: unknown, init?: RequestInit) => {
      requests.push({ url, init });
      return String(url).endsWith("/resume") ? new Response("pdf", { headers: { "content-type": "application/pdf" } }) : Response.json({ queued: true });
    }) as unknown as typeof fetch);
    expect(await api("/api/jobs/waterlooworks/123/apply", { approvalHash: "reviewed" })).toEqual({ queued: true });
    expect(requests[0]).toMatchObject({ url: WORKSPACE_SERVICE + "/api/jobs/waterlooworks/123/apply", init: { method: "POST", body: '{"approvalHash":"reviewed"}', credentials: "omit" } });
    const pdf = await api("/api/jobs/waterlooworks/123/files/resume");
    expect(await pdf.text()).toBe("pdf");
  });
});
