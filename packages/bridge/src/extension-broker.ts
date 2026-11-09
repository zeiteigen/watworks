import { randomUUID } from "node:crypto";
import { applicationProgressSchema } from "../../shared/src/application-progress.js";
import type { ServerWebSocket } from "bun";
import { effectiveCommand, EXTENSION_METHODS, EXPECTED_EXTENSION_ID, extensionHelloSchema, extensionProgressSchema, extensionResultSchema, isBoundedExtensionValue, localCommandSchema, MUTATING_METHODS, validateExtensionArgs, type ExtensionMethod } from "../../shared/src/extension-protocol.js";
import { encodeOperationFailure } from "../../shared/src/operation-failure.js";
import type { ApplicationProgress } from "../../shared/src/application-progress.js";
import { COMMAND_STREAM_TYPE, commandStream } from "../../shared/src/command-stream.js";

const MAX_MESSAGE_BYTES = 48 * 1024 * 1024;
const MAX_PENDING = 32;
const READ_DEADLINE_MS = 30_000;
const WRITE_DEADLINE_MS = 180_000;
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; method: ExtensionMethod; onProgress?: (progress: ApplicationProgress) => void; allowProgress: boolean };
type SocketData = { hello: boolean; capabilities: string[]; helloTimer?: ReturnType<typeof setTimeout> };

export class ExtensionBroker {
  private socket: ServerWebSocket<SocketData> | undefined;
  private pendingSocket: ServerWebSocket<SocketData> | undefined;
  private readonly pending = new Map<string, Pending>();
  connected(): boolean { return this.socket !== undefined; }
  accept(socket: ServerWebSocket<SocketData>): boolean {
    if (this.socket || this.pendingSocket) return false;
    this.pendingSocket = socket;
    const timer = setTimeout(() => { if (!socket.data.hello) socket.close(1008, "hello timeout"); }, 3000);
    (socket.data as SocketData & { helloTimer?: ReturnType<typeof setTimeout> }).helloTimer = timer;
    return true;
  }
  message(socket: ServerWebSocket<SocketData>, raw: string | Buffer): void {
    if (Buffer.byteLength(raw) > MAX_MESSAGE_BYTES) { socket.close(1009, "message too large"); return; }
    let input: unknown;
    try { input = JSON.parse(String(raw)); } catch { socket.close(1007, "invalid JSON"); return; }
    if (!socket.data.hello) {
      const parsed = extensionHelloSchema.safeParse(input);
      if (!parsed.success) { socket.close(1008, "invalid hello"); return; }
      socket.data.hello = true;
      clearTimeout(socket.data.helloTimer);
      socket.data.capabilities = parsed.data.capabilities;
      this.socket = socket;
      this.pendingSocket = undefined;
      return;
    }
    const progressMessage = input;
    if (progressMessage && typeof progressMessage === "object" && (progressMessage as {type?: unknown}).type === "progress") {
      const progress = extensionProgressSchema.safeParse(progressMessage);
      if (!progress.success) { socket.close(1008, "invalid progress"); return; }
      const job = this.pending.get(progress.data.requestId);
      if (!job) return;
      if (!job.allowProgress) { socket.close(1008, "progress not allowed"); return; }
      try{job.onProgress?.(progress.data.progress);}catch{/* Display observers cannot interrupt a command. */}
      return;
    }
    const parsed = extensionResultSchema.safeParse(input);
    if (!parsed.success || (parsed.data.result !== undefined && !isBoundedExtensionValue(parsed.data.result))) { socket.close(1008, "invalid result"); return; }
    const job = this.pending.get(parsed.data.requestId);
    if (!job) return;
    if (parsed.data.error === undefined && !isNormalizedResult(job.method, parsed.data.result)) {
      socket.close(1008, `invalid ${job.method} result`);
      return;
    }
    clearTimeout(job.timer); this.pending.delete(parsed.data.requestId);
    if (parsed.data.error !== undefined) job.reject(new Error(parsed.data.error)); else job.resolve(parsed.data.result);
  }
  disconnected(socket: ServerWebSocket<SocketData>): void {
    clearTimeout(socket.data.helloTimer);
    if (this.pendingSocket === socket) this.pendingSocket = undefined;
    if (this.socket !== socket) return;
    this.socket = undefined;
    for (const [id, job] of this.pending) { clearTimeout(job.timer); job.reject(new Error("Extension disconnected; request outcome is unknown")); this.pending.delete(id); }
  }
  shutdown(reason = "Extension bridge stopped"): void {
    const active = this.socket;
    const pending = this.pendingSocket;
    this.socket = undefined;
    this.pendingSocket = undefined;
    if (pending) { clearTimeout(pending.data.helloTimer); pending.close(1001, reason); }
    if (active) active.close(1001, reason);
    for (const [id, job] of this.pending) {
      clearTimeout(job.timer);
      job.reject(new Error(reason));
      this.pending.delete(id);
    }
  }
  request(method: ExtensionMethod, args: unknown[], onProgress?: (progress: ApplicationProgress) => void, approval?: string): Promise<unknown> {
    if (!validateExtensionArgs(method, args)) return Promise.reject(new Error(`Invalid arguments for ${method}`));
    if (!this.socket) return Promise.reject(new Error("WaterlooWorks extension is not connected"));
    if (!this.socket.data.capabilities.includes(method)) return Promise.reject(new Error(`Extension does not support ${method}`));
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new Error("Extension request capacity reached"));
    const socket = this.socket;
    const requestId = randomUUID();
    const timeoutMs = (method === "getOperationProgress" || (method === "submissionCommand" && args[1] === "getOperationProgress")) ? 1500 : ["submissionCommand", "uploadDocument", "stageAttachments", "submitApplication", "fillApplication", "setDefaultDocuments", "discoveryPolicySave"].includes(method) ? WRITE_DEADLINE_MS : READ_DEADLINE_MS;
    const streamProgress=Boolean(onProgress && socket.data.capabilities.includes("commandProgress"));
    const command = { type: "command", requestId, method, args, deadline: Date.now() + timeoutMs,...(streamProgress?{streamProgress:true}:{}),...(approval?{approval}:{}) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error("Extension request timed out; request outcome is unknown")); }, timeoutMs);
      const progressTarget = method === "submissionCommand" ? args[1] : method;
      const allowProgress = streamProgress && ["uploadDocument", "stageAttachments", "submitApplication", "fillApplication"].includes(String(progressTarget));
      this.pending.set(requestId, { resolve, reject, timer, method, ...(onProgress ? {onProgress} : {}), allowProgress });
      try { socket.send(JSON.stringify(command)); } catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error instanceof Error ? error : new Error("Extension send failed")); }
    });
  }
}

