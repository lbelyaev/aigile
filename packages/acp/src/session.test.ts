import { describe, expect, it } from "bun:test";
import {
  createAcpSession,
  translateSessionUpdate,
  type JsonRpcNotification,
  type RpcClient,
} from "./index.js";

const mockRpc = (): RpcClient & {
  emitNotification: (notification: JsonRpcNotification) => void;
  emitRequest: (method: string, params: unknown) => Promise<unknown>;
} => {
  let notificationHandler: ((notification: JsonRpcNotification) => void) | undefined;
  let requestHandler: ((method: string, params: unknown) => Promise<unknown>) | undefined;

  return {
    sendRequest: async () => undefined,
    sendNotification: () => undefined,
    sendResponse: () => undefined,
    sendErrorResponse: () => undefined,
    onNotification: (handler) => {
      notificationHandler = handler;
      return () => {
        notificationHandler = undefined;
      };
    },
    onRequest: (handler) => {
      requestHandler = handler;
      return () => {
        requestHandler = undefined;
      };
    },
    destroy: () => undefined,
    emitNotification: (notification) => {
      notificationHandler?.(notification);
    },
    emitRequest: async (method, params) => {
      if (!requestHandler) throw new Error("missing request handler");
      return requestHandler(method, params);
    },
  };
};

describe("ACP session translation", () => {
  it("translates nested agent message chunks", () => {
    expect(translateSessionUpdate({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acp-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
        },
      },
    }, "role-session-1", "acp-1")).toEqual({
      type: "text_delta",
      sessionId: "role-session-1",
      delta: "hello",
    });
  });

  it("translates tool start and completion updates", () => {
    expect(translateSessionUpdate({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acp-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "Bash",
          rawInput: { command: "bun test" },
        },
      },
    }, "role-session-1", "acp-1")).toEqual({
      type: "tool_start",
      sessionId: "role-session-1",
      tool: "Bash",
      toolCallId: "tool-1",
      params: { command: "bun test" },
    });

    expect(translateSessionUpdate({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acp-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          title: "Bash",
          status: "completed",
          rawOutput: "ok",
        },
      },
    }, "role-session-1", "acp-1")).toEqual({
      type: "tool_end",
      sessionId: "role-session-1",
      tool: "Bash",
      toolCallId: "tool-1",
      result: "ok",
    });
  });

  it("translates token usage from session updates", () => {
    expect(translateSessionUpdate({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acp-1",
        update: {
          sessionUpdate: "agent_message",
          usage: {
            inputTokens: 1200,
            outputTokens: 500,
          },
        },
      },
    }, "role-session-1", "acp-1")).toEqual({
      type: "token_usage",
      sessionId: "role-session-1",
      usage: {
        inputTokens: 1200,
        outputTokens: 500,
        totalTokens: 1700,
      },
    });

    expect(translateSessionUpdate({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acp-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
          _meta: {
            usage: {
              prompt_tokens: 10,
              completion_tokens: 4,
              total_tokens: 14,
            },
          },
        },
      },
    }, "role-session-1", "acp-1")).toEqual({
      type: "text_delta",
      sessionId: "role-session-1",
      delta: "hello",
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
      },
    });

    expect(translateSessionUpdate({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acp-1",
        update: {
          sessionUpdate: "agent_message",
          usage: {
            tokens: 999_999,
            inputTokens: 12,
            outputTokens: 3,
          },
        },
      },
    }, "role-session-1", "acp-1")).toEqual({
      type: "token_usage",
      sessionId: "role-session-1",
      usage: {
        inputTokens: 12,
        outputTokens: 3,
        totalTokens: 15,
      },
    });
  });

  it("routes permission requests through policy before asking", async () => {
    const rpc = mockRpc();
    const events: unknown[] = [];
    const session = createAcpSession(rpc, {
      acpSessionId: "acp-1",
      sessionId: "role-session-1",
      decidePermission: () => "allow_once",
    });
    session.onEvent((event) => events.push(event));

    await expect(rpc.emitRequest("session/request_permission", {
      sessionId: "acp-1",
      toolCall: {
        toolCallId: "tool-1",
        title: "Bash",
        rawInput: { command: "bun test" },
      },
      options: [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }],
    })).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "allow_once" },
    });
    expect(events).toEqual([{
      type: "permission_decision",
      sessionId: "role-session-1",
      requestId: "tool-1",
      tool: "Bash",
      description: JSON.stringify({ command: "bun test" }),
      decision: "allow_once",
    }]);
  });
});
