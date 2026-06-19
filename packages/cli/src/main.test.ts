import { describe, expect, it } from "bun:test";
import {
  createAcpRoleProgressFormatter,
  createDryRunExec,
  formatAcpRoleProgress,
  formatDemoResult,
  formatDuration,
  parseGitHubRepoFromRemoteUrl,
  parseCliArgs,
  fetchLinearIssueForRun,
  runLinearWatchPreflightCli,
  runLinearWatchOnceCli,
  runWatchOnceCli,
  runRunModePreflight,
  runPublishPreflight,
  runIssueWorkspaceStatus,
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

  it("surfaces agent-write mode in run output", () => {
    const output = formatDemoResult({
      issueKey: "LIN-794",
      finalState: "merge_ready",
      artifacts: [{
        id: "policy:LIN-794:agent-write",
        kind: "execution.policy",
        source: "system",
        payload: {
          mode: "agent_write",
          fileWrites: "allowed",
          commits: "forbidden",
          pushes: "forbidden",
          shellCommands: "workspace",
        },
      }],
      timeline: [
        { label: "checker_passed -> merge_ready", elapsedMs: 1_000 },
      ],
      durationMs: 1_000,
    });

    expect(output).toContain("Mode: agent_write");
    expect(output).toContain("Final state: merge_ready");
    expect(output).toContain("Pull request: none");
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

  it("parses Linear-backed run arguments", () => {
    expect(parseCliArgs([
      "run",
      "LBE-5",
      "--linear",
      "--linear-team",
      "LBE",
      "--linear-api-key-env",
      "AIGILE_LINEAR_API_KEY",
      "--agent-write",
    ])).toEqual({
      mode: "run",
      issueKey: "LBE-5",
      linear: true,
      linearTeam: "LBE",
      linearApiKeyEnv: "AIGILE_LINEAR_API_KEY",
      agentWrite: true,
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

  it("parses status arguments", () => {
    expect(parseCliArgs([
      "status",
      "LIN-795",
      "--repo",
      "/repo/aigile",
      "--worktrees",
      "/repo/aigile/.worktrees",
      "--base-branch",
      "develop",
    ])).toEqual({
      mode: "status",
      issueKey: "LIN-795",
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      baseBranch: "develop",
    });
  });

  it("parses watch-once issue arguments", () => {
    expect(parseCliArgs([
      "watch",
      "--once",
      "--issue",
      "LIN-900",
      "--title",
      "Watcher skeleton",
      "--description",
      "Claim a ready issue.",
      "--acceptance",
      "Ready issue is claimed",
      "--claim-status",
      "aigile:claimed",
    ])).toEqual({
      mode: "watch",
      once: true,
      issueKey: "LIN-900",
      title: "Watcher skeleton",
      description: "Claim a ready issue.",
      acceptanceCriteria: ["Ready issue is claimed"],
      claimStatus: "aigile:claimed",
    });
  });

  it("parses Linear watch-once arguments", () => {
    expect(parseCliArgs([
      "watch",
      "--once",
      "--linear",
      "--linear-team",
      "ENG",
      "--ready-status",
      "Ready for Aigile",
      "--claim-status",
      "In Progress",
      "--linear-api-key-env",
      "AIGILE_LINEAR_API_KEY",
    ])).toEqual({
      mode: "watch",
      once: true,
      linear: true,
      linearTeam: "ENG",
      readyStatus: "Ready for Aigile",
      claimStatus: "In Progress",
      linearApiKeyEnv: "AIGILE_LINEAR_API_KEY",
    });
  });

  it("parses Linear watch preflight arguments without once", () => {
    expect(parseCliArgs([
      "watch",
      "--linear",
      "--preflight",
      "--linear-team",
      "ENG",
      "--linear-api-key-env",
      "AIGILE_LINEAR_API_KEY",
    ])).toEqual({
      mode: "watch",
      preflightOnly: true,
      linear: true,
      linearTeam: "ENG",
      linearApiKeyEnv: "AIGILE_LINEAR_API_KEY",
    });
  });

  it("rejects watch without an explicit once pass", () => {
    expect(() => parseCliArgs(["watch"])).toThrow(/requires --once/i);
  });

  it("runs a local watch-once claim without starting agents", async () => {
    const output = await runWatchOnceCli({
      issue: {
        id: "issue-900",
        key: "LIN-900",
        title: "Watcher skeleton",
        description: "Claim a ready issue.",
        acceptanceCriteria: ["Ready issue is claimed"],
        status: "ready",
        comments: [],
      },
    });

    expect(output).toContain("Aigile watch: once");
    expect(output).toContain("Ready issues: 1");
    expect(output).toContain("Claimed: LIN-900");
    expect(output).toContain("Status: aigile:claimed");
    expect(output).toContain("Comment: Aigile claimed this issue for local processing.");
    expect(output).toContain("Agents: not started");
  });

  it("claims one ready Linear issue without starting agents", async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];

    const output = await runLinearWatchOnceCli({
      apiKey: "test-key",
      teamKey: "ENG",
      fetchGraphql: async (query, variables) => {
        calls.push({ query, variables });
        if (query.includes("ReadyIssues")) {
          return {
            issues: {
              nodes: [{
                id: "issue-id",
                identifier: "LIN-900",
                title: "Watcher skeleton",
                description: "Acceptance:\n- Claim it",
                state: { name: "Ready for Aigile" },
                comments: { nodes: [] },
              }],
            },
          };
        }
        if (query.includes("WorkflowStateByName")) {
          return { workflowStates: { nodes: [{ id: "state-in-progress", name: "In Progress" }] } };
        }
        if (query.includes("IssueIdByKey")) {
          return { issue: { id: "issue-id" } };
        }
        if (query.includes("issueUpdate")) return {};
        if (query.includes("commentCreate")) return {};
        if (query.includes("IssueByKey")) {
          return {
            issue: {
              id: "issue-id",
              identifier: "LIN-900",
              title: "Watcher skeleton",
              description: "Acceptance:\n- Claim it",
              state: { name: "In Progress" },
              comments: { nodes: [{ body: "Aigile claimed this issue for local processing." }] },
            },
          };
        }
        throw new Error(`unexpected query: ${query}`);
      },
    });

    expect(output).toContain("Aigile watch: once");
    expect(output).toContain("Provider: linear");
    expect(output).toContain("Team: ENG");
    expect(output).toContain("Ready issues: 1");
    expect(output).toContain("Claimed: LIN-900");
    expect(output).toContain("Status: In Progress");
    expect(output).toContain("Agents: not started");
    expect(calls.map((call) => call.variables)).toEqual([
      { teamKey: "ENG", readyStatus: "Ready for Aigile", first: 1 },
      { teamKey: "ENG", name: "In Progress" },
      { key: "LIN-900" },
      { key: "issue-id", status: "state-in-progress" },
      { key: "LIN-900" },
      { key: "issue-id", body: "Aigile claimed this issue for local processing." },
      { key: "LIN-900" },
    ]);
  });

  it("preflights Linear watch teams without mutating issues", async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];

    const output = await runLinearWatchPreflightCli({
      apiKey: "test-key",
      fetchGraphql: async (query, variables) => {
        calls.push({ query, variables });
        return {
          teams: {
            nodes: [
              { key: "ENG", name: "Engineering" },
              { key: "OPS", name: "Operations" },
            ],
          },
        };
      },
    });

    expect(output).toBe([
      "Aigile watch: preflight",
      "Provider: linear",
      "Teams:",
      "- ENG (Engineering)",
      "- OPS (Operations)",
      "Agents: not started",
    ].join("\n"));
    expect(calls.map((call) => call.variables)).toEqual([{ first: 100 }]);
    expect(calls.some((call) => call.query.includes("mutation"))).toBe(false);
    expect(calls.some((call) => call.query.includes("issueUpdate"))).toBe(false);
    expect(calls.some((call) => call.query.includes("commentCreate"))).toBe(false);
  });

  it("preflights Linear watch workflow states for a selected team", async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];

    const output = await runLinearWatchPreflightCli({
      apiKey: "test-key",
      teamKey: "ENG",
      fetchGraphql: async (query, variables) => {
        calls.push({ query, variables });
        if (query.includes("LinearTeams")) {
          return {
            teams: {
              nodes: [
                { key: "ENG", name: "Engineering" },
              ],
            },
          };
        }
        if (query.includes("WorkflowStatesByTeam")) {
          return {
            workflowStates: {
              nodes: [
                { name: "Ready for Aigile" },
                { name: "In Progress" },
              ],
            },
          };
        }
        throw new Error(`unexpected query: ${query}`);
      },
    });

    expect(output).toBe([
      "Aigile watch: preflight",
      "Provider: linear",
      "Teams:",
      "- ENG (Engineering)",
      "Workflow states (ENG):",
      "- Ready for Aigile",
      "- In Progress",
      "Agents: not started",
    ].join("\n"));
    expect(calls.map((call) => call.variables)).toEqual([
      { first: 100 },
      { teamKey: "ENG", first: 100 },
    ]);
    expect(calls.some((call) => call.query.includes("mutation"))).toBe(false);
  });

  it("fetches run issue metadata from Linear", async () => {
    const issue = await fetchLinearIssueForRun({
      apiKey: "test-key",
      issueKey: "LBE-5",
      fetchGraphql: async (_query, variables) => {
        expect(variables).toEqual({ key: "LBE-5" });
        return {
          issue: {
            id: "issue-id",
            identifier: "LBE-5",
            title: "Add Linear watch preflight",
            description: "Acceptance:\n- Lists teams\n- Lists states",
            state: { name: "In Progress" },
            comments: { nodes: [] },
          },
        };
      },
    });

    expect(issue).toMatchObject({
      key: "LBE-5",
      title: "Add Linear watch preflight",
      acceptanceCriteria: ["Lists teams", "Lists states"],
      status: "In Progress",
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

  it("formats issue workspace status for dirty worktrees", async () => {
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];

    const output = await runIssueWorkspaceStatus({
      issueKey: "LIN-795",
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      baseBranch: "main",
      exec: async (command, args, options) => {
        calls.push({ command, args: [...args], cwd: options.cwd });
        if (command === "test") return { stdout: "", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "rev-parse") {
          return { stdout: "aigile/LIN-795\n", stderr: "", exitCode: 0 };
        }
        if (command === "git" && args[0] === "status") {
          return {
            stdout: " M packages/roles/src/acp-runner.ts\n?? scratch.md\n",
            stderr: "",
            exitCode: 0,
          };
        }
        throw new Error("unexpected command");
      },
    });

    expect(output).toContain("Aigile status: LIN-795");
    expect(output).toContain("Workspace: /repo/aigile/.worktrees/LIN-795");
    expect(output).toContain("Branch: aigile/LIN-795");
    expect(output).toContain("Base: main");
    expect(output).toContain("State: worktree_dirty");
    expect(output).toContain("- M packages/roles/src/acp-runner.ts");
    expect(output).toContain("- ?? scratch.md");
    expect(output).toContain("run LIN-795 --agent-write");
    expect(output).toContain("run LIN-795 --publish");
    expect(calls).toEqual([
      { command: "test", args: ["-e", "/repo/aigile/.worktrees/LIN-795"], cwd: "/repo/aigile" },
      { command: "git", args: ["rev-parse", "--abbrev-ref", "HEAD"], cwd: "/repo/aigile/.worktrees/LIN-795" },
      { command: "git", args: ["status", "--short"], cwd: "/repo/aigile/.worktrees/LIN-795" },
    ]);
  });

  it("formats issue workspace status for missing worktrees", async () => {
    const output = await runIssueWorkspaceStatus({
      issueKey: "LIN-404",
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      baseBranch: "main",
      exec: async (command) => {
        if (command === "test") return { stdout: "", stderr: "", exitCode: 1 };
        throw new Error("git should not run for missing status");
      },
    });

    expect(output).toContain("State: missing");
    expect(output).toContain("Changed files: none");
    expect(output).toContain("run LIN-404 --agent-write");
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
