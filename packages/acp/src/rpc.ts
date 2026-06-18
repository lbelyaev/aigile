import { Readable, Writable } from "node:stream";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

export type RequestHandler = (method: string, params: unknown) => Promise<unknown>;

export interface RpcClient {
  sendRequest: (method: string, params?: unknown, options?: RequestOptions) => Promise<unknown>;
  sendNotification: (method: string, params?: unknown) => void;
  sendResponse: (id: number | string, result: unknown) => void;
  sendErrorResponse: (id: number | string, code: number, message: string) => void;
  onNotification: (handler: (notification: JsonRpcNotification) => void) => () => void;
  onRequest: (handler: RequestHandler) => () => void;
  destroy: () => void;
}

export interface RequestOptions {
  timeoutMs?: number | null;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isJsonRpcRequest = (value: unknown): value is JsonRpcRequest =>
  isRecord(value)
  && value.jsonrpc === "2.0"
  && (typeof value.id === "number" || typeof value.id === "string")
  && typeof value.method === "string";

const isJsonRpcNotification = (value: unknown): value is JsonRpcNotification =>
  isRecord(value)
  && value.jsonrpc === "2.0"
  && value.id === undefined
  && typeof value.method === "string";

const isJsonRpcResponse = (value: unknown): value is JsonRpcResponse =>
  isRecord(value)
  && value.jsonrpc === "2.0"
  && (typeof value.id === "number" || typeof value.id === "string")
  && value.method === undefined;

const parseNdjsonStream = (
  input: Readable,
  onValue: (value: unknown) => void,
): void => {
  let buffer = "";

  input.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) onValue(JSON.parse(line));
      newlineIndex = buffer.indexOf("\n");
    }
  });
};

export const createRpcClient = (
  input: Readable,
  output: Writable,
  options: { timeoutMs?: number } = {},
): RpcClient => {
  const timeoutMs = options.timeoutMs ?? 30_000;
  let nextId = 1;
  const pending = new Map<number | string, PendingRequest>();
  const notificationHandlers: Array<(notification: JsonRpcNotification) => void> = [];
  const requestHandlers: RequestHandler[] = [];

  const write = (value: unknown): void => {
    output.write(`${JSON.stringify(value)}\n`);
  };

  const clearPending = (id: number | string): PendingRequest | undefined => {
    const entry = pending.get(id);
    if (!entry) return undefined;
    pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    return entry;
  };

  const dispatchRequest = async (request: JsonRpcRequest): Promise<void> => {
    for (const handler of requestHandlers) {
      try {
        const result = await handler(request.method, request.params);
        write({ jsonrpc: "2.0", id: request.id, result });
        return;
      } catch {
        continue;
      }
    }
    write({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: `Method not found: ${request.method}` },
    });
  };

  parseNdjsonStream(input, (value) => {
    if (isJsonRpcRequest(value)) {
      void dispatchRequest(value);
      return;
    }
    if (isJsonRpcNotification(value)) {
      for (const handler of notificationHandlers) handler(value);
      return;
    }
    if (isJsonRpcResponse(value)) {
      const entry = clearPending(value.id);
      if (!entry) return;
      if (value.error) {
        entry.reject(new Error(value.error.message));
        return;
      }
      entry.resolve(value.result);
    }
  });

  const sendRequest: RpcClient["sendRequest"] = (method, params, requestOptions) => {
    const id = nextId;
    nextId += 1;
    const request: JsonRpcRequest = params === undefined
      ? { jsonrpc: "2.0", id, method }
      : { jsonrpc: "2.0", id, method, params };
    write(request);

    return new Promise((resolve, reject) => {
      const effectiveTimeout = requestOptions?.timeoutMs === undefined
        ? timeoutMs
        : requestOptions.timeoutMs;
      const entry: PendingRequest = {
        resolve,
        reject,
        timer: null,
      };
      if (effectiveTimeout !== null && effectiveTimeout > 0) {
        entry.timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`RPC request "${method}" timed out after ${effectiveTimeout}ms`));
        }, effectiveTimeout);
      }
      pending.set(id, entry);
    });
  };

  const sendNotification: RpcClient["sendNotification"] = (method, params) => {
    const notification: JsonRpcNotification = params === undefined
      ? { jsonrpc: "2.0", method }
      : { jsonrpc: "2.0", method, params };
    write(notification);
  };

  const destroy = (): void => {
    for (const [id] of pending) clearPending(id);
    notificationHandlers.length = 0;
    requestHandlers.length = 0;
  };

  return {
    sendRequest,
    sendNotification,
    sendResponse: (id, result) => write({ jsonrpc: "2.0", id, result }),
    sendErrorResponse: (id, code, message) => write({ jsonrpc: "2.0", id, error: { code, message } }),
    onNotification: (handler) => {
      notificationHandlers.push(handler);
      return () => {
        const index = notificationHandlers.indexOf(handler);
        if (index >= 0) notificationHandlers.splice(index, 1);
      };
    },
    onRequest: (handler) => {
      requestHandlers.push(handler);
      return () => {
        const index = requestHandlers.indexOf(handler);
        if (index >= 0) requestHandlers.splice(index, 1);
      };
    },
    destroy,
  };
};
