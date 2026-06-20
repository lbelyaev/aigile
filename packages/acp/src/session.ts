import type { JsonRpcNotification, RpcClient } from "./rpc.js";

export type AcpEvent =
  | { type: "text_delta"; sessionId: string; delta: string; usage?: AcpTokenUsage }
  | { type: "thinking_delta"; sessionId: string; delta: string; usage?: AcpTokenUsage }
  | { type: "token_usage"; sessionId: string; usage: AcpTokenUsage }
  | { type: "tool_start"; sessionId: string; tool: string; toolCallId?: string; params?: unknown }
  | {
      type: "tool_end";
      sessionId: string;
      tool: string;
      toolCallId?: string;
      result?: string;
      usage?: AcpTokenUsage;
    }
  | {
      type: "permission_decision";
      sessionId: string;
      requestId: string;
      tool: string;
      description: string;
      decision: PermissionDecision;
    }
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

export interface AcpTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AcpSessionOptions {
  sessionId: string;
  acpSessionId: string;
  promptTimeoutMs?: number;
  decidePermission?: (request: AcpPermissionRequest) => PermissionDecision | undefined;
}

export interface AcpPermissionRequest {
  sessionId: string;
  tool: string;
  requestId: string;
  description: string;
  options: AcpPermissionOption[];
  // ACP tool-call kind (e.g. "execute", "edit", "read"); agent-defined, may be absent.
  kind?: string;
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
  usage?: unknown;
  tokenUsage?: unknown;
  toolCallId?: string;
  title?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  _meta?: { claudeCode?: { toolName?: string }; usage?: unknown; tokenUsage?: unknown };
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

export const DEFAULT_ACP_PROMPT_TIMEOUT_MS = 30 * 60 * 1_000;

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const tokenCount = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
};

const tokenField = (
  source: Record<string, unknown>,
  keys: readonly string[],
): number | undefined => {
  for (const key of keys) {
    const value = tokenCount(source[key]);
    if (value !== undefined) return value;
  }
  return undefined;
};

const normalizeTokenUsage = (value: unknown): AcpTokenUsage | undefined => {
  if (!isRecord(value)) return undefined;
  const inputTokens = tokenField(value, [
    "inputTokens",
    "input_tokens",
    "promptTokens",
    "prompt_tokens",
  ]);
  const outputTokens = tokenField(value, [
    "outputTokens",
    "output_tokens",
    "completionTokens",
    "completion_tokens",
  ]);
  const explicitTotalTokens = tokenField(value, ["totalTokens", "total_tokens"]);
  const totalTokens =
    explicitTotalTokens ??
    (inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined)
    return undefined;
  const usage: AcpTokenUsage = {};
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (totalTokens !== undefined) usage.totalTokens = totalTokens;
  return usage;
};

export const extractTokenUsage = (value: unknown): AcpTokenUsage | undefined => {
  if (!isRecord(value)) return undefined;
  return (
    normalizeTokenUsage(value.usage) ??
    normalizeTokenUsage(value.tokenUsage) ??
    normalizeTokenUsage(isRecord(value._meta) ? value._meta.usage : undefined) ??
    normalizeTokenUsage(isRecord(value._meta) ? value._meta.tokenUsage : undefined)
  );
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
  const usage = extractTokenUsage(update);

  if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_message") {
    const delta = extractText(update.content);
    if (delta.length === 0 && usage !== undefined) return { type: "token_usage", sessionId, usage };
    const event: AcpEvent = { type: "text_delta", sessionId, delta };
    if (usage !== undefined) event.usage = usage;
    return event;
  }
  if (update.sessionUpdate === "agent_thought_chunk") {
    const event: AcpEvent = {
      type: "thinking_delta",
      sessionId,
      delta: extractText(update.content),
    };
    if (usage !== undefined) event.usage = usage;
    return event;
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
    update.sessionUpdate === "tool_call_update" &&
    (update.status === "completed" || update.status === "failed")
  ) {
    const event: AcpEvent = {
      type: "tool_end",
      sessionId,
      tool: extractToolName(update),
    };
    if (update.toolCallId !== undefined) event.toolCallId = update.toolCallId;
    if (typeof update.rawOutput === "string") event.result = update.rawOutput;
    if (usage !== undefined) event.usage = usage;
    return event;
  }

  if (usage !== undefined) return { type: "token_usage", sessionId, usage };

  return null;
};

