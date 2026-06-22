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
  calls: Array<{
    command: string;
    args: readonly string[];
    options: Parameters<SpawnAcpProcess>[2];
  }>;
} => {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const stderr = new PassThrough();
  const exitHandlers: Array<(code: number | null) => void> = [];
  const killSignals: NodeJS.Signals[] = [];
  const calls: Array<{
    command: string;
    args: readonly string[];
    options: Parameters<SpawnAcpProcess>[2];
  }> = [];
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
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return child;
    },
    stdout,
    stdin,
    stderr,
    child,
    killSignals,
    calls,
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
  it("allowlists the spawned agent environment", async () => {
    const originalPath = process.env.PATH;
    const originalHome = process.env.HOME;
    const originalUser = process.env.USER;
    const originalLogname = process.env.LOGNAME;
    const originalShell = process.env.SHELL;
    const originalTmpdir = process.env.TMPDIR;
    const originalTmp = process.env.TMP;
    const originalTemp = process.env.TEMP;
    const originalRuntimeAllowed = process.env.RUNTIME_ALLOWED;
    const originalSentinelSecret = process.env.SENTINEL_SECRET;
    const originalUndeclaredParent = process.env.UNDECLARED_PARENT;
    try {
      process.env.PATH = "/parent-path";
      process.env.HOME = "/parent-home";
      process.env.USER = "parent-user";
      process.env.LOGNAME = "parent-logname";
      process.env.SHELL = "/bin/zsh";
      process.env.TMPDIR = "/tmp/parent";
      process.env.TMP = "/tmp/parent-tmp";
      process.env.TEMP = "/tmp/parent-temp";
      process.env.RUNTIME_ALLOWED = "runtime";
      process.env.SENTINEL_SECRET = "secret";
      process.env.UNDECLARED_PARENT = "inherited";

      const mock = createMockSpawn();
      const processHandle = createAcpProcess(["agent-acp"], {
        spawnProcess: mock.spawn,
        envPassthrough: ["RUNTIME_ALLOWED", "MISSING_ALLOWED"],
        env: { AIGILE: "1", PATH: "/explicit-path" },
      });

      expect(mock.calls).toHaveLength(1);
      expect(mock.calls[0]!.options.env).toEqual({
        PATH: "/explicit-path",
        HOME: "/parent-home",
        USER: "parent-user",
        LOGNAME: "parent-logname",
        SHELL: "/bin/zsh",
        TMPDIR: "/tmp/parent",
        TMP: "/tmp/parent-tmp",
        TEMP: "/tmp/parent-temp",
        RUNTIME_ALLOWED: "runtime",
        AIGILE: "1",
      });
      expect(mock.calls[0]!.options.env).not.toHaveProperty("SENTINEL_SECRET");
      expect(mock.calls[0]!.options.env).not.toHaveProperty("UNDECLARED_PARENT");
      expect(mock.calls[0]!.options.env).not.toHaveProperty("MISSING_ALLOWED");

      await processHandle.kill();
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUser === undefined) delete process.env.USER;
      else process.env.USER = originalUser;
      if (originalLogname === undefined) delete process.env.LOGNAME;
      else process.env.LOGNAME = originalLogname;
      if (originalShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = originalShell;
      if (originalTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpdir;
      if (originalTmp === undefined) delete process.env.TMP;
      else process.env.TMP = originalTmp;
      if (originalTemp === undefined) delete process.env.TEMP;
      else process.env.TEMP = originalTemp;
      if (originalRuntimeAllowed === undefined) delete process.env.RUNTIME_ALLOWED;
      else process.env.RUNTIME_ALLOWED = originalRuntimeAllowed;
      if (originalSentinelSecret === undefined) delete process.env.SENTINEL_SECRET;
      else process.env.SENTINEL_SECRET = originalSentinelSecret;
      if (originalUndeclaredParent === undefined) delete process.env.UNDECLARED_PARENT;
      else process.env.UNDECLARED_PARENT = originalUndeclaredParent;
    }
  });

  it("omits undefined allowlisted parent environment values", async () => {
    const originalPath = process.env.PATH;
    const originalHome = process.env.HOME;
    const originalUser = process.env.USER;
    const originalLogname = process.env.LOGNAME;
    const originalShell = process.env.SHELL;
    const originalTmpdir = process.env.TMPDIR;
    const originalTmp = process.env.TMP;
    const originalTemp = process.env.TEMP;
    try {
      delete process.env.PATH;
      delete process.env.HOME;
      delete process.env.USER;
      delete process.env.LOGNAME;
      delete process.env.SHELL;
      delete process.env.TMPDIR;
      delete process.env.TMP;
      delete process.env.TEMP;

      const mock = createMockSpawn();
      const processHandle = createAcpProcess(["agent-acp"], {
        spawnProcess: mock.spawn,
      });

      expect(mock.calls[0]!.options.env).toEqual({});

      await processHandle.kill();
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUser === undefined) delete process.env.USER;
      else process.env.USER = originalUser;
      if (originalLogname === undefined) delete process.env.LOGNAME;
      else process.env.LOGNAME = originalLogname;
      if (originalShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = originalShell;
      if (originalTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpdir;
      if (originalTmp === undefined) delete process.env.TMP;
      else process.env.TMP = originalTmp;
      if (originalTemp === undefined) delete process.env.TEMP;
      else process.env.TEMP = originalTemp;
    }
  });

  it("passes configured agent auth environment through to spawned runtimes", async () => {
    const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
    const originalCodexHome = process.env.CODEX_HOME;
    const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    try {
      process.env.OPENAI_API_KEY = "openai-key";
      process.env.CODEX_HOME = "/tmp/codex-home";
      process.env.CLAUDE_CONFIG_DIR = "/tmp/claude";
      process.env.XDG_CONFIG_HOME = "/tmp/xdg-config";

      const mock = createMockSpawn();
      const processHandle = createAcpProcess(["agent-acp"], {
        spawnProcess: mock.spawn,
        envPassthrough: ["OPENAI_API_KEY", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME"],
      });

      expect(mock.calls[0]!.options.env).toMatchObject({
        OPENAI_API_KEY: "openai-key",
        CODEX_HOME: "/tmp/codex-home",
        CLAUDE_CONFIG_DIR: "/tmp/claude",
        XDG_CONFIG_HOME: "/tmp/xdg-config",
      });

      await processHandle.kill();
    } finally {
      if (originalOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAiApiKey;
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
      if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
      if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
  });

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

    mock.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: 1 },
      }) + "\n",
    );

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
    mock.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { sessionId: "acp-session-1" },
      }) + "\n",
    );

    const connected = await connectedPromise;
    expect(connected.session.sessionId).toBe("role-session-1");
    expect(connected.session.acpSessionId).toBe("acp-session-1");

    await connected.process.kill();
  });

  it("kills the spawned process when initialize rejects during connect", async () => {
    const mock = createMockSpawn();
    const writes = collectWrites(mock.stdin);

    const connectedPromise = connectAcpRuntime({
      command: ["agent-acp"],
      spawnProcess: mock.spawn,
      initializeParams: { client: "aigile" },
      sessionParams: { cwd: "/repo", mcpServers: [] },
      sessionId: "role-session-1",
    });

    expect(JSON.parse(writes[0]!.trim())).toMatchObject({
      id: 1,
      method: "initialize",
    });
    mock.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: "initialize failed" },
      }) + "\n",
    );

    await expect(connectedPromise).rejects.toThrow("initialize failed");
    expect(mock.killSignals).toEqual(["SIGTERM"]);
  });

  it("kills the spawned process when session creation rejects during connect", async () => {
    const mock = createMockSpawn();
    const writes = collectWrites(mock.stdin);

    const connectedPromise = connectAcpRuntime({
      command: ["agent-acp"],
      spawnProcess: mock.spawn,
      initializeParams: { client: "aigile" },
      sessionParams: { cwd: "/repo", mcpServers: [] },
      sessionId: "role-session-1",
    });

    mock.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }) + "\n");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(writes[1]!.trim())).toMatchObject({
      id: 2,
      method: "session/new",
    });
    mock.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        error: { code: -32000, message: "session failed" },
      }) + "\n",
    );

    await expect(connectedPromise).rejects.toThrow("session failed");
    expect(mock.killSignals).toEqual(["SIGTERM"]);
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
