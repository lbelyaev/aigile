import { describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";
import {
  connectAcpRuntime,
  createAcpProcess,
  type AcpChildProcess,
  type SpawnAcpProcess,
} from "./index.js";

const collectWrites = (stream: PassThrough): string[] => {
  const writes: string[] = [];
  stream.on("data", (chunk: Buffer) => writes.push(chunk.toString()));
  return writes;
};

const createMockSpawn = (): {
  spawn: SpawnAcpProcess;
  stdout: PassThrough;
  stdin: PassThrough;
  stderr: PassThrough;
  child: AcpChildProcess;
  killSignals: NodeJS.Signals[];
} => {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const stderr = new PassThrough();
  const exitHandlers: Array<(code: number | null) => void> = [];
  const killSignals: NodeJS.Signals[] = [];
  const child: AcpChildProcess = {
    stdin,
    stdout,
    stderr,
    kill: (signal = "SIGTERM") => {
      killSignals.push(signal);
      for (const handler of exitHandlers) handler(0);
      return true;
    },
    once: (event, handler) => {
      if (event === "close") exitHandlers.push(handler);
      return child;
    },
    on: (event, handler) => {
      if (event === "close") exitHandlers.push(handler);
      return child;
    },
  };
  return {
    spawn: () => child,
    stdout,
    stdin,
    stderr,
    child,
    killSignals,
  };
};

const createStubbornMockSpawn = (): ReturnType<typeof createMockSpawn> => {
  const mock = createMockSpawn();
  mock.child.kill = (signal = "SIGTERM") => {
    mock.killSignals.push(signal);
    return true;
  };
  return mock;
};

describe("ACP process connector", () => {
  it("spawns a runtime process and sends initialize", async () => {
    const mock = createMockSpawn();
    const writes = collectWrites(mock.stdin);
    const process = createAcpProcess(["agent-acp", "--stdio"], {
      spawnProcess: mock.spawn,
      cwd: "/tmp/workspace",
      env: { AIGILE: "1" },
    });

    const initialized = process.rpc.sendRequest("initialize", { client: "aigile" });
    expect(JSON.parse(writes[0]!.trim())).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { client: "aigile" },
    });

    mock.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: 1 },
    }) + "\n");

    await expect(initialized).resolves.toEqual({ protocolVersion: 1 });
    expect(process.isAlive()).toBe(true);
    await process.kill();
    expect(process.isAlive()).toBe(false);
  });

  it("connects to a runtime and creates an ACP session", async () => {
    const mock = createMockSpawn();
    const writes = collectWrites(mock.stdin);

    const connectedPromise = connectAcpRuntime({
      command: ["agent-acp"],
      cwd: "/repo",
      spawnProcess: mock.spawn,
      initializeParams: { client: "aigile" },
      sessionParams: { cwd: "/repo", mcpServers: [] },
      sessionId: "role-session-1",
    });

    expect(JSON.parse(writes[0]!.trim())).toMatchObject({
      id: 1,
      method: "initialize",
    });
    mock.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }) + "\n");

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(writes[1]!.trim())).toMatchObject({
      id: 2,
      method: "session/new",
      params: { cwd: "/repo", mcpServers: [] },
    });
    mock.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { sessionId: "acp-session-1" },
    }) + "\n");

    const connected = await connectedPromise;
    expect(connected.session.sessionId).toBe("role-session-1");
    expect(connected.session.acpSessionId).toBe("acp-session-1");

    await connected.process.kill();
  });

  it("escalates process shutdown when a runtime ignores SIGTERM", async () => {
    const mock = createStubbornMockSpawn();
    const process = createAcpProcess(["agent-acp"], {
      spawnProcess: mock.spawn,
      killGraceMs: 1,
    });

    const result = await Promise.race([
      process.kill().then(() => "resolved"),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 20)),
    ]);

    expect(result).toBe("resolved");
    expect(mock.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(process.isAlive()).toBe(false);
  });
});