const PERMISSION_OPTION_KINDS: Record<
  Exclude<PermissionDecision, "cancelled">,
  readonly string[]
> = {
  allow_once: ["allow_once", "allow_always"],
  reject_once: ["reject_once", "reject_always"],
};

// ACP option ids are agent-defined; the decision maps to an option by its `kind`,
// not by assuming the kind string is also the option id.
const selectPermissionOptionId = (
  options: readonly AcpPermissionOption[],
  decision: Exclude<PermissionDecision, "cancelled">,
): string | undefined => {
  for (const kind of PERMISSION_OPTION_KINDS[decision]) {
    const match = options.find((option) => option.kind === kind);
    if (match) return match.optionId;
  }
  // Back-compat: some agents historically used the kind value as the option id.
  return options.find((option) => option.optionId === decision)?.optionId;
};

const permissionResult = (request: AcpPermissionRequest, decision: PermissionDecision): unknown => {
  if (decision === "cancelled") return { outcome: { outcome: "cancelled" } };
  const optionId = selectPermissionOptionId(request.options, decision);
  if (optionId === undefined) return { outcome: { outcome: "cancelled" } };
  return { outcome: { outcome: "selected", optionId } };
};

const permissionDescription = (rawInput: unknown, fallback: string): string => {
  if (rawInput === undefined) return fallback;
  return JSON.stringify(rawInput);
};

const normalizePromptTimeoutMs = (timeoutMs: number | undefined): number => {
  const resolved = timeoutMs ?? DEFAULT_ACP_PROMPT_TIMEOUT_MS;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error("ACP prompt timeout must be a finite positive number");
  }
  return resolved;
};

const isPromptTimeoutError = (error: unknown, timeoutMs: number): boolean =>
  error instanceof Error &&
  error.message === `RPC request "session/prompt" timed out after ${timeoutMs}ms`;

export const createAcpSession = (rpc: RpcClient, options: AcpSessionOptions): AcpSession => {
  const handlers: Array<(event: AcpEvent) => void> = [];
  const promptTimeoutMs = normalizePromptTimeoutMs(options.promptTimeoutMs);

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
    if (permission.toolCall?.kind !== undefined) request.kind = permission.toolCall.kind;

    const decision = options.decidePermission?.(request);
    if (decision) {
      const event: AcpEvent = {
        type: "permission_decision",
        sessionId: request.sessionId,
        requestId: request.requestId,
        tool: request.tool,
        description: request.description,
        decision,
      };
      for (const handler of handlers) handler(event);
      return permissionResult(request, decision);
    }

    const event: AcpEvent = { type: "approval_request", ...request };
    for (const handler of handlers) handler(event);
    return permissionResult(request, "cancelled");
  });

  return {
    sessionId: options.sessionId,
    acpSessionId: options.acpSessionId,
    prompt: async (text) => {
      try {
        return await rpc.sendRequest(
          "session/prompt",
          {
            sessionId: options.acpSessionId,
            prompt: [{ type: "text", text }],
          },
          { timeoutMs: promptTimeoutMs },
        );
      } catch (error) {
        if (isPromptTimeoutError(error, promptTimeoutMs)) {
          try {
            rpc.sendNotification("session/cancel", { sessionId: options.acpSessionId });
          } catch {
            // The runner may already be killing the process; cancellation is best-effort.
          }
        }
        throw error;
      }
    },
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
