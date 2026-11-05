import { DEFAULT_BRIDGE_PORT, LOOPBACK_BRIDGE_HOST } from "../../shared/src/protocol.js";
import { createExtensionBridgeServer } from "./extension-broker.js";
import { probeBridge } from "./probe.js";

interface BridgeLifecycleOptions {
  port?: number;
  pollIntervalMs?: number;
  probeTimeoutMs?: number;
  startupTimeoutMs?: number;
}

/** One bridge owner per port; other MCP processes follow and can take over. */
export class BridgeLifecycle {
  private server: ReturnType<typeof createExtensionBridgeServer> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private probe: AbortController | undefined;
  private stopped = false;
  private unavailable = false;
  private readonly pollIntervalMs: number;
  private readonly probeTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private bridgePort: number;

  constructor(options: BridgeLifecycleOptions = {}) {
    this.bridgePort = options.port ?? DEFAULT_BRIDGE_PORT;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 500;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 3_000;
  }

  get port(): number { return this.bridgePort; }
  get ownsBridge(): boolean { return this.server !== undefined; }

  async start(): Promise<void> {
    const deadline = Date.now() + this.startupTimeoutMs;
    while (!this.stopped) {
      try {
        await this.acquire(Math.max(1, deadline - Date.now()));
        this.schedule();
        return;
      } catch (error) {
        if (this.stopped) return;
        if (!(error instanceof Error && "code" in error && error.code === "BRIDGE_OCCUPIED")) throw error;
        if (Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())));
      }
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.probe?.abort();
    const server = this.server;
    this.server = undefined;
    if (server) {
      await server.stop();
      this.log("bridge.closed");
    }
  }

  private async acquire(remainingMs = this.probeTimeoutMs): Promise<void> {
    if (this.stopped || this.server) return;
    try {
      this.server = createExtensionBridgeServer(this.bridgePort);
      this.bridgePort = this.server.server.port!;
      this.log("bridge.listening");
      this.unavailable = false;
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) throw error;
    }
    const controller = new AbortController();
    this.probe = controller;
    const timeout = setTimeout(() => controller.abort(), Math.min(this.probeTimeoutMs, remainingMs));
    try {
      await probeBridge(`http://${LOOPBACK_BRIDGE_HOST}:${this.bridgePort}`, controller.signal);
      if (!this.stopped && (this.unavailable || this.timer === undefined)) this.log("bridge.reused");
      this.unavailable = false;
    } catch {
      throw Object.assign(new Error(
        `Port ${this.bridgePort} is occupied but no compatible WaterlooWorks bridge responded. Check the service using that port.`,
      ), { code: "BRIDGE_OCCUPIED" });
    } finally {
      clearTimeout(timeout);
      controller.abort();
      this.probe = undefined;
    }
  }

  private schedule(): void {
    if (this.stopped || this.server) return;
    this.timer = setTimeout(() => { void this.monitor(); }, this.pollIntervalMs);
  }

  private async monitor(): Promise<void> {
    try {
      await this.acquire();
    } catch {
      if (!this.stopped && !this.unavailable) this.log("bridge.unavailable");
      this.unavailable = true;
    } finally {
      this.schedule();
    }
  }

  private log(event: string): void {
    console.error(JSON.stringify({ event, transport: "http", host: LOOPBACK_BRIDGE_HOST, port: this.bridgePort }));
  }
}
