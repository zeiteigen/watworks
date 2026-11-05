/** Extension-owned data works without the workspace process. Disk-backed data uses its API. */
export const WORKSPACE_SERVICE = "http://127.0.0.1:39452";
export const WORKSPACE_OFFLINE = "Workspace service is offline. Click Start workspace service to access saved applications and PDFs.";

type Send = (message: Record<string, unknown>) => Promise<{ ok: boolean; value?: any; error?: string }>;

export function createDashboardRequest(send: Send, request: (url: string, init?: RequestInit) => Promise<Response> = fetch) {
  const native = async (type: string, extra = {}) => {
    const reply = await send({ type, ...extra });
    if (!reply?.ok) throw new Error(reply?.error ?? "Extension request failed");
    return reply.value;
  };
  return async (path: string, body?: Record<string, unknown>): Promise<any> => {
    if(path === "/api/submission/prepare" && body)return native("prepareSubmissionSession");
    const posting = /^\/api\/jobs\/waterlooworks\/(\d+)\/open-application-form$/.exec(path);
    if (posting && body) return native("openApplicationForm", { jobId: posting[1] });
    if (path === "/api/discovery-status" && !body) return native("discoveryStatus");
    if (path === "/api/discoveries" && !body) return { discoveries: await native("discoveriesList") };
    if (path === "/api/discovery-policy") return { policy: await native(body ? "discoveryPolicySave" : "discoveryPolicyGet", body ? { policy: body.policy } : {}) };
    if (path === "/api/applications" && !body) return native("listApplications");
    if (!path.startsWith("/api/") || path.includes("..") || path.includes("\\")) throw new Error("Invalid workspace path");
    let response: Response;
    try {
      response = await request(WORKSPACE_SERVICE + path, {
        method: body ? "POST" : "GET",
        headers: body ? { "Content-Type": "application/json" } : {},
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10_000),
        credentials: "omit",
      });
    } catch {
      if (path !== "/api/state" || body) throw new Error(WORKSPACE_OFFLINE);
      const health = await native("status").catch(() => ({ authenticated: false }));
      return { jobs: [], profile: null, workspaceOffline: true, health: { ...health, bridgeConnected: true } };
    }
    if (response.headers.get("content-type")?.startsWith("application/pdf") && response.ok) return response.blob();
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Workspace request refused");
    return data;
  };
}
