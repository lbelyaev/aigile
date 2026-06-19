import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { createAcpSession, type AcpSession } from "./session.js";
import { createRpcClient, type RpcClient } from "./rpc.js";

export interface AcpChildProcess {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  kill: (signal?: NodeJS.Signals) => boolean;
  once: (event: "close", handler: (code: number | null) => void) => AcpChildProcess;
  on: (event: "close", handler: (code: number | null) => void) => AcpChildProcess;
}

export type SpawnAcpProcess = (
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdio: ["pipe", "pipe", "pipe"];
  },
) => AcpChildProcess;

export interface AcpProcess {
  rpc: RpcClient;
  child: AcpChildProcess;
  isAlive: () => boolean;
  kill: () => Promise<void>;
}

export interface CreateAcpProcessOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  killGraceMs?: number;
  spawnProcess?: SpawnAcpProcess;
  forwardStderr?: (chunk: string) => void;
}

export interface ConnectedAcpRuntime {
  process: AcpProcess;
  session: AcpSession;
  initializeResult: unknown;
}

export interface ConnectAcpRuntimeInput extends CreateAcpProcessOptions {
  command: readonly [string, ...string[]];
  initializeParams?: unknown;
  sessionParams: Record<string, unknown>;
  sessionId: string;
}

const defaultSpawnProcess: SpawnAcpProcess = (command, args, options) =>
  spawn(command, args, options) as AcpChildProcess;

const requirePipe = <T>(value: T | null, name: string): T => {
  if (value === null) throw new Error(`ACP process missing ${name} pipe`);
  return value;
};

export const createAcpProcess = (
  command: readonly [string, ...string[]],
  options: CreateAcpProcessOptions = {},
): AcpProcess => {
  const [binary, ...args] = command;
  const spawnOptions: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdio: ["pipe", "pipe", "pipe"];
  } = { stdio: ["pipe", "pipe", "pipe"] };
  if (options.cwd !== undefined) spawnOptions.cwd = options.cwd;
  spawnOptions.env = options.env ? { ...process.env, ...options.env } : process.env;

  const child = (options.spawnProcess ?? defaultSpawnProcess)(binary, args, {
    ...spawnOptions,
  });
  let alive = true;

  child.on("close", () => {
    alive = false;
  });

  const stderr = child.stderr;
  if (stderr) {
    stderr.on("data", (chunk: Buffer | string) => {
      options.forwardStderr?.(chunk.toString());
    });
  }

  const rpcOptions: { timeoutMs?: number } = {};
  if (options.timeoutMs !== undefined) rpcOptions.timeoutMs = options.timeoutMs;
  const rpc = createRpcClient(requirePipe(child.stdout, "stdout"), requirePipe(child.stdin, "stdin"), rpcOptions);

  const kill = async (): Promise<void> => {
    if (!alive) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once("close", settle);
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!alive || settled) return;
        child.kill("SIGKILL");
        settle();
      }, options.killGraceMs ?? 2_000);
    });
    alive = false;
    rpc.destroy();
  };

  return {
    rpc,
    child,
    isAlive: () => alive,
    kill,
  };
};

const extractSessionId = (result: unknown): string => {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("ACP session/new did not return an object");
  }
  const sessionId = (result as { sessionId?: unknown }).sessionId;
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    throw new Error("ACP session/new did not return a sessionId");
  }
  return sessionId;
};

export const connectAcpRuntime = async (
  input: ConnectAcpRuntimeInput,
): Promise<ConnectedAcpRuntime> => {
  const processHandle = createAcpProcess(input.command, input);
  const initializeResult = await processHandle.rpc.sendRequest(
    "initialize",
    input.initializeParams ?? {},
  );
  const sessionResult = await processHandle.rpc.sendRequest("session/new", input.sessionParams);
  const session = createAcpSession(processHandle.rpc, {
    sessionId: input.sessionId,
    acpSessionId: extractSessionId(sessionResult),
  });

  return {
    process: processHandle,
    session,
    initializeResult,
  };
};
