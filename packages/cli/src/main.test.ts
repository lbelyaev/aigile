import { describe, expect, it } from "bun:test";
import {
  createDryRunExec,
  formatAcpRoleProgress,
  formatDemoResult,
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
      timeline: ["issue_received -> planning", "merge_completed -> merged"],
    })).toContain("Final state: merged");
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
      timeline: ["issue_received -> planning", "merge_completed -> merged"],
    });

    expect(output).toContain("Mode: dry_run (simulated)");
    expect(output).toContain("Pull request: simulated https://github.local/aigile/aigile/pull/1");
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
      { command: "gh", args: ["repo", "view", "acme/project", "--json", "name"], cwd: "/repo/aigile" },
      { command: "git", args: ["remote", "get-url", "upstream"], cwd: "/repo/aigile" },
      { command: "git", args: ["rev-parse", "--verify", "develop"], cwd: "/repo/aigile" },
    ]);
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
      { command: "gh", args: ["repo", "view", "acme/project", "--json", "name"], cwd: "/repo/aigile" },
      { command: "git", args: ["remote", "get-url", "upstream"], cwd: "/repo/aigile" },
      { command: "git", args: ["rev-parse", "--verify", "develop"], cwd: "/repo/aigile" },
    ]);
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
