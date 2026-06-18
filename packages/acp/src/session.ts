import type { JsonRpcNotification, RpcClient } from "./rpc.js";

export type AcpEvent =
  | { type: "text_delta"; sessionId: string; delta: string }
  | { type: "thinking_delta"; sessionId: string; delta: string }
  | { type: "tool_start"; sessionId: string; tool: string; toolCallId?: string; params?: unknown }
  | { type: "tool_end"; sessionId: string; tool: string; toolCallId?: string; result?: string }
  | {
      type: "approval_request";
      sessionId: string;
      requestId: string;
      tool: string;
      description: string;
      options: AcpPermissionOption[];
    };

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export type PermissionDecision = "allow_once" | "reject_once" | "cancelled";

export interface AcpSessionOptions {
  sessionId: string;
  acpSessionId: string;
  decidePermission?: (request: AcpPermissionRequest) => PermissionDecision | undefined;
}

export interface AcpPermissionRequest {
  sessionId: string;
  tool: string;
  requestId: string;
  description: string;
  options: AcpPermissionOption[];
}

export interface AcpSession {
  sessionId: string;
  acpSessionId: string;
  prompt: (text: string) => Promise<unknown>;
  cancel: () => void;
  onEvent: (handler: (event: AcpEvent) => void) => () => void;
}

interface AcpContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface AcpSessionUpdate {
  sessionUpdate?: string;
  content?: AcpContentBlock | AcpContentBlock[];
  toolCallId?: string;
  title?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  _meta?: { claudeCode?: { toolName?: string } };
}

interface AcpSessionUpdateParams {
  sessionId?: string;
  update?: AcpSessionUpdate;
}

interface AcpRequestPermissionParams {
  sessionId?: string;
  toolCall?: {
    toolCallId?: string;
    title?: string;
    kind?: string;
    rawInput?: unknown;
  };
  options?: AcpPermissionOption[];
}

const extractText = (content: AcpSessionUpdate["content"]): string => {
  if (!content) return "";
  const blocks = Array.isArray(content) ? content : [content];
  return blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
};

const extractToolName = (update: AcpSessionUpdate): string => {
  if (update.title && update.title !== '"undefined"') return update.title;
  const rawInput = update.rawInput;
  if (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
    const input = rawInput as Record<string, unknown>;
    if (typeof input.command === "string") return "Bash";
    if (typeof input.query === "string") return "WebSearch";
  }
  return update._meta?.claudeCode?.toolName ?? "unknown";
};

export const translateSessionUpdate = (
  notification: JsonRpcNotification,
  sessionId: string,
  acpSessionId: string,
): AcpEvent | null => {
  if (notification.method !== "session/update") return null;
  const params = notification.params as AcpSessionUpdateParams | undefined;
  if (!params || params.sessionId !== acpSessionId || !params.update) return null;
  const update = params.update;

  if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_message") {
    return { type: "text_delta", sessionId, delta: extractText(update.content) };
  }
  if (update.sessionUpdate === "agent_thought_chunk") {
    return { type: "thinking_delta", sessionId, delta: extractText(update.content) };
  }
  if (update.sessionUpdate === "tool_call") {
    const event: AcpEvent = {
      type: "tool_start",
      sessionId,
      tool: extractToolName(update),
    };
    if (update.toolCallId !== undefined) event.toolCallId = update.toolCallId;
    if (update.rawInput !== undefined) event.params = update.rawInput;
    return event;
  }
  if (
    update.sessionUpdate === "tool_call_update"
    && (update.status === "completed" || update.status === "failed")
  ) {
    const event: AcpEvent = {
      type: "tool_end",
      sessionId,
      tool: extractToolName(update),
    };
    if (update.toolCallId !== undefined) event.toolCallId = update.toolCallId;
    if (typeof update.rawOutput === "string") event.result = update.rawOutput;
    return event;
  }

  return null;
};

const permissionResult = (decision: PermissionDecision): unknown => {
  if (decision === "cancelled") return { outcome: { outcome: "cancelled" } };
  return { outcome: { outcome: "selected", optionId: decision } };
};

const permissionDescription = (rawInput: unknown, fallback: string): string => {
  if (rawInput === undefined) return fallback;
  return JSON.stringify(rawInput);
};

export const createAcpSession = (
  rpc: RpcClient,
  options: AcpSessionOptions,
): AcpSession => {
  const handlers: Array<(event: AcpEvent) => void> = [];

  rpc.onNotification((notification) => {
    const event = translateSessionUpdate(notification, options.sessionId, options.acpSessionId);
    if (!event) return;
    for (const handler of handlers) handler(event);
  });

  rpc.onRequest(async (method, params) => {
    if (method !== "session/request_permission") {
      throw new Error(`Unhandled ACP request: ${method}`);
    }

    const permission = params as AcpRequestPermissionParams;
    if (permission.sessionId !== options.acpSessionId) {
      throw new Error(`Unknown ACP session: ${String(permission.sessionId)}`);
    }

    const requestId = permission.toolCall?.toolCallId ?? "unknown";
    const tool = permission.toolCall?.title ?? "unknown";
    const request: AcpPermissionRequest = {
      sessionId: options.sessionId,
      requestId,
      tool,
      description: permissionDescription(permission.toolCall?.rawInput, tool),
      options: permission.options ?? [],
    };

    const decision = options.decidePermission?.(request);
    if (decision) return permissionResult(decision);

    const event: AcpEvent = { type: "approval_request", ...request };
    for (const handler of handlers) handler(event);
    return permissionResult("cancelled");
  });

  return {
    sessionId: options.sessionId,
    acpSessionId: options.acpSessionId,
    prompt: (text) => rpc.sendRequest("session/prompt", {
      sessionId: options.acpSessionId,
      prompt: [{ type: "text", text }],
    }, { timeoutMs: null }),
    cancel: () => rpc.sendNotification("session/cancel", { sessionId: options.acpSessionId }),
    onEvent: (handler) => {
      handlers.push(handler);
      return () => {
        const index = handlers.indexOf(handler);
        if (index >= 0) handlers.splice(index, 1);
      };
    },
  };
};
