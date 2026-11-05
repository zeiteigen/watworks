import { describe, expect, test } from "bun:test";
import { BridgeLifecycle } from "./lifecycle.js";
import { createBridgeServer } from "./http.js";
import { BridgeState } from "./state.js";

const timing = { pollIntervalMs: 15, probeTimeoutMs: 30, startupTimeoutMs: 100 };
async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error("Lifecycle condition timed out");
    await Bun.sleep(10);
  }
}
async function health(port: number): Promise<unknown> {
  return (await fetch(`http://127.0.0.1:${port}/health`)).json();
}

describe("shared browser bridge lifecycle", () => {
  test("reuses a compatible extension bridge and follower shutdown preserves ownership", async () => {
    const legacy = createBridgeServer(new BridgeState(), 0);
    const follower = new BridgeLifecycle({ ...timing, port: legacy.port! });
    try {
      await follower.start();
      expect(follower.ownsBridge).toBe(false);
      await follower.close();
      expect(await health(legacy.port!)).toEqual({ service: "waterlooworks-extension-bridge", bridgeConnected: false });
    } finally {
      await follower.close();
      await legacy.stop(true);
    }
  });

  test("elects one successor, starts disconnected, rejects the legacy session route, and releases the final port", async () => {
    const legacy = createBridgeServer(new BridgeState(), 0);
    const port = legacy.port!;
    const followers = Array.from({ length: 3 }, () => new BridgeLifecycle({ ...timing, port }));
    try {
      await Promise.all(followers.map((follower) => follower.start()));
      expect(followers.every((follower) => !follower.ownsBridge)).toBe(true);
      await legacy.stop(true);
      await eventually(() => followers.filter((follower) => follower.ownsBridge).length === 1);
      expect(await health(port)).toEqual({ service: "waterlooworks-extension-bridge", bridgeConnected: false });
      const response = await fetch(`http://127.0.0.1:${port}/session`, { method: "POST" });
      expect(response.status).toBe(404);
      // Close followers first so none can legitimately take over after final shutdown.
      await Promise.all(followers.filter((follower) => !follower.ownsBridge).map((follower) => follower.close()));
      await followers.find((follower) => follower.ownsBridge)!.close();
      const probe = createBridgeServer(new BridgeState(), port);
      await probe.stop(true);
    } finally {
      await Promise.all(followers.map((follower) => follower.close()));
      await legacy.stop(true);
    }
  });

  test("simultaneous starts bind exactly once and owner shutdown triggers takeover", async () => {
    const owner = new BridgeLifecycle({ ...timing, port: 0 });
    await owner.start();
    const port = owner.port;
    await owner.close();
    const peers = Array.from({ length: 3 }, () => new BridgeLifecycle({ ...timing, port }));
    try {
      await Promise.all(peers.map((peer) => peer.start()));
      expect(peers.filter((peer) => peer.ownsBridge)).toHaveLength(1);
      const first = peers.find((peer) => peer.ownsBridge)!;
      await first.close();
      await eventually(() => peers.filter((peer) => peer.ownsBridge).length === 1);
      expect(first.ownsBridge).toBe(false);
    } finally {
      await Promise.all(peers.map((peer) => peer.close()));
    }
  });

  test("rejects unrelated, malformed, redirected, and hanging listeners within the startup bound", async () => {
    for (const mode of ["unrelated", "malformed", "redirect", "hang"]) {
      const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
        if (mode === "hang") return new Promise<Response>(() => {});
        if (mode === "redirect") return Response.redirect("https://example.com");
        if (mode === "unrelated") return new Response("other service");
        if (new URL(request.url).pathname === "/") return Response.json({ service: "waterlooworks-extension-bridge" });
        return Response.json({ service: "waterlooworks-extension-bridge", bridgeConnected: "invalid" });
      } });
      const follower = new BridgeLifecycle({ ...timing, port: listener.port! });
      const started = Date.now();
      try {
        await expect(follower.start()).rejects.toThrow("no compatible WaterlooWorks bridge");
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(follower.ownsBridge).toBe(false);
      } finally {
        await follower.close();
        await listener.stop(true);
      }
    }
  });

  test("retries when the incumbent exits during startup", async () => {
    let requested!: () => void;
    const requestSeen = new Promise<void>((resolve) => { requested = resolve; });
    const incumbent = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
      requested();
      return new Response("stopping");
    } });
    const follower = new BridgeLifecycle({ ...timing, port: incumbent.port!, startupTimeoutMs: 500 });
    try {
      const starting = follower.start();
      await requestSeen;
      await incumbent.stop(true);
      await starting;
      expect(follower.ownsBridge).toBe(true);
    } finally {
      await follower.close();
      await incumbent.stop(true);
    }
  });

  test("a follower survives temporary incompatible listeners and recovers later", async () => {
    const legacy = createBridgeServer(new BridgeState(), 0);
    const port = legacy.port!;
    const follower = new BridgeLifecycle({ ...timing, port });
    let other: ReturnType<typeof Bun.serve> | undefined;
    try {
      await follower.start();
      await legacy.stop(true);
      other = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("unrelated service") });
      await Bun.sleep(80);
      expect(follower.ownsBridge).toBe(false);
      expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe("unrelated service");
      await other.stop(true);
      await eventually(() => follower.ownsBridge);
      expect(await health(port)).toEqual({ service: "waterlooworks-extension-bridge", bridgeConnected: false });
    } finally {
      await follower.close();
      await other?.stop(true);
      await legacy.stop(true);
    }
  });

  test("shutdown during a probe cannot acquire the bridge or restart monitoring", async () => {
    let requested!: () => void;
    const requestSeen = new Promise<void>((resolve) => { requested = resolve; });
    const incumbent = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
      requested();
      return new Promise<Response>(() => {});
    } });
    const port = incumbent.port!;
    const follower = new BridgeLifecycle({ ...timing, port });
    try {
      const starting = follower.start();
      await requestSeen;
      await follower.close();
      await incumbent.stop(true);
      await starting;
      await Bun.sleep(50);
      expect(follower.ownsBridge).toBe(false);
      const probe = createBridgeServer(new BridgeState(), port);
      await probe.stop(true);
    } finally {
      await follower.close();
      await incumbent.stop(true);
    }
  });
});
