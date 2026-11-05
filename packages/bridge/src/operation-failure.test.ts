import { describe, expect, test } from "bun:test";
import { ReviewBeforeMutationError } from "../../approval/src/types.js";
import { BrowserOperationError, decodeOperationFailure, encodeOperationFailure, operationFailureSchema } from "../../shared/src/operation-failure.js";
import { extensionResultSchema, localCommandResponseSchema, validateExtensionArgs } from "../../shared/src/extension-protocol.js";
import { ExtensionApplicationGateway } from "./extension-proxy.js";

const failure = {
  phase: "submit" as const,
  code: "no_remote_mutation" as const,
  message: "Preflight failed before dispatch",
};

class MockProxy {
  calls: Array<{ method: string; args: unknown[] }> = [];
  result: unknown = { applicationId: "application-1" };
  error: unknown;

  async call(method: string, ...args: unknown[]): Promise<unknown> {
    this.calls.push({ method, args });
    if (this.error) throw this.error;
    return this.result;
  }
}

describe("operation failure transport", () => {
  test("failure metadata survives shared schema envelopes and BrowserOperationError", () => {
    expect(operationFailureSchema.parse(failure)).toEqual(failure);
    const encoded = encodeOperationFailure(failure);
    const extension = extensionResultSchema.parse({
      type: "result", requestId: "4fd9413f-9734-4ed6-9794-06f9942e95d0",
      error: encoded,
    });
    const local = localCommandResponseSchema.parse({ error: extension.error });
    expect("error" in local).toBe(true);
    if (!("error" in local) || extension.error === undefined) throw new Error("Expected failure envelopes");
    expect(local).toEqual({ error: extension.error });

    const decoded = decodeOperationFailure(local.error);
    expect(decoded).toEqual(failure);
    const error = new BrowserOperationError(decoded!);
    expect(error).toMatchObject({ name: "BrowserOperationError", message: "submit: Preflight failed before dispatch", failure });
    expect(decodeOperationFailure("ordinary bridge disconnect")).toBeUndefined();
    expect(decodeOperationFailure("[waterlooworks-operation-failure]{broken}\nerror")).toBeUndefined();
  });

  test("only explicit no_remote_mutation becomes a typed pre-mutation error", async () => {
    const proxy = new MockProxy();
    const gateway = new ExtensionApplicationGateway(proxy as never);
    for (const remoteFailure of [failure, { ...failure, code: "outcome_unknown" as const }]) {
      proxy.error = new BrowserOperationError(remoteFailure);
      const caught = await gateway.withMutationTracking(() => Promise.reject(proxy.error)).catch(error => error);
      if (remoteFailure.code === "no_remote_mutation") {
        expect(caught).toBeInstanceOf(ReviewBeforeMutationError);
        expect(caught).toMatchObject({ code: "no_remote_mutation", failure: remoteFailure });
      } else {
        expect(caught).toBeInstanceOf(BrowserOperationError);
        expect(caught.failure).toEqual(remoteFailure);
      }
    }
    const disconnect = new Error("Extension disconnected; request outcome is unknown");
    proxy.error = disconnect;
    const caught = await gateway.withMutationTracking(() => Promise.reject(proxy.error)).catch(error => error);
    expect(caught).toBe(disconnect);
    expect(caught).not.toBeInstanceOf(ReviewBeforeMutationError);
  });

  test("submit carries attempt identity after staged attachments and omits undefined optional arguments", async () => {
    const proxy = new MockProxy();
    const gateway = new ExtensionApplicationGateway(proxy as never);
    const manifest = { jobId: "494987" } as never;
    const files = new Map();
    const beforeSubmit = () => {};

    const attemptId = "4fd9413f-9734-4ed6-9794-06f9942e95d0";
    await gateway.submitApplication(manifest, files, beforeSubmit, undefined, attemptId);
    const wireManifest = { jobId: "494987", executionAttemptId: attemptId };
    expect(proxy.calls[0]).toEqual({
      method: "submitApplication", args: [wireManifest, [], []],
    });
    expect(validateExtensionArgs("submitApplication", proxy.calls[0]!.args)).toBe(true);

    proxy.calls = [];
    await gateway.submitApplication(manifest, files, beforeSubmit);
    expect(proxy.calls[0]).toEqual({ method: "submitApplication", args: [manifest, []] });
  });

  test("fill-only applications use the dedicated extension command", async () => {
    const proxy = new MockProxy();
    const gateway = new ExtensionApplicationGateway(proxy as never);
    const manifest = { jobId: "494987", executionMode: "fill_only" } as never;
    await gateway.submitApplication(manifest, new Map(), () => {});

    expect(proxy.calls).toEqual([{ method: "fillApplication", args: [manifest, [], []] }]);
    expect(proxy.calls[0]!.method).not.toBe("submitApplication");
    expect(validateExtensionArgs("fillApplication", proxy.calls[0]!.args)).toBe(true);
  });
});