export function createExtensionBridgeServer(port = 39_451) {
  const broker = new ExtensionBroker();
  const server = Bun.serve<SocketData>({ hostname: "127.0.0.1", port, maxRequestBodySize: MAX_MESSAGE_BYTES, idleTimeout: 255,
    fetch(req, server) {
      const url = new URL(req.url);
      const expectedHost = `127.0.0.1:${server.port}`;
      if (req.headers.get("host") !== expectedHost || url.hostname !== "127.0.0.1" || url.port !== String(server.port)) return new Response("forbidden", { status: 403 });
      if (url.pathname === "/extension") {
        const origin = req.headers.get("origin");
        if (origin !== `chrome-extension://${EXPECTED_EXTENSION_ID}`) return new Response("forbidden", { status: 403 });
        if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
        if (!server.upgrade(req, { data: { hello: false, capabilities: [] } })) return new Response("upgrade failed", { status: 400 });
        return undefined;
      }
      if (url.pathname === "/health" && req.method === "GET") return Response.json({ service: "waterlooworks-extension-bridge", bridgeConnected: broker.connected() });
      if (url.pathname === "/" && req.method === "GET") return Response.json({ service: "waterlooworks-extension-bridge" });
      if (url.pathname === "/command" && req.method === "POST") {
        if (req.headers.has("origin")) return new Response("origin not allowed", { status: 403 });
        if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return new Response("content type required", { status: 415 });
        const declaredLength = req.headers.get("content-length");
        if (declaredLength !== null && Number(declaredLength) > MAX_MESSAGE_BYTES) return new Response("request too large", { status: 413 });
        return (async () => {
          const text = await req.text();
          if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) return new Response("request too large", { status: 413 });
          let body: unknown; try { body = JSON.parse(text); } catch { return new Response("invalid JSON", { status: 400 }); }
          const parsed = localCommandSchema.safeParse(body);
          if (!parsed.success || !EXTENSION_METHODS.includes(parsed.data.method) || !validateExtensionArgs(parsed.data.method, parsed.data.args)) return new Response("invalid command", { status: 400 });
          // The extension is the authority; this refuses unapproved writes before they reach it.
          if (MUTATING_METHODS.has(effectiveCommand(parsed.data.method, parsed.data.args).method) && !parsed.data.approval) return Response.json({ error: encodeOperationFailure({ phase: "preflight", code: "no_remote_mutation", message: "This write needs an approval from the extension dashboard" }) }, { status: 403 });
          const streaming = req.headers.get("accept")?.toLowerCase().split(",").some(value => value.trim().split(";", 1)[0] === COMMAND_STREAM_TYPE) ?? false;
          if (streaming) {
            let emit: ((progress: ApplicationProgress) => void) | undefined;
            const response = commandStream(async () => {
              try {
                const result = await broker.request(parsed.data.method, parsed.data.args, progress => emit?.(progress), parsed.data.approval);
                if (result === undefined && parsed.data.method !== "bootstrap") throw new Error("Extension returned no result");
                return JSON.stringify({ result: result ?? null });
              } catch (error) { return JSON.stringify({ error: (error instanceof Error ? error.message : "extension request failed").slice(0, 1000) }); }
            }, subscribe => { emit = subscribe; return () => { emit = undefined; }; }, req.signal);
            return new Response(response.body, { status: 200, headers: { "content-type": `${COMMAND_STREAM_TYPE}; charset=utf-8`, "cache-control": "no-store", "x-content-type-options": "nosniff", "x-accel-buffering":"no" } });
          }
          try {
            const result = await broker.request(parsed.data.method, parsed.data.args, undefined, parsed.data.approval);
            if (result === undefined && parsed.data.method !== "bootstrap") throw new Error("Extension returned no result");
            return Response.json({ result: result ?? null });
          }
          catch (error) { return Response.json({ error: (error instanceof Error ? error.message : "extension request failed").slice(0, 1000) }, { status: 503 }); }
        })();
      }
      return new Response("not found", { status: 404 });
    },
    websocket: { maxPayloadLength: MAX_MESSAGE_BYTES, open(ws) { if (!broker.accept(ws)) ws.close(1013, "connection already active"); }, message(ws, message) { broker.message(ws, message as string | Buffer); }, close(ws) { broker.disconnected(ws); } },
  });
  return { server, broker, stop: () => { broker.shutdown(); return server.stop(true); } };
}

