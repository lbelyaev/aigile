import { describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";
import { createRpcClient } from "./index.js";

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
      if (method !== "session/request_permission") throw new Error("unexpected");
      return { outcome: { outcome: "selected", optionId: "allow_once" } };
    });

    input.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "session/request_permission",
      params: { sessionId: "s1" },
    }) + "\n");

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

    input.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s1" },
    }) + "\n");

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["a:session/update", "b:session/update"]);
    rpc.destroy();
  });
});
