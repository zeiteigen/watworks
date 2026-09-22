import type { MessageExtraInfo, JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * Newline-delimited MCP stdio transport using Bun streams rather than the
 * SDK's Node stream adapter. The wire format remains the official MCP stdio
 * format: one JSON-RPC message per line.
 */
export class BunStdioServerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  private started = false;
  private closed = false;
  private buffer = "";
  private readonly decoder = new TextDecoder();
  private writeChain: Promise<void> = Promise.resolve();
  private readonly closedPromise: Promise<void>;
  private resolveClosed!: () => void;

  constructor() {
    this.closedPromise = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    void this.readLoop();
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (this.closed) throw new Error("MCP stdio transport is closed");
    const line = `${JSON.stringify(message)}\n`;
    this.writeChain = this.writeChain.then(async () => {
      await Bun.stdout.write(new TextEncoder().encode(line));
    });
    return this.writeChain;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.resolveClosed();
    this.onclose?.();
  }

  async waitForClose(): Promise<void> {
    return this.closedPromise;
  }

  private async readLoop(): Promise<void> {
    try {
      for await (const chunk of Bun.stdin.stream()) {
        if (this.closed) break;
        this.buffer += this.decoder.decode(chunk, { stream: true });
        this.processLines();
      }
      if (!this.closed) await this.close();
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error("MCP stdio read failed");
      this.onerror?.(normalized);
      await this.close();
    }
  }

  private processLines(): void {
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const message: unknown = JSON.parse(line);
        this.onmessage?.(message as JSONRPCMessage);
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error("Invalid MCP JSON-RPC message"));
      }
    }
  }
}
