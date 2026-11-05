import { describe, expect, test } from "bun:test";
import { createExtensionBridgeServer } from "../../bridge/src/extension-broker.js";
import { ExtensionCommandProxy, ExtensionResearchClient } from "../../bridge/src/extension-proxy.js";
import { EXPECTED_EXTENSION_ID } from "../../shared/src/extension-protocol.js";

describe("extension bridge and research proxy integration", () => {
  test("reports extension connection and proxy health over loopback", async () => {
    const bridge = createExtensionBridgeServer(0);
    const socket = new WebSocket(`ws://127.0.0.1:${bridge.server.port}/extension`, {
      headers: { origin: `chrome-extension://${EXPECTED_EXTENSION_ID}` },
    } as any);
    try {
      await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("socket failed")); });
      socket.send(JSON.stringify({ type: "hello", protocolVersion: 1, extensionVersion: "test", capabilities: ["health"] }));
      socket.onmessage = event => {
        const command = JSON.parse(String(event.data));
        socket.send(JSON.stringify({ type: "result", requestId: command.requestId, result: { authenticated: true, bridgeConnected: true, bootstrapped: true } }));
      };
      const client = new ExtensionResearchClient(new ExtensionCommandProxy(`http://127.0.0.1:${bridge.server.port}`));
      await expect(client.health()).resolves.toEqual({ authenticated: true, bridgeConnected: true, bootstrapped: true });
    } finally {
      socket.close();
      bridge.stop();
    }
  });

  test("returns useful disconnected health when the bridge is unavailable", async () => {
    const client = new ExtensionResearchClient(new ExtensionCommandProxy("http://127.0.0.1:1"));
    await expect(client.health()).resolves.toMatchObject({ authenticated: false, bridgeConnected: false, bootstrapped: false });
  });
});
