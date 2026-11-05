import { EXTENSION_METHODS, EXTENSION_PROTOCOL_VERSION, extensionCommandSchema } from "../../shared/src/extension-protocol.js";
import { DEFAULT_BRIDGE_BASE_URL } from "../../shared/src/protocol.js";
import { methods, executeCommand } from "./commands.js";
import { wireDecode, wireEncode, publicResult } from "./wire.js";
import { BrowserOperationError, encodeOperationFailure } from "../../shared/src/operation-failure.js";

let socket: WebSocket | undefined;
let keepalive: ReturnType<typeof setInterval> | undefined;
const received = new Set<string>();

export function serviceConnected(): boolean {
  return socket?.readyState === WebSocket.OPEN;
}

export function connect(): void {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const ws = new WebSocket(`${DEFAULT_BRIDGE_BASE_URL.replace(/^http/, "ws")}/extension`);
  socket = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: "hello",
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      extensionVersion: chrome.runtime.getManifest().version,
      capabilities: [...EXTENSION_METHODS.filter(method => method in methods),"commandProgress"],
    }));
    clearInterval(keepalive);
    keepalive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "result", requestId: crypto.randomUUID(), result: null }));
    }, 20_000);
  };
  ws.onmessage = event => {
    void (async () => {
      let message: unknown;
      try { message = wireDecode(JSON.parse(String(event.data))); } catch { return; }
      const parsed = extensionCommandSchema.safeParse(message);
      if (!parsed.success) { ws.close(1008, "Invalid command"); return; }
      const command = parsed.data;
      try {
        if (command.deadline <= Date.now()) throw new Error("Extension command expired");
        const method = methods[command.method];
        if (!method) throw new Error("Extension capability is unsupported");
        if (received.has(command.requestId)) throw new Error("Duplicate extension command");
        received.add(command.requestId);
        if (received.size > 512) received.delete(received.values().next().value!);
        if (["uploadDocument","stageAttachments","submitApplication","fillApplication"].includes(command.method)) {
          const reservation = `rpc:${command.requestId}`;
          if ((await chrome.storage.session.get(reservation))[reservation]) throw new Error("Duplicate command; never replay an application");
          await chrome.storage.session.set({ [reservation]: true });
        }
        const result = publicResult(await executeCommand(command.method, command.args, command.deadline, command.streamProgress?progress=>{
          if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:"progress",requestId:command.requestId,progress}));
        }:undefined)) ?? null;
        if (ws.readyState === WebSocket.OPEN) ws.send(wireEncode({ type: "result", requestId: command.requestId, result }));
      } catch (error) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "result", requestId: command.requestId, error: (error instanceof BrowserOperationError ? encodeOperationFailure(error.failure) : error instanceof Error ? error.message : "Extension operation failed").slice(0, 1000) }));
      }
    })();
  };
  ws.onclose = () => {
    if (socket === ws) {
      socket = undefined;
      clearInterval(keepalive);
      keepalive = undefined;
    }
  };
  ws.onerror = () => ws.close();
}
