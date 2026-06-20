import { describe, expect, it } from "bun:test";
import type { CodeHostAdapter } from "@aigile/adapters";
import type { DemoWorkspaceInput } from "@aigile/demo";
import type { WorkflowArtifact } from "@aigile/types";
import { loadProductConfigFromJson } from "@aigile/config";
import {
  createAcpRoleProgressFormatter,
  createDryRunExec,
  formatAcpRoleProgress,
  formatArchitectPlanComment,
  formatDemoResult,
  formatDuration,
  parseDurationMs,
  parseGitHubRepoFromRemoteUrl,
  parseCliArgs,
  fetchLinearIssueForRun,
  runLinearIssueWorkflowCli,
  runLinearWatchLoopCli,
  runLinearWatchPreflightCli,
  runLinearWatchOnceCli,
  runWatchOnceCli,
  runRunModePreflight,
  runPublishPreflight,
  runIssueWorkspaceStatus,
  resolveProductCliContext,
  selectDemoMode,
} from "./main.js";

describe("cli formatting", () => {
  it("formats architect plan comments deterministically", () => {
    expect(
      formatArchitectPlanComment({
        id: "agent:LBE-10:architect:architect.plan",
        kind: "architect.plan",
        source: "agent",
        payload: {
          summary: "Post the plan to Linear before implementation.",
          scope: ["Add a formatter", "Wire the orchestration hook"],
          acceptanceCriteria: [],
          verificationCommands: ["bun run check", "bun test packages/cli"],
          risks: [],
        },
      }),
    ).toBe(
      [
        "Aigile architect plan",
        "",
        "Summary:",
        "Post the plan to Linear before implementation.",
        "",
        "Scope:",
        "- Add a formatter",
        "- Wire the orchestration hook",
        "",
        "Acceptance criteria:",
        "- None.",
        "",
        "Verification commands:",
        "- bun run check",
        "- bun test packages/cli",
        "",
        "Risks:",
        "- None.",
      ].join("\n"),
    );
  });

  it("formats demo output for hand testing", () => {
    expect(
      formatDemoResult({
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
          reviews: [],
        },
        artifacts: [],
        timeline: [
          { label: "issue_received -> planning", elapsedMs: 0 },
          { label: "merge_completed -> merged", elapsedMs: 1250 },
        ],
        durationMs: 1250,
      }),
    ).toContain("Final state: merged");
  });

  it("formats runs that stop before pull request creation", () => {
    const output = formatDemoResult({
      issueKey: "LIN-123",
      finalState: "escalated",
      artifacts: [],
      timeline: [{ label: "checker_escalated -> escalated", elapsedMs: 1_000 }],
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
        reviews: [],
      },
      artifacts: [
        {
          id: "policy:LIN-456:dry-run",
          kind: "execution.policy",
          source: "system",
          payload: {
            mode: "dry_run",
            fileWrites: "forbidden",
            commits: "forbidden",
            shellCommands: "read_only",
          },
        },
      ],
      timeline: [
        { label: "issue_received -> planning", elapsedMs: 0 },
        { label: "merge_completed -> merged", elapsedMs: 61_200 },
      ],
      durationMs: 61_200,
    });

    expect(output).toContain("Mode: dry_run (simulated)");
    expect(output).toContain("Workflow state: merged");
    expect(output).toContain(
      "External side effects: none (workspace, GitHub, and source-of-truth updates simulated)",
    );
    expect(output).toContain("Pull request: simulated https://github.local/aigile/aigile/pull/1");
    expect(output).not.toContain("Final state: merged");
  });

  it("surfaces agent-write mode in run output", () => {
    const output = formatDemoResult({
      issueKey: "LIN-794",
      finalState: "merge_ready",
      artifacts: [
        {
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
        },
      ],
      timeline: [{ label: "checker_passed -> merge_ready", elapsedMs: 1_000 }],
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
        reviews: [],
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
        reviews: [],
      },
      artifacts: [
        {
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
        },
        {
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
        },
      ],
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

  it("parses watch poll interval durations", () => {
    expect(parseDurationMs("250ms")).toBe(250);
    expect(parseDurationMs("30s")).toBe(30_000);
    expect(parseDurationMs("2m")).toBe(120_000);
    expect(() => parseDurationMs("soon")).toThrow(/invalid duration/i);
    expect(() => parseDurationMs("0s")).toThrow(/invalid duration/i);
  });

  it("formats ACP role progress for hand testing", () => {
    expect(
      formatAcpRoleProgress({
        type: "runtime_connected",
        roleId: "architect",
        issueId: "LIN-123",
        runtimeId: "claude-acp",
        model: "runtime-default",
        acpSessionId: "acp-1",
      }),
    ).toBe("[LIN-123 architect] connected claude-acp model runtime-default session acp-1");
    expect(
      formatAcpRoleProgress({
        type: "tool_start",
        roleId: "developer",
        issueId: "LIN-123",
        runtimeId: "codex-acp",
        tool: "Bash",
      }),
    ).toBe("[LIN-123 developer] tool started: Bash");
    expect(
      formatAcpRoleProgress({
        type: "permission_decision",
        roleId: "developer",
        issueId: "LIN-123",
        runtimeId: "codex-acp",
        tool: "Bash",
        decision: "reject_once",
        description: JSON.stringify({ command: "git commit -m test" }),
      }),
    ).toBe('[LIN-123 developer] permission reject_once: Bash {"command":"git commit -m test"}');
    expect(
      formatAcpRoleProgress({
        type: "policy_violation",
        roleId: "architect",
        issueId: "LIN-123",
        runtimeId: "claude-acp",
        reason: "broad_discovery",
        detail: "find /repo/aigile -type f",
      }),
    ).toBe("[LIN-123 architect] policy violation broad_discovery: find /repo/aigile -type f");
    expect(
      formatAcpRoleProgress({
        type: "policy_violation",
        roleId: "architect",
        issueId: "LIN-123",
        runtimeId: "claude-acp",
        reason: "file_read_budget",
        detail: "6/5 Read File",
      }),
    ).toBe("[LIN-123 architect] policy violation file_read_budget: 6/5 Read File");
  });

  it("coalesces small ACP text deltas before printing progress", () => {
    const formatter = createAcpRoleProgressFormatter({ textFlushThreshold: 80 });
    const base = {
      roleId: "developer",
      issueId: "LIN-123",
      runtimeId: "codex-acp",
    };

    expect(formatter.format({ type: "text_delta", ...base, delta: '{"artifact' })).toEqual([]);
    expect(formatter.format({ type: "text_delta", ...base, delta: 'Kind":"developer' })).toEqual(
      [],
    );
    expect(formatter.format({ type: "text_delta", ...base, delta: '.attempt"' })).toEqual([]);
    expect(formatter.format({ type: "tool_start", ...base, tool: "Read File" })).toEqual([
      '[LIN-123 developer] text: {"artifactKind":"developer.attempt"',
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
    expect(formatter.flush()).toEqual(["[LIN-123 architect] text: line two"]);
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
    expect(
      parseCliArgs(["demo:agents", "--runtime-config", "config/aigile.runtimes.json"]),
    ).toEqual({
      mode: "agents",
      runtimeConfigPath: "config/aigile.runtimes.json",
    });
  });

  it("parses real run arguments", () => {
    expect(
      parseCliArgs([
        "run",
        "LIN-123",
        "--runtime-config",
        "config/aigile.runtimes.json",
        "--repo",
        "/repo/aigile",
        "--worktrees",
        "/repo/aigile/.worktrees",
        "--dry-run",
      ]),
    ).toEqual({
      mode: "run",
      issueKey: "LIN-123",
      runtimeConfigPath: "config/aigile.runtimes.json",
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      dryRun: true,
    });
  });

  it("parses Linear-backed run arguments", () => {
    expect(
      parseCliArgs([
        "run",
        "LBE-5",
        "--linear",
        "--linear-team",
        "LBE",
        "--linear-api-key-env",
        "AIGILE_LINEAR_API_KEY",
        "--agent-write",
      ]),
    ).toEqual({
      mode: "run",
      issueKey: "LBE-5",
      linear: true,
      linearTeam: "LBE",
      linearApiKeyEnv: "AIGILE_LINEAR_API_KEY",
      agentWrite: true,
    });
  });

  it("parses explicit agent-write run arguments", () => {
    expect(
      parseCliArgs([
        "run",
        "LIN-124",
        "--runtime-config",
        "config/aigile.runtimes.json",
        "--agent-write",
      ]),
    ).toEqual({
      mode: "run",
      issueKey: "LIN-124",
      runtimeConfigPath: "config/aigile.runtimes.json",
      agentWrite: true,
    });
  });

  it("rejects conflicting run execution modes", () => {
    expect(() => parseCliArgs(["run", "LIN-124", "--dry-run", "--agent-write"])).toThrow(
      /choose only one/i,
    );
  });

  it("dry-run exec treats workspace collision probes as absent", async () => {
    const exec = createDryRunExec();

    await expect(
      exec("test", ["-e", "/repo/aigile/.worktrees/LIN-456"], { cwd: "/repo/aigile" }),
    ).resolves.toMatchObject({ exitCode: 1 });
    await expect(
      exec("git", ["show-ref", "--verify", "--quiet", "refs/heads/aigile/LIN-456"], {
        cwd: "/repo/aigile",
      }),
    ).resolves.toMatchObject({ exitCode: 1 });
    await expect(
      exec(
        "git",
        [
          "worktree",
          "add",
          "-b",
          "aigile/LIN-456",
          "/repo/aigile/.worktrees/LIN-456",
          "refs/remotes/origin/main",
        ],
        { cwd: "/repo/aigile" },
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
  });

  it("parses concrete task fields for real runs", () => {
    expect(
      parseCliArgs([
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
      ]),
    ).toEqual({
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
    expect(
      parseCliArgs([
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
      ]),
    ).toEqual({
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
    expect(
      parseCliArgs([
        "status",
        "LIN-795",
        "--repo",
        "/repo/aigile",
        "--worktrees",
        "/repo/aigile/.worktrees",
        "--base-branch",
        "develop",
      ]),
    ).toEqual({
      mode: "status",
      issueKey: "LIN-795",
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      baseBranch: "develop",
    });
  });

  it("parses watch-once issue arguments", () => {
    expect(
      parseCliArgs([
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
      ]),
    ).toEqual({
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
    expect(
      parseCliArgs([
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
      ]),
    ).toEqual({
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
    expect(
      parseCliArgs([
        "watch",
        "--linear",
        "--preflight",
        "--linear-team",
        "ENG",
        "--linear-api-key-env",
        "AIGILE_LINEAR_API_KEY",
      ]),
    ).toEqual({
      mode: "watch",
      preflightOnly: true,
      linear: true,
      linearTeam: "ENG",
      linearApiKeyEnv: "AIGILE_LINEAR_API_KEY",
    });
  });

  it("parses Linear watch loop arguments without once", () => {
    expect(
      parseCliArgs([
        "watch",
        "--linear",
        "--linear-team",
        "LBE",
        "--ready-status",
        "Todo",
        "--claim-status",
        "In Progress",
        "--poll-interval",
        "30s",
        "--max-polls",
        "2",
      ]),
    ).toEqual({
      mode: "watch",
      linear: true,
      linearTeam: "LBE",
      readyStatus: "Todo",
      claimStatus: "In Progress",
      pollIntervalMs: 30_000,
      maxPolls: 2,
    });
  });

  it("parses Linear watch start-run arguments", () => {
    expect(
      parseCliArgs([
        "watch",
        "--linear",
        "--linear-team",
        "LBE",
        "--ready-status",
        "Todo",
        "--claim-status",
        "In Progress",
        "--poll-interval",
        "30s",
        "--max-polls",
        "1",
        "--start-run",
        "--runtime-config",
        "config/aigile.runtimes.example.json",
        "--repo",
        "/repo/aigile",
        "--worktrees",
        "/repo/aigile/.worktrees",
        "--agent-write",
        "--publish",
        "--github-repo",
        "lbelyaev/aigile",
        "--remote",
        "origin",
      ]),
    ).toEqual({
      mode: "watch",
      linear: true,
      linearTeam: "LBE",
      readyStatus: "Todo",
      claimStatus: "In Progress",
      pollIntervalMs: 30_000,
      maxPolls: 1,
      startRun: true,
      runtimeConfigPath: "config/aigile.runtimes.example.json",
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      agentWrite: true,
      publish: true,
      githubRepo: "lbelyaev/aigile",
      remote: "origin",
    });
  });

  it("parses product config arguments for Linear watch", () => {
    expect(
      parseCliArgs([
        "watch",
        "--linear",
        "--product",
        "aigile",
        "--products-config",
        "config/aigile.products.example.json",
        "--poll-interval",
        "30s",
      ]),
    ).toEqual({
      mode: "watch",
      linear: true,
      product: "aigile",
      productsConfigPath: "config/aigile.products.example.json",
      pollIntervalMs: 30_000,
    });
  });

  it("resolves product defaults for Linear watch runs", () => {
    const config = loadProductConfigFromJson(
      JSON.stringify({
        products: [
          {
            id: "aigile",
            linear: { team: "LBE", project: "Aigile" },
            github: { repo: "lbelyaev/aigile", baseBranch: "main" },
            defaultRun: { startRun: true, mode: "agent_write", publish: true },
          },
        ],
      }),
    );

    expect(
      resolveProductCliContext(
        parseCliArgs([
          "watch",
          "--linear",
          "--product",
          "aigile",
          "--runtime-config",
          "config/aigile.runtimes.example.json",
          "--poll-interval",
          "30s",
        ]),
        config,
        { cwd: "/repo/aigile", homeDir: "/home/test" },
      ),
    ).toEqual({
      productId: "aigile",
      linearTeam: "LBE",
      linearProject: "Aigile",
      githubRepo: "lbelyaev/aigile",
      githubOwner: "lbelyaev",
      githubRepository: "aigile",
      baseBranch: "main",
      repoPath: "/repo/aigile",
      worktreesPath: "/home/test/.aigile/worktrees/lbelyaev/aigile",
      dryRun: false,
      agentWrite: true,
      publish: true,
      startRun: true,
    });
  });

  it("reports a setup hint when the default product config file is missing", () => {
    expect(() =>
      resolveProductCliContext(
        parseCliArgs(["watch", "--linear", "--product", "aigile", "--poll-interval", "30s"]),
        undefined,
        { cwd: "/repo/aigile", homeDir: "/home/test" },
      ),
    ).toThrow(
      /product config not found: config\/aigile\.products\.json\. Pass --products-config <path> or create config\/aigile\.products\.json from config\/aigile\.products\.example\.json/,
    );
  });

  it("lets explicit CLI flags override product defaults", () => {
    const config = loadProductConfigFromJson(
      JSON.stringify({
        products: [
          {
            id: "aigile",
            linear: { team: "LBE", project: "Aigile" },
            github: { repo: "lbelyaev/aigile", baseBranch: "main" },
            repoPath: "/configured/repo",
            worktreesPath: "/configured/worktrees",
            defaultRun: { startRun: true, mode: "agent_write", publish: true },
          },
        ],
      }),
    );

    expect(
      resolveProductCliContext(
        parseCliArgs([
          "watch",
          "--linear",
          "--product",
          "aigile",
          "--linear-team",
          "OPS",
          "--github-repo",
          "acme/project",
          "--base-branch",
          "develop",
          "--repo",
          "/override/repo",
          "--worktrees",
          "/override/worktrees",
          "--dry-run",
          "--poll-interval",
          "30s",
        ]),
        config,
        { cwd: "/repo/aigile", homeDir: "/home/test" },
      ),
    ).toMatchObject({
      productId: "aigile",
      linearTeam: "OPS",
      githubRepo: "acme/project",
      githubOwner: "acme",
      githubRepository: "project",
      baseBranch: "develop",
      repoPath: "/override/repo",
      worktreesPath: "/override/worktrees",
      dryRun: true,
      agentWrite: false,
      publish: true,
      startRun: true,
    });
  });

  it("rejects watch without an explicit once pass", () => {
    expect(() => parseCliArgs(["watch"])).toThrow(/requires --once or --poll-interval/i);
  });

  it("rejects invalid watch loop bounds", () => {
    expect(() =>
      parseCliArgs([
        "watch",
        "--linear",
        "--linear-team",
        "LBE",
        "--poll-interval",
        "30s",
        "--max-polls",
        "never",
      ]),
    ).toThrow(/--max-polls must be a positive integer/i);
  });

  it("rejects start-run without runtime config or execution mode", () => {
    expect(() =>
      parseCliArgs([
        "watch",
        "--linear",
        "--linear-team",
        "LBE",
        "--poll-interval",
        "30s",
        "--start-run",
      ]),
    ).toThrow(/requires --runtime-config/i);
    expect(() =>
      parseCliArgs([
        "watch",
        "--linear",
        "--linear-team",
        "LBE",
        "--poll-interval",
        "30s",
        "--start-run",
        "--runtime-config",
        "config/aigile.runtimes.example.json",
      ]),
    ).toThrow(/requires --dry-run or --agent-write/i);
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
              nodes: [
                {
                  id: "issue-id",
                  identifier: "LIN-900",
                  title: "Watcher skeleton",
                  description: "Acceptance:\n- Claim it",
                  state: { name: "Ready for Aigile" },
                  comments: { nodes: [] },
                },
              ],
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
      { teamKey: "ENG", readyStatus: "Ready for Aigile", first: 25 },
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

    expect(output).toBe(
      [
        "Aigile watch: preflight",
        "Provider: linear",
        "Teams:",
        "- ENG (Engineering)",
        "- OPS (Operations)",
        "Agents: not started",
      ].join("\n"),
    );
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
              nodes: [{ key: "ENG", name: "Engineering" }],
            },
          };
        }
        if (query.includes("WorkflowStatesByTeam")) {
          return {
            workflowStates: {
              nodes: [{ name: "Ready for Aigile" }, { name: "In Progress" }],
            },
          };
        }
        throw new Error(`unexpected query: ${query}`);
      },
    });

    expect(output).toBe(
      [
        "Aigile watch: preflight",
        "Provider: linear",
        "Teams:",
        "- ENG (Engineering)",
        "Workflow states (ENG):",
        "- Ready for Aigile",
        "- In Progress",
        "Agents: not started",
      ].join("\n"),
    );
    expect(calls.map((call) => call.variables)).toEqual([
      { first: 100 },
      { teamKey: "ENG", first: 100 },
    ]);
    expect(calls.some((call) => call.query.includes("mutation"))).toBe(false);
  });

  it("runs a bounded Linear watch loop in the foreground", async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];

    const output = await runLinearWatchLoopCli({
      apiKey: "test-key",
      teamKey: "LBE",
      readyStatus: "Todo",
      claimStatus: "In Progress",
      pollIntervalMs: 1,
      maxPolls: 2,
      sleep: async () => {},
      fetchGraphql: async (query, variables) => {
        calls.push({ query, variables });
        if (query.includes("ReadyIssues")) {
          return {
            issues: {
              nodes: [
                {
                  id: "issue-id",
                  identifier: "LBE-5",
                  title: "Add Linear watch preflight",
                  description: "Acceptance:\n- It runs",
                  state: { name: "Todo" },
                  comments: { nodes: [] },
                },
              ],
            },
          };
        }
        if (query.includes("WorkflowStateByName")) {
          return { workflowStates: { nodes: [{ id: "state-in-progress", name: "In Progress" }] } };
        }
        if (query.includes("IssueIdByKey")) return { issue: { id: "issue-id" } };
        if (query.includes("issueUpdate")) return {};
        if (query.includes("commentCreate")) return {};
        return {
          issue: {
            id: "issue-id",
            identifier: "LBE-5",
            title: "Add Linear watch preflight",
            description: "Acceptance:\n- It runs",
            state: { name: "In Progress" },
            comments: { nodes: [{ body: "Aigile claimed this issue for local processing." }] },
          },
        };
      },
    });

    expect(output).toContain("Aigile watch: loop");
    expect(output).toContain("Provider: linear");
    expect(output).toContain("Team: LBE");
    expect(output).toContain("Poll interval: 1ms");
    expect(output).toContain("Polling for ready issues...");
    expect(output).not.toContain("checking for ready issues");
    expect(output).toContain("Poll 1: claimed LBE-5 (ready issues: 1)");
    expect(output).not.toContain("idle (ready issues: 0)");
    expect(output).toContain("Stopped: max_polls after 2 polls");
    expect(output).toContain("Agents: not started");
    expect(calls.filter((call) => call.query.includes("issueUpdate"))).toHaveLength(1);
    expect(calls.filter((call) => call.query.includes("commentCreate"))).toHaveLength(1);
  });

  it("starts a run after claiming an issue when requested", async () => {
    const startedIssueKeys: string[] = [];

    const output = await runLinearWatchLoopCli({
      apiKey: "test-key",
      teamKey: "LBE",
      readyStatus: "Todo",
      claimStatus: "In Progress",
      pollIntervalMs: 1,
      maxPolls: 1,
      sleep: async () => {},
      startRun: async (issue) => {
        startedIssueKeys.push(issue.key);
        return [
          `Aigile demo run: ${issue.key}`,
          "Mode: agent_write",
          "Final state: merge_ready",
        ].join("\n");
      },
      fetchGraphql: async (query) => {
        if (query.includes("ReadyIssues")) {
          return {
            issues: {
              nodes: [
                {
                  id: "issue-id",
                  identifier: "LBE-6",
                  title: "Start Linear-claimed issues automatically",
                  description: "Acceptance:\n- Starts run",
                  state: { name: "Todo" },
                  comments: { nodes: [] },
                },
              ],
            },
          };
        }
        if (query.includes("WorkflowStateByName")) {
          return { workflowStates: { nodes: [{ id: "state-in-progress", name: "In Progress" }] } };
        }
        if (query.includes("IssueIdByKey")) return { issue: { id: "issue-id" } };
        if (query.includes("issueUpdate")) return {};
        if (query.includes("commentCreate")) return {};
        return {
          issue: {
            id: "issue-id",
            identifier: "LBE-6",
            title: "Start Linear-claimed issues automatically",
            description: "Acceptance:\n- Starts run",
            state: { name: "In Progress" },
            comments: { nodes: [{ body: "Aigile claimed this issue for local processing." }] },
          },
        };
      },
    });

    expect(startedIssueKeys).toEqual(["LBE-6"]);
    expect(output).toContain("Poll 1: claimed LBE-6 (ready issues: 1)");
    expect(output).toContain("Run LBE-6: starting");
    expect(output).toContain("Run LBE-6: Final state: merge_ready");
    expect(output).toContain("Run LBE-6: completed");
    expect(output).toContain("Agents: handled claimed issues");
  });

  it("restores claimed Linear issues and reports run start failures", async () => {
    const statusUpdates: unknown[] = [];

    const output = await runLinearWatchLoopCli({
      apiKey: "test-key",
      teamKey: "LBE",
      readyStatus: "Todo",
      claimStatus: "In Progress",
      pollIntervalMs: 1,
      maxPolls: 1,
      sleep: async () => {},
      startRun: async () => {
        throw new Error("Issue branch aigile/LBE-18 is stale relative to origin/main");
      },
      fetchGraphql: async (query, variables) => {
        if (query.includes("ReadyIssues")) {
          return {
            issues: {
              nodes: [
                {
                  id: "issue-id",
                  identifier: "LBE-18",
                  title: "Infer product route",
                  description: "Acceptance:\n- Routes from ticket metadata",
                  state: { name: "Todo" },
                  comments: { nodes: [] },
                },
              ],
            },
          };
        }
        if (query.includes("WorkflowStateByName")) {
          return {
            workflowStates: {
              nodes: [
                {
                  id:
                    typeof variables?.name === "string" && variables.name === "Todo"
                      ? "state-todo"
                      : "state-in-progress",
                  name: variables?.name,
                },
              ],
            },
          };
        }
        if (query.includes("IssueIdByKey")) return { issue: { id: "issue-id" } };
        if (query.includes("issueUpdate")) {
          statusUpdates.push(variables);
          return {};
        }
        if (query.includes("commentCreate")) return {};
        return {};
      },
    });

    expect(output).toContain("Poll 1: claimed LBE-18 (ready issues: 1)");
    expect(output).toContain("Run LBE-18: starting");
    expect(output).toContain(
      "Poll 1: run failed for LBE-18; restored status to Todo: Issue branch aigile/LBE-18 is stale relative to origin/main",
    );
    expect(output).toContain("Agents: handled claimed issues");
    expect(statusUpdates).toHaveLength(2);
    expect(statusUpdates.at(-1)).toMatchObject({ status: "state-todo" });
  });

  it("prints product and GitHub repo when product-backed watch starts a run", async () => {
    const startedIssueKeys: string[] = [];

    const output = await runLinearWatchLoopCli({
      apiKey: "test-key",
      teamKey: "LBE",
      productId: "aigile",
      linearProject: "Aigile",
      githubRepo: "lbelyaev/aigile",
      readyStatus: "Todo",
      claimStatus: "In Progress",
      pollIntervalMs: 1,
      maxPolls: 1,
      sleep: async () => {},
      startRun: async (issue) => {
        startedIssueKeys.push(issue.key);
        return [`Aigile demo run: ${issue.key}`, "Final state: merge_ready"].join("\n");
      },
      fetchGraphql: async (query) => {
        if (query.includes("ReadyIssues")) {
          return {
            issues: {
              nodes: [
                {
                  id: "issue-id",
                  identifier: "LBE-13",
                  title: "Add product config",
                  description: "Acceptance:\n- Starts run",
                  state: { name: "Todo" },
                  project: { id: "project-aigile", name: "Aigile" },
                  comments: { nodes: [] },
                },
              ],
            },
          };
        }
        if (query.includes("WorkflowStateByName")) {
          return { workflowStates: { nodes: [{ id: "state-in-progress", name: "In Progress" }] } };
        }
        if (query.includes("IssueIdByKey")) return { issue: { id: "issue-id" } };
        if (query.includes("issueUpdate")) return {};
        if (query.includes("commentCreate")) return {};
        return {
          issue: {
            id: "issue-id",
            identifier: "LBE-13",
            title: "Add product config",
            description: "Acceptance:\n- Starts run",
            state: { name: "In Progress" },
            project: { id: "project-aigile", name: "Aigile" },
            comments: { nodes: [{ body: "Aigile claimed this issue for local processing." }] },
          },
        };
      },
    });

    expect(startedIssueKeys).toEqual(["LBE-13"]);
    expect(output).toContain("Product: aigile");
    expect(output).toContain("Project: Aigile");
    expect(output).toContain("GitHub repo: lbelyaev/aigile");
    expect(output).toContain("Run LBE-13: starting");
    expect(output).toContain("Agents: handled claimed issues");
  });

  it("skips product-backed Linear watch issues outside the configured project", async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];

    const output = await runLinearWatchLoopCli({
      apiKey: "test-key",
      teamKey: "LBE",
      productId: "aigile",
      linearProject: "Aigile",
      githubRepo: "lbelyaev/aigile",
      readyStatus: "Todo",
      claimStatus: "In Progress",
      pollIntervalMs: 1,
      maxPolls: 1,
      sleep: async () => {},
      fetchGraphql: async (query, variables) => {
        calls.push({ query, variables });
        if (query.includes("ReadyIssues")) {
          return {
            issues: {
              nodes: [
                {
                  id: "issue-id",
                  identifier: "LBE-14",
                  title: "Other product issue",
                  description: "Acceptance:\n- Skip",
                  state: { name: "Todo" },
                  project: { id: "other-project", name: "Other Project" },
                  comments: { nodes: [] },
                },
              ],
            },
          };
        }
        throw new Error(`unexpected query: ${query}`);
      },
    });

    expect(output).toContain("Product: aigile");
    expect(output).toContain("Project: Aigile");
    expect(output).toContain("GitHub repo: lbelyaev/aigile");
    expect(output).toContain("Polling for ready issues...");
    expect(output).toContain("Poll 1: skipped LBE-14 (project_mismatch)");
    expect(output).not.toContain("idle (ready issues: 0)");
    expect(output).toContain("Agents: not started");
    expect(calls.filter((call) => call.query.includes("issueUpdate"))).toHaveLength(0);
    expect(calls.filter((call) => call.query.includes("commentCreate"))).toHaveLength(0);
  });

  it("passes publish options into Linear issue workflow runs", async () => {
    let capturedInput: DemoWorkspaceInput | undefined;
    const codeHost: CodeHostAdapter = {
      createPullRequest: async (input) => ({
        ...input,
        id: `${input.owner}/${input.repo}#1`,
        number: 1,
        url: `https://github.local/${input.owner}/${input.repo}/pull/1`,
        comments: [],
        checks: [],
        reviews: [],
      }),
      getPullRequest: async () => {
        throw new Error("getPullRequest should not be called");
      },
      getPullRequestMergeability: async () => ({ status: "mergeable" }),
      getPullRequestMergeState: async () => ({ status: "unmerged" }),
      appendPullRequestComment: async () => {},
      submitPullRequestReview: async () => {},
      recordCheckResult: async () => {},
    };

    const output = await runLinearIssueWorkflowCli({
      apiKey: "test-key",
      issueKey: "LBE-6",
      teamKey: "LBE",
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      runtimeConfigPath: "config/aigile.runtimes.example.json",
      agentWrite: true,
      publish: true,
      remote: "origin",
      pullRequestTarget: { owner: "lbelyaev", repo: "aigile", baseBranch: "main" },
      codeHost,
      verification: {
        install: [["bun", "install", "--frozen-lockfile"]],
        checks: [["bun", "run", "check"]],
        changedFileGuards: [
          {
            whenAnyChanged: ["package.json", "packages/*/package.json"],
            mustAlsoChange: ["bun.lock"],
          },
        ],
      },
      fetchGraphql: async (query) => {
        if (query.includes("WorkflowStateByName")) {
          return { workflowStates: { nodes: [{ id: "state-done", name: "Done" }] } };
        }
        if (query.includes("issueUpdate")) return {};
        if (query.includes("commentCreate")) return {};
        return {
          issue: {
            id: "issue-id",
            identifier: "LBE-6",
            title: "Start Linear-claimed issues automatically",
            description: "Acceptance:\n- Starts run",
            state: { name: "In Progress" },
            comments: { nodes: [] },
          },
        };
      },
      runWorkspace: async (input) => {
        capturedInput = input;
        return {
          issueKey: input.issue.key,
          finalState: "merged",
          pullRequest: await codeHost.createPullRequest({
            owner: input.pullRequestTarget?.owner ?? "missing",
            repo: input.pullRequestTarget?.repo ?? "missing",
            branch: "aigile/LBE-6",
            baseBranch: input.pullRequestTarget?.baseBranch ?? "main",
            title: "LBE-6 Start Linear-claimed issues automatically",
            body: "Demo PR",
          }),
          artifacts: [],
          timeline: [],
          durationMs: 0,
        };
      },
    });

    expect(capturedInput).toMatchObject({
      publish: true,
      remote: "origin",
      pullRequestTarget: { owner: "lbelyaev", repo: "aigile", baseBranch: "main" },
      verificationCommands: [
        ["bun", "install", "--frozen-lockfile"],
        ["bun", "run", "check"],
      ],
      changedFileGuards: [
        {
          whenAnyChanged: ["package.json", "packages/*/package.json"],
          mustAlsoChange: ["bun.lock"],
        },
      ],
    });
    expect(capturedInput?.createPullRequest).toBeUndefined();
    expect(capturedInput?.codeHost).toBe(codeHost);
    expect(output).toContain("Pull request: https://github.local/lbelyaev/aigile/pull/1");
  });

  it("syncs already satisfied Linear runs to Done with evidence", async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];

    const output = await runLinearIssueWorkflowCli({
      apiKey: "test-key",
      issueKey: "LBE-6",
      teamKey: "LBE",
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      runtimeConfigPath: "config/aigile.runtimes.example.json",
      agentWrite: true,
      fetchGraphql: async (query, variables) => {
        calls.push({ query, variables });
        if (query.includes("IssueByKey")) {
          return {
            issue: {
              id: "issue-id",
              identifier: "LBE-6",
              title: "Start Linear-claimed issues automatically",
              description: "Acceptance:\n- Starts run",
              state: { name: "In Progress" },
              comments: { nodes: [] },
            },
          };
        }
        if (query.includes("WorkflowStateByName")) {
          return { workflowStates: { nodes: [{ id: "state-done", name: "Done" }] } };
        }
        if (query.includes("IssueIdByKey")) return { issue: { id: "issue-id" } };
        if (query.includes("issueUpdate")) return {};
        if (query.includes("commentCreate")) return {};
        throw new Error(`unexpected query: ${query}`);
      },
      runWorkspace: async (input) => ({
        issueKey: input.issue.key,
        finalState: "satisfied",
        artifacts: [
          {
            id: "verifier:LBE-6:local",
            kind: "verification.result",
            source: "verifier",
            payload: { status: "passed", commands: [] },
          },
          {
            id: "agent:LBE-6:checker:checker.verdict",
            kind: "checker.verdict",
            source: "agent",
            payload: {
              verdict: "pass",
              summary: "Existing implementation satisfies the issue.",
              reasons: ["No code changes required"],
            },
          },
        ],
        timeline: [{ label: "work_satisfied -> satisfied", elapsedMs: 1 }],
        durationMs: 1,
      }),
    });

    expect(output).toContain("Final state: satisfied");
    expect(calls.map((call) => call.variables)).toEqual([
      { key: "LBE-6" },
      { teamKey: "LBE", name: "Done" },
      { key: "LBE-6" },
      { key: "issue-id", status: "state-done" },
      { key: "LBE-6" },
      {
        key: "issue-id",
        body: [
          "Aigile verified this issue is already satisfied. No code changes were required.",
          "",
          "Final state: satisfied",
          "Verification: verifier:LBE-6:local",
          "Checker: agent:LBE-6:checker:checker.verdict",
        ].join("\n"),
      },
    ]);
  });

  it("syncs published Linear runs to Done with pull request evidence", async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const codeHost: CodeHostAdapter = {
      createPullRequest: async () => {
        throw new Error("createPullRequest should not be called");
      },
      getPullRequest: async () => {
        throw new Error("getPullRequest should not be called");
      },
      getPullRequestMergeability: async () => ({ status: "mergeable" }),
      getPullRequestMergeState: async () => ({ status: "merged" }),
      appendPullRequestComment: async () => {},
      submitPullRequestReview: async () => {},
      recordCheckResult: async () => {},
    };

    const output = await runLinearIssueWorkflowCli({
      apiKey: "test-key",
      issueKey: "LBE-7",
      teamKey: "LBE",
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      runtimeConfigPath: "config/aigile.runtimes.example.json",
      agentWrite: true,
      publish: true,
      codeHost,
      fetchGraphql: async (query, variables) => {
        calls.push({ query, variables });
        if (query.includes("IssueByKey")) {
          return {
            issue: {
              id: "issue-id",
              identifier: "LBE-7",
              title: "Avoid duplicate Linear claim comments",
              description: "Acceptance:\n- Avoid duplicate comments",
              state: { name: "In Progress" },
              comments: { nodes: [] },
            },
          };
        }
        if (query.includes("WorkflowStateByName")) {
          return { workflowStates: { nodes: [{ id: "state-done", name: "Done" }] } };
        }
        if (query.includes("IssueIdByKey")) return { issue: { id: "issue-id" } };
        if (query.includes("issueUpdate")) return {};
        if (query.includes("commentCreate")) return {};
        throw new Error(`unexpected query: ${query}`);
      },
      runWorkspace: async (input) => ({
        issueKey: input.issue.key,
        finalState: "merged",
        pullRequest: {
          id: "lbelyaev/aigile#2",
          number: 2,
          url: "https://github.com/lbelyaev/aigile/pull/2",
          owner: "lbelyaev",
          repo: "aigile",
          branch: "aigile/LBE-7",
          baseBranch: "main",
          title: "LBE-7 Avoid duplicate Linear claim comments",
          body: "Demo PR",
          comments: [],
          checks: [],
          reviews: [],
        },
        artifacts: [
          {
            id: "verifier:LBE-7:local",
            kind: "verification.result",
            source: "verifier",
            payload: { status: "passed", commands: [] },
          },
          {
            id: "agent:LBE-7:checker:checker.verdict",
            kind: "checker.verdict",
            source: "agent",
            payload: {
              verdict: "pass",
              summary: "Change is verified.",
              reasons: ["Tests pass"],
            },
          },
        ],
        timeline: [{ label: "merge_completed -> merged", elapsedMs: 1 }],
        durationMs: 1,
      }),
    });

    expect(output).toContain("Final state: merged");
    expect(output).toContain("Pull request: https://github.com/lbelyaev/aigile/pull/2");
    expect(calls.map((call) => call.variables)).toEqual([
      { key: "LBE-7" },
      { teamKey: "LBE", name: "Done" },
      { key: "LBE-7" },
      { key: "issue-id", status: "state-done" },
      { key: "LBE-7" },
      {
        key: "issue-id",
        body: [
          "Aigile completed this issue and published the result to GitHub.",
          "",
          "Final state: merged",
          "Pull request: https://github.com/lbelyaev/aigile/pull/2",
          "Verification: verifier:LBE-7:local",
          "Checker: agent:LBE-7:checker:checker.verdict",
        ].join("\n"),
      },
    ]);
  });

  it("does not mark published Linear runs Done when pull requests have conflicts", async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const codeHost: CodeHostAdapter = {
      createPullRequest: async () => {
        throw new Error("createPullRequest should not be called");
      },
      getPullRequest: async () => {
        throw new Error("getPullRequest should not be called");
      },
      getPullRequestMergeability: async () => ({ status: "conflicting" }),
      getPullRequestMergeState: async () => ({ status: "unmerged" }),
      appendPullRequestComment: async () => {},
      submitPullRequestReview: async () => {},
      recordCheckResult: async () => {},
    };

    const output = await runLinearIssueWorkflowCli({
      apiKey: "test-key",
      issueKey: "LBE-8",
      teamKey: "LBE",
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      runtimeConfigPath: "config/aigile.runtimes.example.json",
      agentWrite: true,
      publish: true,
      codeHost,
      fetchGraphql: async (query, variables) => {
        calls.push({ query, variables });
        if (query.includes("IssueByKey")) {
          return {
            issue: {
              id: "issue-id",
              identifier: "LBE-8",
              title: "Detect PR merge conflicts",
              description: "Acceptance:\n- Do not mark Done on conflicts",
              state: { name: "In Progress" },
              comments: { nodes: [] },
            },
          };
        }
        if (query.includes("IssueIdByKey")) return { issue: { id: "issue-id" } };
        if (query.includes("commentCreate")) return {};
        throw new Error(`unexpected query: ${query}`);
      },
      runWorkspace: async (input) => ({
        issueKey: input.issue.key,
        finalState: "merged",
        pullRequest: {
          id: "lbelyaev/aigile#8",
          number: 8,
          url: "https://github.com/lbelyaev/aigile/pull/8",
          owner: "lbelyaev",
          repo: "aigile",
          branch: "aigile/LBE-8",
          baseBranch: "main",
          title: "LBE-8 Detect PR merge conflicts",
          body: "Demo PR",
          comments: [],
          checks: [],
          reviews: [],
        },
        artifacts: [],
        timeline: [{ label: "merge_completed -> merged", elapsedMs: 1 }],
        durationMs: 1,
      }),
    });

    expect(output).toContain("Final state: escalated");
    expect(output).toContain("Pull request: https://github.com/lbelyaev/aigile/pull/8");
    expect(calls.some((call) => call.query.includes("issueUpdate"))).toBe(false);
    expect(calls.map((call) => call.variables)).toEqual([
      { key: "LBE-8" },
      { key: "LBE-8" },
      {
        key: "issue-id",
        body: [
          "Aigile published this issue to GitHub, but the pull request is blocked and was not marked done.",
          "",
          "Outcome: blocked/escalated",
          "Reason: pull request has merge conflicts",
          "Pull request: https://github.com/lbelyaev/aigile/pull/8",
          "Verification: unavailable",
          "Checker: unavailable",
        ].join("\n"),
      },
    ]);
  });

  it("does not mark published Linear runs Done when pull request mergeability is unknown", async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const codeHost: CodeHostAdapter = {
      createPullRequest: async () => {
        throw new Error("createPullRequest should not be called");
      },
      getPullRequest: async () => {
        throw new Error("getPullRequest should not be called");
      },
      getPullRequestMergeability: async () => ({ status: "unknown" }),
      getPullRequestMergeState: async () => ({ status: "unmerged" }),
      appendPullRequestComment: async () => {},
      submitPullRequestReview: async () => {},
      recordCheckResult: async () => {},
    };

    await runLinearIssueWorkflowCli({
      apiKey: "test-key",
      issueKey: "LBE-9",
      teamKey: "LBE",
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      runtimeConfigPath: "config/aigile.runtimes.example.json",
      agentWrite: true,
      publish: true,
      codeHost,
      fetchGraphql: async (query, variables) => {
        calls.push({ query, variables });
        if (query.includes("IssueByKey")) {
          return {
            issue: {
              id: "issue-id",
              identifier: "LBE-9",
              title: "Unknown mergeability",
              description: "Acceptance:\n- Block unknown",
              state: { name: "In Progress" },
              comments: { nodes: [] },
            },
          };
        }
        if (query.includes("IssueIdByKey")) return { issue: { id: "issue-id" } };
        if (query.includes("commentCreate")) return {};
        throw new Error(`unexpected query: ${query}`);
      },
      runWorkspace: async (input) => ({
        issueKey: input.issue.key,
        finalState: "merged",
        pullRequest: {
          id: "lbelyaev/aigile#9",
          number: 9,
          url: "https://github.com/lbelyaev/aigile/pull/9",
          owner: "lbelyaev",
          repo: "aigile",
          branch: "aigile/LBE-9",
          baseBranch: "main",
          title: "LBE-9 Unknown mergeability",
          body: "Demo PR",
          comments: [],
          checks: [],
          reviews: [],
        },
        artifacts: [],
        timeline: [{ label: "merge_completed -> merged", elapsedMs: 1 }],
        durationMs: 1,
      }),
    });

    expect(calls.some((call) => call.query.includes("issueUpdate"))).toBe(false);
    expect(calls.at(-1)?.variables).toMatchObject({
      body: expect.stringContaining("Reason: pull request mergeability is unknown"),
    });
  });

  it("does not sync dry-run terminal results to Linear", async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];

    await runLinearIssueWorkflowCli({
      apiKey: "test-key",
      issueKey: "LBE-8",
      teamKey: "LBE",
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      runtimeConfigPath: "config/aigile.runtimes.example.json",
      dryRun: true,
      fetchGraphql: async (query, variables) => {
        calls.push({ query, variables });
        return {
          issue: {
            id: "issue-id",
            identifier: "LBE-8",
            title: "Dry run",
            description: "Acceptance:\n- Simulate",
            state: { name: "In Progress" },
            comments: { nodes: [] },
          },
        };
      },
      runWorkspace: async (input) => ({
        issueKey: input.issue.key,
        finalState: "satisfied",
        artifacts: [],
        timeline: [],
        durationMs: 0,
      }),
    });

    expect(calls.map((call) => call.variables)).toEqual([{ key: "LBE-8" }]);
  });

  it("posts the Linear architect plan before developer artifacts in real runs", async () => {
    const events: string[] = [];
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const plan: WorkflowArtifact = {
      id: "agent:LBE-10:architect:architect.plan",
      kind: "architect.plan",
      source: "agent",
      payload: {
        summary: "Publish the architect plan.",
        scope: ["format comment", "post comment"],
        acceptanceCriteria: ["comment exists before development"],
        verificationCommands: ["bun run check"],
        risks: ["Linear mutation can fail"],
      },
    };

    const output = await runLinearIssueWorkflowCli({
      apiKey: "test-key",
      issueKey: "LBE-10",
      teamKey: "LBE",
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      runtimeConfigPath: "config/aigile.runtimes.example.json",
      agentWrite: true,
      fetchGraphql: async (query, variables) => {
        calls.push({ query, variables });
        if (query.includes("commentCreate")) events.push("commentCreate");
        if (query.includes("IssueIdByKey")) return { issue: { id: "issue-id" } };
        if (query.includes("commentCreate")) return {};
        return {
          issue: {
            id: "issue-id",
            identifier: "LBE-10",
            title: "Publish architect plans back to Linear",
            description: "Acceptance:\n- Plan comment exists",
            state: { name: "In Progress" },
            comments: { nodes: [] },
          },
        };
      },
      runWorkspace: async (input) => {
        events.push("architect.plan");
        await input.publishPlan?.(plan);
        events.push("developer.attempt");
        return {
          issueKey: input.issue.key,
          finalState: "developing",
          artifacts: [
            plan,
            {
              id: "agent:LBE-10:developer:developer.attempt",
              kind: "developer.attempt",
              source: "agent",
              payload: {
                summary: "Attempt",
                changedFiles: ["packages/cli/src/main.ts"],
                verificationNotes: "Not verified.",
              },
            },
          ],
          timeline: [],
          durationMs: 0,
        };
      },
    });

    expect(output).toContain("Final state: developing");
    expect(events).toEqual(["architect.plan", "commentCreate", "developer.attempt"]);
    expect(calls.map((call) => call.variables)).toContainEqual({
      key: "issue-id",
      body: formatArchitectPlanComment(plan),
    });
  });

  it("prints the architect plan in dry-run without mutating Linear", async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const progressLines: string[] = [];
    const plan: WorkflowArtifact = {
      id: "agent:LBE-10:architect:architect.plan",
      kind: "architect.plan",
      source: "agent",
      payload: {
        summary: "Dry-run plan is visible.",
        scope: [],
        acceptanceCriteria: [],
        verificationCommands: [],
        risks: [],
      },
    };

    const output = await runLinearIssueWorkflowCli({
      apiKey: "test-key",
      issueKey: "LBE-10",
      teamKey: "LBE",
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      runtimeConfigPath: "config/aigile.runtimes.example.json",
      dryRun: true,
      onProgressLine: (line) => progressLines.push(line),
      fetchGraphql: async (query, variables) => {
        calls.push({ query, variables });
        return {
          issue: {
            id: "issue-id",
            identifier: "LBE-10",
            title: "Publish architect plans back to Linear",
            description: "Acceptance:\n- Plan comment exists",
            state: { name: "In Progress" },
            comments: { nodes: [] },
          },
        };
      },
      runWorkspace: async (input) => {
        await input.publishPlan?.(plan);
        return {
          issueKey: input.issue.key,
          finalState: "developing",
          artifacts: [plan],
          timeline: [],
          durationMs: 0,
        };
      },
    });

    expect(calls.map((call) => call.variables)).toEqual([{ key: "LBE-10" }]);
    expect(output).toContain("Dry-run plan is visible.");
    expect(progressLines.join("\n")).toContain("Dry-run plan is visible.");
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
    expect(parseGitHubRepoFromRemoteUrl("git@github.com:lbelyaev/aigile.git")).toBe(
      "lbelyaev/aigile",
    );
    expect(parseGitHubRepoFromRemoteUrl("https://github.com/lbelyaev/aigile.git")).toBe(
      "lbelyaev/aigile",
    );
    expect(parseGitHubRepoFromRemoteUrl("ssh://git@github.com/lbelyaev/aigile.git")).toBe(
      "lbelyaev/aigile",
    );
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
        if (command === "git" && args[0] === "show-ref")
          return { stdout: "", stderr: "", exitCode: 1 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    expect(output).toContain("Aigile preflight: LIN-789");
    expect(output).toContain(
      "Workspace: available /repo/aigile/.worktrees/LIN-789 on aigile/LIN-789 from develop",
    );
    expect(output).toContain("Publish: ready acme/project via upstream -> develop");
    expect(output).toContain("Agents: not started");
    expect(calls).toEqual([
      { command: "git", args: ["fetch", "upstream", "develop"], cwd: "/repo/aigile" },
      {
        command: "git",
        args: ["rev-parse", "--verify", "refs/remotes/upstream/develop"],
        cwd: "/repo/aigile",
      },
      {
        command: "git",
        args: ["rev-parse", "--verify", "refs/heads/develop"],
        cwd: "/repo/aigile",
      },
      {
        command: "git",
        args: [
          "merge-base",
          "--is-ancestor",
          "refs/heads/develop",
          "refs/remotes/upstream/develop",
        ],
        cwd: "/repo/aigile",
      },
      { command: "test", args: ["-e", "/repo/aigile/.worktrees/LIN-789"], cwd: "/repo/aigile" },
      {
        command: "git",
        args: ["show-ref", "--verify", "--quiet", "refs/heads/aigile/LIN-789"],
        cwd: "/repo/aigile",
      },
      { command: "gh", args: ["auth", "status"], cwd: "/repo/aigile" },
      { command: "git", args: ["remote", "get-url", "upstream"], cwd: "/repo/aigile" },
      {
        command: "gh",
        args: ["repo", "view", "acme/project", "--json", "name"],
        cwd: "/repo/aigile",
      },
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
        if (command === "git" && args[0] === "show-ref")
          return { stdout: "", stderr: "", exitCode: 1 };
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

  it("fails run preflight before agents when the local base diverged from the remote base", async () => {
    await expect(
      runRunModePreflight({
        issueKey: "LIN-790",
        repoPath: "/repo/aigile",
        worktreesPath: "/repo/aigile/.worktrees",
        remote: "origin",
        baseBranch: "main",
        exec: async (command, args) => {
          if (command === "git" && args[0] === "fetch")
            return { stdout: "", stderr: "", exitCode: 0 };
          if (command === "git" && args[0] === "rev-parse")
            return { stdout: "sha\n", stderr: "", exitCode: 0 };
          if (command === "git" && args[0] === "merge-base")
            return { stdout: "", stderr: "", exitCode: 1 };
          throw new Error("workspace availability should stop before collision checks");
        },
      }),
    ).rejects.toThrow(
      "Base branch main cannot be fast-forwarded to origin/main; synchronize or reset the local base branch before starting Aigile.",
    );
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
      {
        command: "git",
        args: ["rev-parse", "--abbrev-ref", "HEAD"],
        cwd: "/repo/aigile/.worktrees/LIN-795",
      },
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
      {
        command: "gh",
        args: ["repo", "view", "acme/project", "--json", "name"],
        cwd: "/repo/aigile",
      },
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
    await expect(
      runPublishPreflight({
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
      }),
    ).rejects.toThrow(/publish preflight gh auth status failed \(1\): not logged in/i);
  });
});
