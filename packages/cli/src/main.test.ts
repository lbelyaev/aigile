import { describe, expect, it } from "bun:test";
import {
  createAcpRoleProgressFormatter,
  createDryRunExec,
  formatAcpRoleProgress,
  formatDemoResult,
  formatDuration,
  parseGitHubRepoFromRemoteUrl,
  parseCliArgs,
  runRunModePreflight,
  runPublishPreflight,
  selectDemoMode,
} from "./main.js";

describe("cli formatting", () => {
  it("formats demo output for hand testing", () => {
    expect(formatDemoResult({
      issueKey: "LIN-123",
      finalState: "merged",
      pullRequest: {
        id: "aigile/aigile#1",
        number: 1,
        url: "https://github.local/aigile/aigile/pull/1",
        owner: "aigile",
        repo: "aigile",
        branch: "aigile/LIN-123",
        baseBranch: "main",
        title: "LIN-123 Build hand-testable pipeline",
        body: "Demo PR",
        comments: [],
        checks: [],
      },
      artifacts: [],
      timeline: [
        { label: "issue_received -> planning", elapsedMs: 0 },
        { label: "merge_completed -> merged", elapsedMs: 1250 },
      ],
      durationMs: 1250,
    })).toContain("Final state: merged");
  });

  it("formats runs that stop before pull request creation", () => {
    const output = formatDemoResult({
      issueKey: "LIN-123",
      finalState: "escalated",
      artifacts: [],
      timeline: [
        { label: "checker_escalated -> escalated", elapsedMs: 1_000 },
      ],
      durationMs: 1_000,
    });

    expect(output).toContain("Final state: escalated");
    expect(output).toContain("Pull request: none");
  });

  it("labels dry-run demo output as simulated", () => {
    const output = formatDemoResult({
      issueKey: "LIN-456",
      finalState: "merged",
      pullRequest: {
        id: "aigile/aigile#1",
        number: 1,
        url: "https://github.local/aigile/aigile/pull/1",
        owner: "aigile",
        repo: "aigile",
        branch: "aigile/LIN-456",
        baseBranch: "main",
        title: "LIN-456 Dry run",
        body: "Demo PR",
        comments: [],
        checks: [],
      },
      artifacts: [{
        id: "policy:LIN-456:dry-run",
        kind: "execution.policy",
        source: "system",
        payload: {
          mode: "dry_run",
          fileWrites: "forbidden",
          commits: "forbidden",
          shellCommands: "read_only",
        },
      }],
      timeline: [
        { label: "issue_received -> planning", elapsedMs: 0 },
        { label: "merge_completed -> merged", elapsedMs: 61_200 },
      ],
      durationMs: 61_200,
    });

    expect(output).toContain("Mode: dry_run (simulated)");
    expect(output).toContain("Workflow state: merged");
    expect(output).toContain("External side effects: none (workspace, GitHub, and source-of-truth updates simulated)");
    expect(output).toContain("Pull request: simulated https://github.local/aigile/aigile/pull/1");
    expect(output).not.toContain("Final state: merged");
  });

  it("formats timeline durations and unavailable token usage", () => {
    const output = formatDemoResult({
      issueKey: "LIN-123",
      finalState: "merged",
      pullRequest: {
        id: "aigile/aigile#1",
        number: 1,
        url: "https://github.local/aigile/aigile/pull/1",
        owner: "aigile",
        repo: "aigile",
        branch: "aigile/LIN-123",
        baseBranch: "main",
        title: "LIN-123 Timed run",
        body: "Demo PR",
        comments: [],
        checks: [],
      },
      artifacts: [],
      timeline: [
        { label: "issue_received -> planning", elapsedMs: 0 },
        { label: "plan_drafted -> awaiting_plan_approval", elapsedMs: 42_100 },
        { label: "merge_completed -> merged", elapsedMs: 1_250 },
      ],
      durationMs: 43_350,
    });

    expect(output).toContain("- issue_received -> planning (+0 seconds)");
    expect(output).toContain("- plan_drafted -> awaiting_plan_approval (+42 seconds)");
    expect(output).toContain("- merge_completed -> merged (+1 second)");
    expect(output).toContain("Duration: 43 seconds");
    expect(output).toContain("Token usage: unavailable");
  });

  it("formats aggregate token usage when runtime provenance includes it", () => {
    const output = formatDemoResult({
      issueKey: "LIN-123",
      finalState: "merged",
      pullRequest: {
        id: "aigile/aigile#1",
        number: 1,
        url: "https://github.local/aigile/aigile/pull/1",
        owner: "aigile",
        repo: "aigile",
        branch: "aigile/LIN-123",
        baseBranch: "main",
        title: "LIN-123 Usage run",
        body: "Demo PR",
        comments: [],
        checks: [],
      },
      artifacts: [{
        id: "agent:LIN-123:architect:architect.plan",
        kind: "architect.plan",
        source: "agent",
        producerRoleId: "architect",
        provenance: {
          runtime: {
            runtimeId: "claude-acp",
            transport: "stdio",
            model: "runtime-default",
            tokenUsage: {
              inputTokens: 1200,
              outputTokens: 500,
              totalTokens: 999_999,
            },
          },
        },
        payload: {},
      }, {
        id: "agent:LIN-123:developer:developer.attempt",
        kind: "developer.attempt",
        source: "agent",
        producerRoleId: "developer",
        provenance: {
          runtime: {
            runtimeId: "codex-acp",
            transport: "stdio",
            model: "runtime-default",
            tokenUsage: {
              inputTokens: 300,
              outputTokens: 100,
            },
          },
        },
        payload: {},
      }],
      timeline: [],
      durationMs: 0,
    });

    expect(output).toContain("Token usage: 2,100 total (1,500 input, 600 output)");
  });

  it("humanizes durations for operator output", () => {
    expect(formatDuration(0)).toBe("0 seconds");
    expect(formatDuration(999)).toBe("1 second");
    expect(formatDuration(1_250)).toBe("1 second");
    expect(formatDuration(42_100)).toBe("42 seconds");
    expect(formatDuration(61_200)).toBe("1 minute");
  });

  it("formats ACP role progress for hand testing", () => {
    expect(formatAcpRoleProgress({
      type: "runtime_connected",
      roleId: "architect",
      issueId: "LIN-123",
      runtimeId: "claude-acp",
      model: "runtime-default",
      acpSessionId: "acp-1",
    })).toBe("[LIN-123 architect] connected claude-acp model runtime-default session acp-1");
    expect(formatAcpRoleProgress({
      type: "tool_start",
      roleId: "developer",
      issueId: "LIN-123",
      runtimeId: "codex-acp",
      tool: "Bash",
    })).toBe("[LIN-123 developer] tool started: Bash");
    expect(formatAcpRoleProgress({
      type: "permission_decision",
      roleId: "developer",
      issueId: "LIN-123",
      runtimeId: "codex-acp",
      tool: "Bash",
      decision: "reject_once",
      description: JSON.stringify({ command: "git commit -m test" }),
    })).toBe("[LIN-123 developer] permission reject_once: Bash {\"command\":\"git commit -m test\"}");
    expect(formatAcpRoleProgress({
      type: "policy_violation",
      roleId: "architect",
      issueId: "LIN-123",
      runtimeId: "claude-acp",
      reason: "broad_discovery",
      detail: "find /repo/aigile -type f",
    })).toBe("[LIN-123 architect] policy violation broad_discovery: find /repo/aigile -type f");
    expect(formatAcpRoleProgress({
      type: "policy_violation",
      roleId: "architect",
      issueId: "LIN-123",
      runtimeId: "claude-acp",
      reason: "file_read_budget",
      detail: "6/5 Read File",
    })).toBe("[LIN-123 architect] policy violation file_read_budget: 6/5 Read File");
  });

  it("coalesces small ACP text deltas before printing progress", () => {
    const formatter = createAcpRoleProgressFormatter({ textFlushThreshold: 80 });
    const base = {
      roleId: "developer",
      issueId: "LIN-123",
      runtimeId: "codex-acp",
    };

    expect(formatter.format({ type: "text_delta", ...base, delta: "{\"artifact" })).toEqual([]);
    expect(formatter.format({ type: "text_delta", ...base, delta: "Kind\":\"developer" })).toEqual([]);
    expect(formatter.format({ type: "text_delta", ...base, delta: ".attempt\"" })).toEqual([]);
    expect(formatter.format({ type: "tool_start", ...base, tool: "Read File" })).toEqual([
      "[LIN-123 developer] text: {\"artifactKind\":\"developer.attempt\"",
      "[LIN-123 developer] tool started: Read File",
    ]);
  });

  it("flushes ACP text deltas at newlines and on final flush", () => {
    const formatter = createAcpRoleProgressFormatter({ textFlushThreshold: 80 });
    const base = {
      roleId: "architect",
      issueId: "LIN-123",
      runtimeId: "claude-acp",
    };

    expect(formatter.format({ type: "text_delta", ...base, delta: "line one\nline two" })).toEqual([
      "[LIN-123 architect] text: line one",
    ]);
    expect(formatter.flush()).toEqual([
      "[LIN-123 architect] text: line two",
    ]);
    expect(formatter.flush()).toEqual([]);
  });

  it("selects the ACP-agent demo mode from argv", () => {
    expect(selectDemoMode(["demo:agents"])).toBe("agents");
    expect(selectDemoMode(["demo:workspace"])).toBe("workspace");
    expect(selectDemoMode(["demo:github"])).toBe("github");
    expect(selectDemoMode(["demo:linear"])).toBe("linear");
    expect(selectDemoMode([])).toBe("scripted");
  });

  it("parses runtime config path from argv", () => {
    expect(parseCliArgs(["demo:agents", "--runtime-config", "config/aigile.runtimes.json"])).toEqual({
      mode: "agents",
      runtimeConfigPath: "config/aigile.runtimes.json",
    });
  });

  it("parses real run arguments", () => {
    expect(parseCliArgs([
      "run",
      "LIN-123",
      "--runtime-config",
      "config/aigile.runtimes.json",
      "--repo",
      "/repo/aigile",
      "--worktrees",
      "/repo/aigile/.worktrees",
      "--dry-run",
    ])).toEqual({
      mode: "run",
      issueKey: "LIN-123",
      runtimeConfigPath: "config/aigile.runtimes.json",
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      dryRun: true,
    });
  });

  it("parses explicit agent-write run arguments", () => {
    expect(parseCliArgs([
      "run",
      "LIN-124",
      "--runtime-config",
      "config/aigile.runtimes.json",
      "--agent-write",
    ])).toEqual({
      mode: "run",
      issueKey: "LIN-124",
      runtimeConfigPath: "config/aigile.runtimes.json",
      agentWrite: true,
    });
  });

  it("rejects conflicting run execution modes", () => {
    expect(() => parseCliArgs([
      "run",
      "LIN-124",
      "--dry-run",
      "--agent-write",
    ])).toThrow(/choose only one/i);
  });

  it("dry-run exec treats workspace collision probes as absent", async () => {
    const exec = createDryRunExec();

    await expect(exec("test", ["-e", "/repo/aigile/.worktrees/LIN-456"], { cwd: "/repo/aigile" }))
      .resolves.toMatchObject({ exitCode: 1 });
    await expect(exec("git", ["show-ref", "--verify", "--quiet", "refs/heads/aigile/LIN-456"], { cwd: "/repo/aigile" }))
      .resolves.toMatchObject({ exitCode: 1 });
    await expect(exec("git", ["worktree", "add", "-b", "aigile/LIN-456", "/repo/aigile/.worktrees/LIN-456", "main"], { cwd: "/repo/aigile" }))
      .resolves.toMatchObject({ exitCode: 0 });
  });

  it("parses concrete task fields for real runs", () => {
    expect(parseCliArgs([
      "run",
      "LIN-456",
      "--title",
      "Bound ACP role runs",
      "--description",
      "Keep live agent hand tests focused.",
      "--acceptance",
      "Architect returns a plan without broad repo discovery",
      "--acceptance",
      "CLI streams role progress",
    ])).toEqual({
      mode: "run",
      issueKey: "LIN-456",
      title: "Bound ACP role runs",
      description: "Keep live agent hand tests focused.",
      acceptanceCriteria: [
        "Architect returns a plan without broad repo discovery",
        "CLI streams role progress",
      ],
    });
  });

  it("parses publish arguments for real runs", () => {
    expect(parseCliArgs([
      "run",
      "LIN-789",
      "--publish",
      "--preflight-only",
      "--github-repo",
      "acme/project",
      "--remote",
      "upstream",
      "--base-branch",
      "develop",
    ])).toEqual({
      mode: "run",
      issueKey: "LIN-789",
      publish: true,
      preflightOnly: true,
      githubRepo: "acme/project",
      remote: "upstream",
      baseBranch: "develop",
    });
  });

  it("infers GitHub repos from common remote URL forms", () => {
    expect(parseGitHubRepoFromRemoteUrl("git@github.com:lbelyaev/aigile.git")).toBe("lbelyaev/aigile");
    expect(parseGitHubRepoFromRemoteUrl("https://github.com/lbelyaev/aigile.git")).toBe("lbelyaev/aigile");
    expect(parseGitHubRepoFromRemoteUrl("ssh://git@github.com/lbelyaev/aigile.git")).toBe("lbelyaev/aigile");
    expect(parseGitHubRepoFromRemoteUrl("git@gitlab.com:lbelyaev/aigile.git")).toBeUndefined();
  });

  it("preflights run mode without starting agents", async () => {
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];

    const output = await runRunModePreflight({
      issueKey: "LIN-789",
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      githubRepo: "acme/project",
      publish: true,
      remote: "upstream",
      baseBranch: "develop",
      exec: async (command, args, options) => {
        calls.push({ command, args: [...args], cwd: options.cwd });
        if (command === "test") return { stdout: "", stderr: "", exitCode: 1 };
        if (command === "git" && args[0] === "show-ref") return { stdout: "", stderr: "", exitCode: 1 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    expect(output).toContain("Aigile preflight: LIN-789");
    expect(output).toContain("Workspace: available /repo/aigile/.worktrees/LIN-789 on aigile/LIN-789 from develop");
    expect(output).toContain("Publish: ready acme/project via upstream -> develop");
    expect(output).toContain("Agents: not started");
    expect(calls).toEqual([
      { command: "test", args: ["-e", "/repo/aigile/.worktrees/LIN-789"], cwd: "/repo/aigile" },
      { command: "git", args: ["show-ref", "--verify", "--quiet", "refs/heads/aigile/LIN-789"], cwd: "/repo/aigile" },
      { command: "gh", args: ["auth", "status"], cwd: "/repo/aigile" },
      { command: "git", args: ["remote", "get-url", "upstream"], cwd: "/repo/aigile" },
      { command: "gh", args: ["repo", "view", "acme/project", "--json", "name"], cwd: "/repo/aigile" },
      { command: "git", args: ["rev-parse", "--verify", "develop"], cwd: "/repo/aigile" },
    ]);
  });

  it("preflights publish by inferring github repo from the remote", async () => {
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];

    const output = await runRunModePreflight({
      issueKey: "LIN-789",
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      publish: true,
      remote: "origin",
      baseBranch: "main",
      exec: async (command, args, options) => {
        calls.push({ command, args: [...args], cwd: options.cwd });
        if (command === "test") return { stdout: "", stderr: "", exitCode: 1 };
        if (command === "git" && args[0] === "show-ref") return { stdout: "", stderr: "", exitCode: 1 };
        if (command === "git" && args[0] === "remote") {
          return { stdout: "git@github.com:lbelyaev/aigile.git\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    expect(output).toContain("Publish: ready lbelyaev/aigile via origin -> main");
    expect(calls).toContainEqual({
      command: "gh",
      args: ["repo", "view", "lbelyaev/aigile", "--json", "name"],
      cwd: "/repo/aigile",
    });
  });

  it("preflights real publish dependencies before live role work", async () => {
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];

    await runPublishPreflight({
      repoPath: "/repo/aigile",
      githubRepo: "acme/project",
      remote: "upstream",
      baseBranch: "develop",
      exec: async (command, args, options) => {
        calls.push({ command, args: [...args], cwd: options.cwd });
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    expect(calls).toEqual([
      { command: "gh", args: ["auth", "status"], cwd: "/repo/aigile" },
      { command: "git", args: ["remote", "get-url", "upstream"], cwd: "/repo/aigile" },
      { command: "gh", args: ["repo", "view", "acme/project", "--json", "name"], cwd: "/repo/aigile" },
      { command: "git", args: ["rev-parse", "--verify", "develop"], cwd: "/repo/aigile" },
    ]);
  });

  it("returns the inferred github repo from publish preflight", async () => {
    const result = await runPublishPreflight({
      repoPath: "/repo/aigile",
      remote: "origin",
      baseBranch: "main",
      exec: async (command, args) => {
        if (command === "git" && args[0] === "remote") {
          return { stdout: "https://github.com/lbelyaev/aigile.git\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    expect(result.githubRepo).toBe("lbelyaev/aigile");
  });

  it("fails publish preflight with the failing command context", async () => {
    await expect(runPublishPreflight({
      repoPath: "/repo/aigile",
      githubRepo: "acme/project",
      remote: "origin",
      baseBranch: "main",
      exec: async (command, args) => {
        if (command === "gh" && args[0] === "auth") {
          return { stdout: "", stderr: "not logged in", exitCode: 1 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    })).rejects.toThrow(/publish preflight gh auth status failed \(1\): not logged in/i);
  });
});