function isHealthResult(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const health = value as Record<string, unknown>;
  return typeof health.authenticated === "boolean" && typeof health.bridgeConnected === "boolean" && typeof health.bootstrapped === "boolean" && (health.error === undefined || typeof health.error === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNormalizedResult(method: ExtensionMethod, value: unknown): boolean {
  if (method === "getOperationProgress") return applicationProgressSchema.nullable().safeParse(value).success;
  if (method === "bootstrap") return value === null;
  if (method === "health") return isHealthResult(value);
  if (method === "searchJobs") return isRecord(value) && Array.isArray(value.items) && typeof value.total === "number" && Number.isFinite(value.total);
  if (method === "getJob") return isRecord(value) && typeof value.id === "string";
  if (method === "getSearchMetadata") return isRecord(value) && Array.isArray(value.columns) && Array.isArray(value.sort) && Array.isArray(value.filters) && Array.isArray(value.savedFilters);
  if (method === "getAccountOverview") return isRecord(value) && Array.isArray(value.folders) && isRecord(value.folderCounts) && Array.isArray(value.blacklistedPostings);
  if (method === "getDocumentMetadata") return isRecord(value) && isRecord(value.docTypes) && isRecord(value.defaultDocMap) && isRecord(value.specialDocs);
  if (method === "getEmployerReport") return isRecord(value);
  return value !== undefined;
}
