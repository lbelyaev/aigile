import { describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";
import { MethodNotHandledError, createAcpSession, createRpcClient } from "./index.js";

const makeStreams = () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const written: string[] = [];
  output.on("data", (chunk: Buffer) => written.push(chunk.toString()));
  return { input, output, written };
};

describe("ACP JSON-RPC client", () => {
  it("sends requests and resolves matching responses", async () => {
    const { input, output, written } = makeStreams();
    const rpc = createRpcClient(input, output, { timeoutMs: 500 });

    const promise = rpc.sendRequest("initialize", { protocolVersion: 1 });
    expect(JSON.parse(written[0]!.trim())).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1 },
    });

    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }) + "\n");

    await expect(promise).resolves.toEqual({ ok: true });
    rpc.destroy();
  });

  it("dispatches incoming requests and writes JSON-RPC responses", async () => {
    const { input, output, written } = makeStreams();
    const rpc = createRpcClient(input, output, { timeoutMs: 500 });

    rpc.onRequest(async (method) => {
      if (method !== "session/request_permission") throw new MethodNotHandledError(method);
      return { outcome: { outcome: "selected", optionId: "allow_once" } };
    });

    input.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "session/request_permission",
        params: { sessionId: "s1" },
      }) + "\n",
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(written[0]!.trim())).toEqual({
      jsonrpc: "2.0",
      id: 9,
      result: { outcome: { outcome: "selected", optionId: "allow_once" } },
    });
    rpc.destroy();
  });

  it("notifies all registered notification handlers", async () => {
    const { input, output } = makeStreams();
    const rpc = createRpcClient(input, output);
    const calls: string[] = [];

    rpc.onNotification((notification) => calls.push(`a:${notification.method}`));
    rpc.onNotification((notification) => calls.push(`b:${notification.method}`));

    input.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "s1" },
      }) + "\n",
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["a:session/update", "b:session/update"]);
    rpc.destroy();
  });

  it("reports handler errors without converting them to method-not-found", async () => {
    const { input, output, written } = makeStreams();
    const rpc = createRpcClient(input, output);
    let laterHandlerCalled = false;

    rpc.onRequest(async () => {
      throw new Error("permission failed");
    });
    rpc.onRequest(async () => {
      laterHandlerCalled = true;
      return { ok: true };
    });

    input.write(
      JSON.stringify({ jsonrpc: "2.0", id: 7, method: "session/request_permission" }) + "\n",
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]!.trim())).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32603, message: "permission failed" },
    });
    expect(laterHandlerCalled).toBe(false);
    rpc.destroy();
  });

  it("returns method-not-found when all request handlers decline the method", async () => {
    const { input, output, written } = makeStreams();
    const rpc = createRpcClient(input, output);

    rpc.onRequest(async (method) => {
      throw new MethodNotHandledError(method);
    });
    rpc.onRequest(async (method) => {
      throw new MethodNotHandledError(method);
    });

    input.write(JSON.stringify({ jsonrpc: "2.0", id: 11, method: "missing/method" }) + "\n");

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(written[0]!.trim())).toEqual({
      jsonrpc: "2.0",
      id: 11,
      error: { code: -32601, message: "Method not found: missing/method" },
    });
    rpc.destroy();
  });

  it("continues after a handler declines and writes the later matching result", async () => {
    const { input, output, written } = makeStreams();
    const rpc = createRpcClient(input, output);

    rpc.onRequest(async (method) => {
      throw new MethodNotHandledError(method);
    });
    rpc.onRequest(async (method) => {
      if (method !== "session/request_permission") throw new MethodNotHandledError(method);
      return { ok: true };
    });

    input.write(
      JSON.stringify({ jsonrpc: "2.0", id: 12, method: "session/request_permission" }) + "\n",
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(written[0]!.trim())).toEqual({
      jsonrpc: "2.0",
      id: 12,
      result: { ok: true },
    });
    rpc.destroy();
  });

  it("surfaces unknown ACP session errors from permission requests", async () => {
    const { input, output, written } = makeStreams();
    const rpc = createRpcClient(input, output);

    createAcpSession(rpc, { sessionId: "local-session", acpSessionId: "acp-session" });

    input.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 13,
        method: "session/request_permission",
        params: { sessionId: "unknown-session" },
      }) + "\n",
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(written[0]!.trim())).toEqual({
      jsonrpc: "2.0",
      id: 13,
      error: { code: -32603, message: "Unknown ACP session: unknown-session" },
    });
    rpc.destroy();
  });
});
