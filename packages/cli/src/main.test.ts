import { describe, expect, it } from "bun:test";
import { formatAcpRoleProgress, formatDemoResult, parseCliArgs, selectDemoMode } from "./main.js";

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

  it("formats ACP role progress for hand testing", () => {
    expect(formatAcpRoleProgress({
      type: "runtime_connected",
      roleId: "architect",
      issueId: "LIN-123",
      runtimeId: "claude-acp",
      acpSessionId: "acp-1",
    })).toBe("[LIN-123 architect] connected claude-acp session acp-1");
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
      githubRepo: "acme/project",
      remote: "upstream",
      baseBranch: "develop",
    });
  });
});
