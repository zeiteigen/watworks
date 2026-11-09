import { describe, expect, test } from "bun:test";
import { createExtensionBridgeServer } from "./extension-broker.js";
import { EXPECTED_EXTENSION_ID } from "../../shared/src/extension-protocol.js";
import { readCommandStream } from "../../shared/src/command-stream.js";
import { decodeOperationFailure } from "../../shared/src/operation-failure.js";

const CLICK = "c".repeat(43);
const uploadArgs = () => ["67", "file.pdf", {filename:"file.pdf",size:1,sha256:"fixture"}, "account", crypto.randomUUID()];

describe("extension command broker", () => {
  test("progress is a bounded read command with validated operation identity and enum-only results", async () => {
    const app = createExtensionBridgeServer(0);
    const root = `http://127.0.0.1:${app.server.port}`;
    const socket = new WebSocket(root.replace("http", "ws") + "/extension", {headers:{origin:`chrome-extension://${EXPECTED_EXTENSION_ID}`}} as any);
    try {
      await new Promise<void>((resolve,reject)=>{socket.onopen=()=>resolve();socket.onerror=()=>reject(new Error("socket failed"));});
      socket.send(JSON.stringify({type:"hello",protocolVersion:1,extensionVersion:"1",capabilities:["getOperationProgress"]}));
      await Bun.sleep(10);
      const operationId = crypto.randomUUID();
      socket.onmessage = event => {
        const command = JSON.parse(String(event.data));
        expect(command.method).toBe("getOperationProgress");
        expect(command.args).toEqual([operationId]);
        socket.send(JSON.stringify({type:"result",requestId:command.requestId,result:{phase:"uploading_document",document:"cover_letter"}}));
      };
      expect(await app.broker.request("getOperationProgress",[operationId])).toEqual({phase:"uploading_document",document:"cover_letter"});
      await expect(app.broker.request("getOperationProgress",["bad-id"])).rejects.toThrow("Invalid arguments");
      socket.onmessage = event => socket.send(JSON.stringify({type:"result",requestId:JSON.parse(String(event.data)).requestId,result:{phase:"raw-page-content"}}));
      await expect(app.broker.request("getOperationProgress",[operationId])).rejects.toThrow("disconnected");
    } finally {socket.close();app.stop();}
  });
  test("forwards validated progress before the terminal mutation result", async () => {
    const app = createExtensionBridgeServer(0);
    const root = `http://127.0.0.1:${app.server.port}`;
    const socket = new WebSocket(root.replace("http", "ws") + "/extension", {headers:{origin:`chrome-extension://${EXPECTED_EXTENSION_ID}`}} as any);
    try {
      await new Promise<void>((resolve,reject)=>{socket.onopen=()=>resolve();socket.onerror=()=>reject(new Error("socket failed"));});
      socket.send(JSON.stringify({type:"hello",protocolVersion:1,extensionVersion:"1",capabilities:["uploadDocument","commandProgress"]}));
      await Bun.sleep(10);
      const received: unknown[] = [];
      const response = app.broker.request("uploadDocument", uploadArgs(), progress => received.push(progress));
      const command = await new Promise<Record<string, unknown>>(resolve => { socket.onmessage = event => resolve(JSON.parse(String(event.data))); });
      socket.send(JSON.stringify({type:"progress",requestId:command.requestId,progress:{phase:"uploading_document",document:"resume"}}));
      await Bun.sleep(10);
      expect(received).toEqual([{phase:"uploading_document",document:"resume"}]);
      socket.send(JSON.stringify({type:"result",requestId:command.requestId,result:{documentId:"123"}}));
      expect(await response).toEqual({documentId:"123"});
    } finally { socket.close(); app.stop(); }
  });
  test("refuses valid progress for a nonmutation pending request", async () => {
    const app = createExtensionBridgeServer(0);
    const root = `http://127.0.0.1:${app.server.port}`;
    const socket = new WebSocket(root.replace("http", "ws") + "/extension", {headers:{origin:`chrome-extension://${EXPECTED_EXTENSION_ID}`}} as any);
    try {
      await new Promise<void>((resolve,reject)=>{socket.onopen=()=>resolve();socket.onerror=()=>reject(new Error("socket failed"));});
      socket.send(JSON.stringify({type:"hello",protocolVersion:1,extensionVersion:"1",capabilities:["getJob","commandProgress"]}));
      await Bun.sleep(10);
      const pending = app.broker.request("getJob", ["123", {}], () => {});
      const command = await new Promise<Record<string, unknown>>(resolve => { socket.onmessage = event => resolve(JSON.parse(String(event.data))); });
      socket.send(JSON.stringify({type:"progress",requestId:command.requestId,progress:{phase:"checking_form"}}));
      await expect(pending).rejects.toThrow("disconnected");
    } finally { socket.close(); app.stop(); }
  });
  test("closes the extension socket on a malformed progress message", async () => {
    const app = createExtensionBridgeServer(0);
    const root = `http://127.0.0.1:${app.server.port}`;
    const socket = new WebSocket(root.replace("http", "ws") + "/extension", {headers:{origin:`chrome-extension://${EXPECTED_EXTENSION_ID}`}} as any);
    try {
      await new Promise<void>((resolve,reject)=>{socket.onopen=()=>resolve();socket.onerror=()=>reject(new Error("socket failed"));});
      socket.send(JSON.stringify({type:"hello",protocolVersion:1,extensionVersion:"1",capabilities:["uploadDocument","commandProgress"]}));
      await Bun.sleep(10);
      const pending = app.broker.request("uploadDocument", uploadArgs(), () => {});
      const command = await new Promise<Record<string, unknown>>(resolve => {socket.onmessage=event=>resolve(JSON.parse(String(event.data)));});
      socket.send(JSON.stringify({type:"progress",requestId:command.requestId,progress:{phase:"raw-page-content"}}));
      await expect(pending).rejects.toThrow("disconnected");
    } finally {socket.close();app.stop();}
  });
  test("rejects a foreign origin and reports extension connection state", async () => {
    const app = createExtensionBridgeServer(0);
    try {
      const root = `http://127.0.0.1:${app.server.port}`;
      expect((await fetch(`${root}/extension`, { headers: { origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } })).status).toBe(403);
      expect((await fetch(`${root}/health`, { headers: { host: `localhost:${app.server.port}` } })).status).toBe(403);
      expect(await (await fetch(`${root}/health`)).json()).toEqual({ service: "waterlooworks-extension-bridge", bridgeConnected: false });
      const socket = new WebSocket(root.replace("http", "ws") + "/extension", { headers: { origin: `chrome-extension://${EXPECTED_EXTENSION_ID}` } } as any);
      await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("socket failed")); });
      socket.send(JSON.stringify({ type: "hello", protocolVersion: 1, extensionVersion: "1", capabilities: ["searchJobs", "getJob"] }));
      await Bun.sleep(10);
      expect((await (await fetch(`${root}/health`)).json() as { bridgeConnected: boolean }).bridgeConnected).toBe(true);
      socket.close();
    } finally { app.stop(); }
  });

  test("dispatches validated commands and fails them after disconnect without replay", async () => {
    const app = createExtensionBridgeServer(0);
    try {
      const root = `http://127.0.0.1:${app.server.port}`;
      const socket = new WebSocket(root.replace("http", "ws") + "/extension", { headers: { origin: `chrome-extension://${EXPECTED_EXTENSION_ID}` } } as any);
      await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("socket failed")); });
      socket.send(JSON.stringify({ type: "hello", protocolVersion: 1, extensionVersion: "1", capabilities: ["searchJobs", "getJob"] }));
      const resultPromise = fetch(`${root}/command`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "searchJobs", args: [{ keyword: "test" }] }) });
      const message = await new Promise<Record<string, unknown>>((resolve) => { socket.onmessage = event => resolve(JSON.parse(String(event.data))); });
      expect(message.method).toBe("searchJobs");
      socket.send(JSON.stringify({ type: "result", requestId: message.requestId, result: { items: [], total: 0 } }));
      expect((await resultPromise).status).toBe(200);
      const pending = fetch(`${root}/command`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "getJob", args: ["123", {}] }) });
      await new Promise<void>(resolve => { socket.onmessage = () => { socket.close(); resolve(); }; });
      expect((await pending).status).toBe(503);
      expect((await fetch(`${root}/command`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "notAllowed", args: [] }) })).status).toBe(400);
      expect((await fetch(`${root}/command`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "getJob", args: [{ id: "123" }] }) })).status).toBe(400);
    } finally { app.stop(); }
  });

  test("streams progress before its terminal result while ordinary callers retain JSON", async () => {
    const app = createExtensionBridgeServer(0);
    const root = `http://127.0.0.1:${app.server.port}`;
    const socket = new WebSocket(root.replace("http", "ws") + "/extension", {headers:{origin:`chrome-extension://${EXPECTED_EXTENSION_ID}`}} as any);
    try {
      await new Promise<void>((resolve,reject)=>{socket.onopen=()=>resolve();socket.onerror=()=>reject(new Error("socket failed"));});
      socket.send(JSON.stringify({type:"hello",protocolVersion:1,extensionVersion:"1",capabilities:["uploadDocument","getJob","commandProgress"]}));
      await Bun.sleep(10);
      const responsePromise = fetch(`${root}/command`, {method:"POST",headers:{"content-type":"application/json",accept:"application/x-ndjson"},body:JSON.stringify({method:"uploadDocument",args:uploadArgs(),approval:CLICK})});
      const command = await new Promise<Record<string, unknown>>(resolve => {socket.onmessage=event=>resolve(JSON.parse(String(event.data)));});
      const response = await responsePromise;
      expect(response.headers.get("content-type")).toContain("application/x-ndjson");
      const progressFrames: unknown[] = [];
      let observeProgress!: () => void;
      const sawProgress = new Promise<void>(resolve => { observeProgress = resolve; });
      const terminal = readCommandStream(response, progress => { progressFrames.push(progress); observeProgress(); });
      socket.send(JSON.stringify({type:"progress",requestId:command.requestId,progress:{phase:"uploading_document",document:"resume"}}));
      await sawProgress;
      expect(progressFrames).toEqual([{phase:"uploading_document",document:"resume"}]);
      socket.send(JSON.stringify({type:"result",requestId:command.requestId,result:{documentId:"123"}}));
      expect(await terminal).toEqual({result:{documentId:"123"}});

      const jsonPromise = fetch(`${root}/command`, {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({method:"getJob",args:["123",{}]})});
      const jsonCommand = await new Promise<Record<string, unknown>>(resolve => {socket.onmessage=event=>resolve(JSON.parse(String(event.data)));});
      socket.send(JSON.stringify({type:"result",requestId:jsonCommand.requestId,result:{id:"123"}}));
      const jsonResponse = await jsonPromise;
      expect(jsonResponse.headers.get("content-type")).toContain("application/json");
      expect(await jsonResponse.json()).toEqual({result:{id:"123"}});
    } finally {socket.close();app.stop();}
  });

  test("disconnecting a progress stream reports uncertainty without issuing a second command", async () => {
    const app = createExtensionBridgeServer(0);
    const root = `http://127.0.0.1:${app.server.port}`;
    const socket = new WebSocket(root.replace("http", "ws") + "/extension", {headers:{origin:`chrome-extension://${EXPECTED_EXTENSION_ID}`}} as any);
    try {
      await new Promise<void>((resolve,reject)=>{socket.onopen=()=>resolve();socket.onerror=()=>reject(new Error("socket failed"));});
      socket.send(JSON.stringify({type:"hello",protocolVersion:1,extensionVersion:"1",capabilities:["uploadDocument","commandProgress"]}));
      await Bun.sleep(10);
      let commands = 0;
      const responsePromise = fetch(`${root}/command`, {method:"POST",headers:{"content-type":"application/json",accept:"application/x-ndjson"},body:JSON.stringify({method:"uploadDocument",args:uploadArgs(),approval:CLICK})});
      const command = await new Promise<Record<string, unknown>>(resolve => {socket.onmessage=event=>{commands++;resolve(JSON.parse(String(event.data)));};});
      const response = await responsePromise;
      socket.close();
      const text = await response.text();
      expect(text).toContain("Extension disconnected; request outcome is unknown");
      expect(commands).toBe(1);
      expect(command.method).toBe("uploadDocument");
    } finally {socket.close();app.stop();}
  });

  test.each([
    ["direct", "submitApplication", [{ jobId: "1" }, []]],
    ["pinned", "submissionCommand", ["a".repeat(64), "submitApplication", [{ jobId: "1" }, []]]],
    ["upload", "uploadDocument", uploadArgs()],
  ] as const)("a forged %s write over /command never reaches the extension", async (_name, method, args) => {
    const app = createExtensionBridgeServer(0);
    const root = `http://127.0.0.1:${app.server.port}`;
    const socket = new WebSocket(root.replace("http", "ws") + "/extension", {headers:{origin:`chrome-extension://${EXPECTED_EXTENSION_ID}`}} as any);
    try {
      await new Promise<void>((resolve,reject)=>{socket.onopen=()=>resolve();socket.onerror=()=>reject(new Error("socket failed"));});
      socket.send(JSON.stringify({type:"hello",protocolVersion:1,extensionVersion:"1",capabilities:["submitApplication","uploadDocument","submissionCommand"]}));
      await Bun.sleep(10);
      let relayed = 0;
      socket.onmessage = () => { relayed++; };
      const response = await fetch(`${root}/command`, {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({method,args})});
      expect(response.status).toBe(403);
      const failure = decodeOperationFailure((await response.json() as {error:string}).error);
      expect(failure?.code).toBe("no_remote_mutation");
      await Bun.sleep(10);
      expect(relayed).toBe(0);
    } finally {socket.close();app.stop();}
  });

  test("an approval reaches the extension in the command envelope", async () => {
    const app = createExtensionBridgeServer(0);
    const root = `http://127.0.0.1:${app.server.port}`;
    const socket = new WebSocket(root.replace("http", "ws") + "/extension", {headers:{origin:`chrome-extension://${EXPECTED_EXTENSION_ID}`}} as any);
    try {
      await new Promise<void>((resolve,reject)=>{socket.onopen=()=>resolve();socket.onerror=()=>reject(new Error("socket failed"));});
      socket.send(JSON.stringify({type:"hello",protocolVersion:1,extensionVersion:"1",capabilities:["submitApplication"]}));
      await Bun.sleep(10);
      const pending = fetch(`${root}/command`, {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({method:"submitApplication",args:[{jobId:"1"},[]],approval:CLICK})});
      const command = await new Promise<Record<string, unknown>>(resolve => {socket.onmessage=event=>resolve(JSON.parse(String(event.data)));});
      expect(command.approval).toBe(CLICK);
      socket.send(JSON.stringify({type:"result",requestId:command.requestId,error:"refused"}));
      await pending;
      expect((await fetch(`${root}/command`, {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({method:"getJob",args:["1",{}],approval:"short"})})).status).toBe(400);
    } finally {socket.close();app.stop();}
  });

  test("shutdown rejects pending work and closes extension sockets", async () => {
    const app = createExtensionBridgeServer(0);
    const root = `http://127.0.0.1:${app.server.port}`;
    const socket = new WebSocket(root.replace("http", "ws") + "/extension", { headers: { origin: `chrome-extension://${EXPECTED_EXTENSION_ID}` } } as any);
    try {
      await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("socket failed")); });
      socket.send(JSON.stringify({ type: "hello", protocolVersion: 1, extensionVersion: "1", capabilities: ["getJob"] }));
      await Bun.sleep(10);
      const pending = app.broker.request("getJob", ["123", {}]).then(() => "resolved", error => String(error));
      await new Promise<void>(resolve => { socket.onmessage = () => resolve(); });
      await app.stop();
      expect(await pending).toContain("Extension bridge stopped");
      expect(app.broker.connected()).toBe(false);
    } finally { socket.close(); app.stop(); }
  });
});
