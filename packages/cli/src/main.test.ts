import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  createFakeCodeHostAdapter,
  createFakeIssueTrackerAdapter,
  type CodeHostAdapter,
} from "@aigile/adapters";
import type { DemoWorkspaceInput } from "@aigile/demo";
import type { WorkflowArtifact, WorkflowEvent } from "@aigile/types";
import { createFileRunStore, createInMemoryRunStore } from "@aigile/workflow";
import { loadProductConfigFromJson } from "@aigile/config";
import {
  createAcpRoleProgressFormatter,
  createDryRunExec,
  formatAcpRoleProgress,
  formatArchitectPlanComment,
  formatDaemonStartupSummary,
  formatDeepReviewProgress,
  formatDisplayEvent,
  formatDemoResult,
  formatDuration,
  formatIssueWorkspaceStatus,
  formatReconcileProductsResult,
  runCli,
  parseDurationMs,
  parseGitHubRepoFromRemoteUrl,
  parseCliArgs,
  resolveRuntimeConfigPath,
  fetchLinearIssueForRun,
  runLinearIssueWorkflowCli,
  runLinearDaemonSupervisorCli,
  runLinearWatchLoopCli,
  runLinearWatchPreflightCli,
  runLinearWatchOnceCli,
  runReconcileProductsCli,
  runInitCli,
  runWatchOnceCli,
  runRunModePreflight,
  runPublishPreflight,
  runIssueWorkspaceStatus,
  runWorkflowRunStatus,
  resolveProductCliContext,
  resolveProductCliContexts,
  selectDemoMode,
  stripAnsi,
} from "./main.js";

describe("cli formatting", () => {
  it("formats structured display rows with role, product, action, and detail", () => {
    expect(
      formatDisplayEvent({
        type: "row",
        issueKey: "LBE-50",
        productId: "aigile",
        source: "architect",
        action: "plan ready",
        detail: "7 scope items",
        severity: "success",
      }),
    ).toBe("✓  LBE-50 [aigile]  architect › plan ready  7 scope items");
  });

  it("keeps colorized display rows text-equivalent to no-color rows", () => {
    const event = {
      type: "row" as const,
      issueKey: "LBE-50",
      productId: "aigile",
      source: "verifier" as const,
      action: "passed",
      detail: "bun run check, 41s",
      severity: "success" as const,
    };
    const colorized = formatDisplayEvent(event, { isTty: true, env: {} });
    const plain = formatDisplayEvent(event, { isTty: true, noColor: true, env: {} });

    expect(colorized.includes("\x1b[")).toBe(true);
    expect(plain.includes("\x1b[")).toBe(false);
    expect(stripAnsi(colorized)).toBe(plain);
  });

  it("formats a full structured run lifecycle", () => {
    const events = [
      { source: "architect" as const, action: "plan ready", detail: "7 scope items" },
      { source: "developer" as const, action: "edited", detail: "4 files" },
      { source: "verifier" as const, action: "passed", detail: "bun run check, 41s" },
      { source: "github" as const, action: "pr opened", detail: "#68" },
      { source: "linear" as const, action: "status", detail: "In Review" },
    ];

    expect(
      events
        .map((event) =>
          formatDisplayEvent({
            type: "row",
            issueKey: "LBE-50",
            productId: "aigile",
            severity: "info",
            ...event,
          }),
        )
        .join("\n"),
    ).toBe(
      [
        "●  LBE-50 [aigile]  architect › plan ready  7 scope items",
        "●  LBE-50 [aigile]  developer › edited  4 files",
        "●  LBE-50 [aigile]  verifier › passed  bun run check, 41s",
        "●  LBE-50 [aigile]  github › pr opened  #68",
        "●  LBE-50 [aigile]  linear › status  In Review",
      ].join("\n"),
    );
  });

  it("formats error display rows", () => {
    expect(
      formatDisplayEvent({
        type: "row",
        issueKey: "LBE-50",
        productId: "aigile",
        source: "developer",
        action: "failed",
        detail: "workspace stale",
        severity: "error",
      }),
    ).toBe("×  LBE-50 [aigile]  developer › failed  workspace stale");
  });

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

  it("surfaces merge policy in run output", () => {
    const output = formatDemoResult({
      issueKey: "LIN-795",
      finalState: "merge_ready",
      mergePolicy: "manual",
      artifacts: [],
      timeline: [{ label: "checker_passed -> merge_ready", elapsedMs: 1_000 }],
      durationMs: 1_000,
    });

    expect(output).toContain("Merge policy: manual");
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

    expect(output).toContain("Token usage: partial, 1,000,399 total (1,500 input, 600 output)");
    expect(output).toContain(
      "- claude-acp/runtime-default: partial, 999,999 total (1,200 input, 500 output)",
    );
    expect(output).toContain("- codex-acp/runtime-default: 400 total (300 input, 100 output)");
  });

  it("formats stage timing with retry counts and unavailable stages", () => {
    const output = formatDemoResult({
      issueKey: "LIN-123",
      finalState: "merged",
      artifacts: [],
      timeline: [],
      durationMs: 8_250,
      stageTimings: [
        { stage: "planning", attempts: 1, durationMs: 1_250 },
        { stage: "development", attempts: 3, durationMs: 6_000 },
        { stage: "verification", attempts: 0 },
      ],
    });

    expect(output).toContain("Stage timing:");
    expect(output).toContain("- planning/architect: 1 attempt, 1 second");
    expect(output).toContain("- development: 3 attempts, 6 seconds");
    expect(output).toContain("- verification: unavailable");
    expect(output).toContain("- checker/deep-review: unavailable");
    expect(output).toContain("- publish/PR: unavailable");
    expect(output).toContain("- reconciliation/status-sync: unavailable");
  });

  it("formats token usage by model/runtime and marks partial usage", () => {
    const output = formatDemoResult({
      issueKey: "LIN-123",
      finalState: "merged",
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
              model: "claude-4.8",
              tokenUsage: {
                inputTokens: 100,
                outputTokens: 50,
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
              model: "gpt-5.5",
              tokenUsage: {
                totalTokens: 1_000,
              },
            },
          },
          payload: {},
        },
      ],
      timeline: [],
      durationMs: 0,
    });

    expect(output).toContain("Token usage: partial, 1,150 total (100 input, 50 output)");
    expect(output).toContain("- claude-acp/claude-4.8: 150 total (100 input, 50 output)");
    expect(output).toContain("- codex-acp/gpt-5.5: partial, 1,000 total");
  });

  it("marks token usage partial when a runtime artifact has no usage metadata", () => {
    const output = formatDemoResult({
      issueKey: "LIN-123",
      finalState: "merged",
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
              model: "claude-4.8",
              tokenUsage: {
                inputTokens: 100,
                outputTokens: 50,
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
              model: "gpt-5.5",
            },
          },
          payload: {},
        },
      ],
      timeline: [],
      durationMs: 0,
    });

    expect(output).toContain("Token usage: partial, 150 total (100 input, 50 output)");
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

  it("formats deep-review substeps with angle and call progress", () => {
    expect(
      formatDeepReviewProgress({
        type: "deep_review_step",
        issueId: "LIN-123",
        mode: "refute_finding",
        angle: "cross-file",
        angleIndex: 3,
        angleCount: 4,
        sequence: 6,
        completedSubcalls: 5,
        totalSubcalls: 9,
        elapsedMs: 1200,
        findingId: "cross-file:1",
      }),
    ).toBe(
      "●  LIN-123  deep_reviewer › refute finding  3/4 cross-file call 6 done 5/9 +1200ms cross-file:1",
    );

    expect(
      formatDeepReviewProgress({
        type: "deep_review_step",
        issueId: "LIN-123",
        mode: "angle_pass",
        angle: "removed-behavior",
        angleIndex: 2,
        angleCount: 4,
        sequence: 4,
      }),
    ).toBe(
      [
        "●  LIN-123  deep_reviewer › review angle  2/4 removed-behavior call 4",
        "  Removed behavior; existing behavior, compatibility, or operator guarantees lost by the change.",
      ].join("\n"),
    );
  });

  it("coalesces small ACP text deltas before printing progress", () => {
    const formatter = createAcpRoleProgressFormatter({ textFlushThreshold: 80, level: "verbose" });
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
    const formatter = createAcpRoleProgressFormatter({ textFlushThreshold: 80, level: "verbose" });
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

  it("quiet level emits only lifecycle milestones", () => {
    const formatter = createAcpRoleProgressFormatter({ level: "quiet" });
    const base = { roleId: "developer", issueId: "LIN-9", runtimeId: "codex-acp" };
    expect(formatter.format({ type: "role_started", ...base })).toEqual([
      formatDisplayEvent({
        type: "row",
        issueKey: "LIN-9",
        source: "developer",
        action: "starting",
        detail: "codex-acp",
        severity: "info",
      }),
    ]);
    expect(formatter.format({ type: "text_delta", ...base, delta: "hello world" })).toEqual([]);
    expect(formatter.format({ type: "tool_start", ...base, tool: "Bash" })).toEqual([]);
    expect(formatter.format({ type: "thinking_delta", ...base, delta: "x" })).toEqual([]);
    expect(
      formatter.format({ type: "artifact_parsed", ...base, artifactKind: "developer.attempt" }),
    ).toEqual([
      formatDisplayEvent({
        type: "row",
        issueKey: "LIN-9",
        source: "developer",
        action: "artifact parsed",
        detail: "developer.attempt",
        severity: "success",
      }),
    ]);
    expect(formatter.flush()).toEqual([]);
  });

  it("formats normal artifact summaries without raw artifact JSON", () => {
    const formatter = createAcpRoleProgressFormatter();
    const base = { roleId: "developer", issueId: "LIN-9", runtimeId: "codex-acp" };

    expect(
      formatter.format({
        type: "artifact_parsed",
        ...base,
        artifactKind: "developer.attempt",
        artifactPayload: {
          summary: "Updated pretty logs.",
          changedFiles: ["packages/cli/src/main.ts", "packages/cli/src/main.test.ts"],
          verificationNotes: "bun test packages/cli is expected to pass.",
        },
      }),
    ).toEqual([
      formatDisplayEvent({
        type: "row",
        issueKey: "LIN-9",
        source: "developer",
        action: "artifact parsed",
        detail: "developer.attempt",
        severity: "success",
      }),
      "  Summary: Updated pretty logs.",
      "  Changed files: packages/cli/src/main.ts, packages/cli/src/main.test.ts",
      "  Verification: bun test packages/cli is expected to pass.",
    ]);
  });

  it("formats verbose artifact summaries with full artifact JSON", () => {
    const formatter = createAcpRoleProgressFormatter({ level: "verbose" });
    const base = { roleId: "checker", issueId: "LIN-9", runtimeId: "codex-acp" };

    expect(
      formatter.format({
        type: "artifact_parsed",
        ...base,
        artifactKind: "checker.verdict",
        artifactPayload: {
          verdict: "changes_requested",
          summary: "One issue remains.",
          reasons: ["Missing test coverage"],
        },
      }),
    ).toEqual([
      "[LIN-9 checker] artifact parsed: checker.verdict",
      "  Verdict: changes_requested",
      "  Summary: One issue remains.",
      "  Reasons:",
      "    - Missing test coverage",
      "  Artifact JSON:",
      "  {",
      '    "artifactKind": "checker.verdict",',
      '    "payload": {',
      '      "verdict": "changes_requested",',
      '      "summary": "One issue remains.",',
      '      "reasons": [',
      '        "Missing test coverage"',
      "      ]",
      "    }",
      "  }",
    ]);
  });

  it("formats verification result summaries with actionable errors", () => {
    const formatter = createAcpRoleProgressFormatter();
    const base = { roleId: "verifier", issueId: "LIN-9", runtimeId: "local" };

    expect(
      formatter.format({
        type: "artifact_parsed",
        ...base,
        artifactKind: "verification.result",
        artifactPayload: {
          status: "failed",
          commands: [
            {
              command: "bun",
              args: ["test", "packages/cli"],
              exitCode: 1,
              stdout: "1 pass\n2 fail\n",
              stderr: "error: expected value to be true\nstack trace omitted\n",
            },
          ],
        },
      }),
    ).toEqual([
      formatDisplayEvent({
        type: "row",
        issueKey: "LIN-9",
        source: "verifier",
        action: "artifact parsed",
        detail: "verification.result",
        severity: "success",
      }),
      "  Status: failed",
      "  Command: bun test packages/cli (exit 1)",
      "  Counts: 1 passed, 2 failed",
      "  Error: error: expected value to be true",
    ]);
  });

  it("normal level (default) drops raw stream noise", () => {
    const formatter = createAcpRoleProgressFormatter();
    const base = { roleId: "developer", issueId: "LIN-9", runtimeId: "codex-acp" };
    expect(formatter.format({ type: "thinking_delta", ...base, delta: "x" })).toEqual([]);
    expect(formatter.format({ type: "runtime_stderr", ...base, chunk: "noise\n" })).toEqual([]);
    expect(formatter.format({ type: "text_delta", ...base, delta: "raw text" })).toEqual([]);
  });

  it("normal level summarizes tool progress without raw text", () => {
    const formatter = createAcpRoleProgressFormatter();
    const base = { roleId: "developer", issueId: "LIN-9", runtimeId: "codex-acp" };

    expect(
      formatter.format({
        type: "tool_start",
        ...base,
        tool: "Bash",
        detail: "bun test packages/cli/src/main.test.ts",
      }),
    ).toEqual([]);
    expect(
      formatter.format({
        type: "tool_end",
        ...base,
        tool: "Bash",
        detail: "bun test packages/cli/src/main.test.ts",
      }),
    ).toEqual([]);
    expect(formatter.format({ type: "runtime_stopped", ...base })).toEqual([
      "  tools 1 Bash bun test packages/cli/src/main.test.ts",
      formatDisplayEvent({
        type: "row",
        issueKey: "LIN-9",
        source: "developer",
        action: "stopped",
        detail: "codex-acp",
        severity: "info",
      }),
    ]);
  });

  it("verbose level emits raw streams suppressed at normal", () => {
    const formatter = createAcpRoleProgressFormatter({ level: "verbose" });
    const base = { roleId: "developer", issueId: "LIN-9", runtimeId: "codex-acp" };
    expect(formatter.format({ type: "thinking_delta", ...base, delta: "x" })).toEqual([
      "[LIN-9 developer] thinking",
    ]);
    expect(formatter.format({ type: "runtime_stderr", ...base, chunk: "warn: foo\n" })).toEqual([
      "[LIN-9 developer] stderr: warn: foo",
    ]);
  });

  it("parses --quiet and --verbose into a progress level", () => {
    expect(parseCliArgs(["run", "LIN-1", "--quiet"]).progressLevel).toBe("quiet");
    expect(parseCliArgs(["run", "LIN-1", "--verbose"]).progressLevel).toBe("verbose");
    expect(parseCliArgs(["run", "LIN-1", "--debug"]).progressLevel).toBe("verbose");
    expect(parseCliArgs(["run", "LIN-1", "--no-color"]).noColor).toBe(true);
    expect(parseCliArgs(["run", "LIN-1"]).progressLevel).toBeUndefined();
    expect(() => parseCliArgs(["run", "LIN-1", "--quiet", "--debug"])).toThrow(/only one of/);
  });

  it("requires issue keys for run and allows keyless status listing", () => {
    expect(() => parseCliArgs(["run"])).toThrow(/run requires an issue key/);
    expect(parseCliArgs(["status"])).toEqual({ mode: "status" });
  });

  it("parses the standalone reconcile subcommand", () => {
    expect(
      parseCliArgs([
        "reconcile",
        "--products-config",
        "config/aigile.products.json",
        "--linear-api-key-env",
        "LINEAR_TOKEN",
      ]),
    ).toEqual({
      mode: "reconcile",
      productsConfigPath: "config/aigile.products.json",
      linearApiKeyEnv: "LINEAR_TOKEN",
    });
  });

  it("selects the ACP-agent demo mode from argv", () => {
    expect(selectDemoMode(["demo:agents"])).toBe("agents");
    expect(selectDemoMode(["demo:workspace"])).toBe("workspace");
    expect(selectDemoMode(["demo:github"])).toBe("github");
    expect(selectDemoMode(["demo:linear"])).toBe("linear");
    expect(selectDemoMode([])).toBe("scripted");
  });

  it("prints concise stderr and returns non-zero for top-level failures", async () => {
    let stderr = "";
    let exitCode = 0;

    const result = await runCli(
      async () => {
        throw new Error("run --linear requires LINEAR_API_KEY to be set");
      },
      {
        stderr: { write: (chunk) => (stderr += chunk) },
        setExitCode: (code) => (exitCode = code),
      },
    );

    expect(result).toBe(1);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("run --linear requires LINEAR_API_KEY to be set");
    expect(stderr).toContain("Set LINEAR_API_KEY");
    expect(stderr).not.toMatch(/\n\s*at\s/);
  });

  it("parses runtime config path from argv", () => {
    expect(
      parseCliArgs(["demo:agents", "--runtime-config", "config/aigile.runtimes.json"]),
    ).toEqual({
      mode: "agents",
      runtimeConfigPath: "config/aigile.runtimes.json",
    });
  });

  it("discovers the default runtime config path when present", () => {
    const root = mkdtempSync(join(tmpdir(), "aigile-runtime-config-"));
    try {
      mkdirSync(join(root, "config"), { recursive: true });
      writeFileSync(join(root, "config", "aigile.runtimes.json"), JSON.stringify({}));
      expect(resolveRuntimeConfigPath(parseCliArgs(["run", "LBE-1"]), root)).toBe(
        join(root, "config", "aigile.runtimes.json"),
      );
      expect(
        resolveRuntimeConfigPath(
          parseCliArgs(["run", "LBE-1", "--runtime-config", "custom/runtime.json"]),
          root,
        ),
      ).toBe("custom/runtime.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  it("parses product-backed run arguments", () => {
    expect(
      parseCliArgs([
        "run",
        "LBE-27",
        "--linear",
        "--product",
        "aigile",
        "--products-config",
        "config/aigile.products.example.json",
        "--runtime-config",
        "config/aigile.runtimes.example.json",
      ]),
    ).toEqual({
      mode: "run",
      issueKey: "LBE-27",
      linear: true,
      product: "aigile",
      productsConfigPath: "config/aigile.products.example.json",
      runtimeConfigPath: "config/aigile.runtimes.example.json",
    });
  });

  it("parses retry-escalated run arguments", () => {
    expect(
      parseCliArgs(["run", "LBE-27", "--linear", "--product", "aigile", "--retry-escalated"]),
    ).toEqual({
      mode: "run",
      issueKey: "LBE-27",
      linear: true,
      product: "aigile",
      retryEscalated: true,
    });
  });

  it("parses init arguments", () => {
    expect(parseCliArgs(["init"])).toEqual({ mode: "init" });
    expect(parseCliArgs(["init", "--force"])).toEqual({ mode: "init", force: true });
  });

  it("parses resume-publish run arguments", () => {
    expect(
      parseCliArgs(["run", "LBE-34", "--linear", "--product", "aigile", "--resume-publish"]),
    ).toEqual({
      mode: "run",
      issueKey: "LBE-34",
      linear: true,
      product: "aigile",
      resumePublish: true,
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

  it("parses keyless status arguments", () => {
    expect(
      parseCliArgs(["status", "--repo", "/repo/aigile", "--worktrees", "/repo/aigile/.worktrees"]),
    ).toEqual({
      mode: "status",
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
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

  it("parses daemon product config arguments", () => {
    expect(
      parseCliArgs([
        "daemon",
        "--product",
        "aigile",
        "--products-config",
        "config/aigile.products.example.json",
        "--runtime-config",
        "config/aigile.runtimes.example.json",
        "--poll-interval",
        "30s",
        "--agent-write",
        "--publish",
        "--start-run",
        "--linear-api-key-env",
        "AIGILE_LINEAR_API_KEY",
      ]),
    ).toEqual({
      mode: "daemon",
      product: "aigile",
      productsConfigPath: "config/aigile.products.example.json",
      runtimeConfigPath: "config/aigile.runtimes.example.json",
      pollIntervalMs: 30_000,
      agentWrite: true,
      publish: true,
      startRun: true,
      linearApiKeyEnv: "AIGILE_LINEAR_API_KEY",
    });
  });

  it("resolves product defaults for Linear watch runs", async () => {
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
      await resolveProductCliContext(
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
      remote: "origin",
      baseBranch: "main",
      repoPath: "/repo/aigile",
      worktreesPath: "/home/test/.aigile/worktrees/lbelyaev/aigile",
      dryRun: false,
      agentWrite: true,
      publish: true,
      startRun: true,
      mergePolicy: "auto",
    });
  });

  it("resolves every product from products config when watch omits --product", async () => {
    const config = loadProductConfigFromJson(
      JSON.stringify({
        products: [
          {
            id: "web",
            linear: { team: "LBE", project: "Web" },
            github: { repo: "lbelyaev/web", baseBranch: "main" },
            repoPath: "/repo/web",
            worktreesPath: "/worktrees/web",
            defaultRun: { startRun: true, mode: "agent_write", publish: false },
          },
          {
            id: "api",
            linear: { team: "LBE", project: "API" },
            github: { repo: "lbelyaev/api", baseBranch: "develop" },
            repoPath: "/repo/api",
            worktreesPath: "/worktrees/api",
            defaultRun: { startRun: true, mode: "dry_run", publish: false },
            verification: { checks: [["bun", "test", "packages/api"]] },
          },
        ],
      }),
    );

    expect(
      await resolveProductCliContexts(
        parseCliArgs([
          "watch",
          "--linear",
          "--products-config",
          "config/aigile.products.json",
          "--runtime-config",
          "config/aigile.runtimes.example.json",
          "--poll-interval",
          "30s",
        ]),
        config,
      ),
    ).toMatchObject([
      {
        productId: "web",
        linearTeam: "LBE",
        linearProject: "Web",
        githubRepo: "lbelyaev/web",
        remote: "origin",
        baseBranch: "main",
        repoPath: "/repo/web",
        worktreesPath: "/worktrees/web",
        agentWrite: true,
        dryRun: false,
        startRun: true,
      },
      {
        productId: "api",
        linearTeam: "LBE",
        linearProject: "API",
        githubRepo: "lbelyaev/api",
        remote: "origin",
        baseBranch: "develop",
        repoPath: "/repo/api",
        worktreesPath: "/worktrees/api",
        agentWrite: false,
        dryRun: true,
        startRun: true,
        verification: { checks: [["bun", "test", "packages/api"]] },
      },
    ]);
  });

  it("resolves every product from products config for daemon", async () => {
    const config = loadProductConfigFromJson(
      JSON.stringify({
        products: [
          {
            id: "web",
            linear: { team: "LBE", project: "Web" },
            github: { repo: "lbelyaev/web", baseBranch: "main" },
            repoPath: "/repo/web",
            worktreesPath: "/worktrees/web",
            defaultRun: { startRun: true, mode: "agent_write", publish: true },
          },
          {
            id: "api",
            linear: { team: "API", project: "API" },
            github: { repo: "lbelyaev/api", baseBranch: "develop" },
            repoPath: "/repo/api",
            worktreesPath: "/worktrees/api",
            defaultRun: { startRun: false, mode: "dry_run", publish: false },
          },
        ],
      }),
    );

    expect(
      await resolveProductCliContexts(
        parseCliArgs([
          "daemon",
          "--products-config",
          "config/aigile.products.json",
          "--runtime-config",
          "config/aigile.runtimes.example.json",
          "--poll-interval",
          "30s",
        ]),
        config,
      ),
    ).toMatchObject([
      {
        productId: "web",
        linearTeam: "LBE",
        linearProject: "Web",
        githubRepo: "lbelyaev/web",
        agentWrite: true,
        dryRun: false,
        publish: true,
        startRun: true,
      },
      {
        productId: "api",
        linearTeam: "API",
        linearProject: "API",
        githubRepo: "lbelyaev/api",
        agentWrite: false,
        dryRun: true,
        publish: false,
        startRun: false,
      },
    ]);
  });

  it("resolves product defaults and verification policy for direct runs", async () => {
    const config = loadProductConfigFromJson(
      JSON.stringify({
        products: [
          {
            id: "aigile",
            linear: { team: "LBE", project: "Aigile" },
            github: { repo: "lbelyaev/aigile", baseBranch: "main" },
            mergePolicy: "manual",
            repoPath: "/repo/aigile",
            worktreesPath: "/worktrees/aigile",
            defaultRun: { startRun: true, mode: "agent_write", publish: true },
            verification: {
              install: [["bun", "install", "--frozen-lockfile"]],
              checks: [["bun", "run", "check"]],
            },
          },
        ],
      }),
    );

    expect(
      await resolveProductCliContext(
        parseCliArgs([
          "run",
          "LBE-27",
          "--linear",
          "--product",
          "aigile",
          "--runtime-config",
          "config/aigile.runtimes.example.json",
        ]),
        config,
        { cwd: "/fallback", homeDir: "/home/test" },
      ),
    ).toEqual({
      productId: "aigile",
      linearTeam: "LBE",
      linearProject: "Aigile",
      githubRepo: "lbelyaev/aigile",
      githubOwner: "lbelyaev",
      githubRepository: "aigile",
      remote: "origin",
      baseBranch: "main",
      repoPath: "/repo/aigile",
      worktreesPath: "/worktrees/aigile",
      dryRun: false,
      agentWrite: true,
      publish: true,
      startRun: true,
      mergePolicy: "manual",
      verification: {
        install: [["bun", "install", "--frozen-lockfile"]],
        checks: [["bun", "run", "check"]],
      },
    });
  });

  it("selects the sole product without --product and honors defaultRun mode", async () => {
    const config = loadProductConfigFromJson(
      JSON.stringify({
        products: [
          {
            id: "aigile",
            linear: { team: "LBE", project: "Aigile" },
            github: { repo: "lbelyaev/aigile", baseBranch: "main" },
            repoPath: "/repo/aigile",
            worktreesPath: "/worktrees/aigile",
            defaultRun: { startRun: true, mode: "agent_write", publish: true },
          },
        ],
      }),
    );

    expect(
      await resolveProductCliContext(
        parseCliArgs([
          "run",
          "LBE-38",
          "--linear",
          "--runtime-config",
          "config/aigile.runtimes.example.json",
        ]),
        config,
      ),
    ).toMatchObject({
      productId: "aigile",
      linearTeam: "LBE",
      githubRepo: "lbelyaev/aigile",
      remote: "origin",
      baseBranch: "main",
      repoPath: "/repo/aigile",
      worktreesPath: "/worktrees/aigile",
      dryRun: false,
      agentWrite: true,
      publish: true,
      startRun: true,
    });
  });

  it("selects a product by issue key team prefix without --product", async () => {
    const config = loadProductConfigFromJson(
      JSON.stringify({
        products: [
          {
            id: "web",
            linear: { team: "WEB", project: "Web" },
            github: { repo: "lbelyaev/web", baseBranch: "main" },
            defaultRun: { startRun: true, mode: "agent_write", publish: false },
          },
          {
            id: "api",
            linear: { team: "API", project: "API" },
            github: { repo: "lbelyaev/api", baseBranch: "develop" },
            repoPath: "/repo/api",
            worktreesPath: "/worktrees/api",
            defaultRun: { startRun: true, mode: "dry_run", publish: false },
          },
        ],
      }),
    );

    expect(
      await resolveProductCliContext(
        parseCliArgs([
          "run",
          "API-42",
          "--linear",
          "--runtime-config",
          "config/aigile.runtimes.example.json",
        ]),
        config,
      ),
    ).toMatchObject({
      productId: "api",
      linearTeam: "API",
      githubRepo: "lbelyaev/api",
      baseBranch: "develop",
      repoPath: "/repo/api",
      worktreesPath: "/worktrees/api",
      dryRun: true,
      agentWrite: false,
    });
  });

  it("derives github repo and base branch from git remote defaults", async () => {
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];

    const context = await resolveProductCliContext(
      parseCliArgs(["run", "LBE-38", "--linear", "--products-config", "/missing/products.json"]),
      undefined,
      {
        cwd: "/repo/aigile",
        exec: async (command, args, options) => {
          calls.push({ command, args: [...args], cwd: options.cwd });
          if (command === "git" && args[0] === "remote") {
            return { stdout: "git@github.com:lbelyaev/aigile.git\n", stderr: "", exitCode: 0 };
          }
          if (command === "git" && args[0] === "symbolic-ref") {
            return { stdout: "refs/remotes/origin/trunk\n", stderr: "", exitCode: 0 };
          }
          throw new Error("unexpected command");
        },
      },
    );

    expect(context).toMatchObject({
      githubRepo: "lbelyaev/aigile",
      githubOwner: "lbelyaev",
      githubRepository: "aigile",
      remote: "origin",
      baseBranch: "trunk",
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      dryRun: false,
      agentWrite: false,
    });
    expect(calls).toEqual([
      { command: "git", args: ["remote", "get-url", "origin"], cwd: "/repo/aigile" },
      {
        command: "git",
        args: ["symbolic-ref", "refs/remotes/origin/HEAD"],
        cwd: "/repo/aigile",
      },
    ]);
  });

  it("uses in-repo config when central products config is absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "aigile-repo-context-"));
    try {
      mkdirSync(join(root, ".git"));
      writeFileSync(
        join(root, ".aigile.json"),
        JSON.stringify({
          version: 1,
          id: "aigile",
          packageManager: "bun",
          linear: { team: "LBE", project: "Aigile" },
          github: { baseBranch: "main" },
          defaultRun: { startRun: true, mode: "agent_write", publish: false },
          verification: { checks: [["bun", "run", "check"]] },
        }),
      );

      await expect(
        resolveProductCliContext(parseCliArgs(["run", "LBE-40", "--linear"]), undefined, {
          cwd: root,
          homeDir: "/home/test",
          exec: async (command, args) => {
            if (command === "git" && args[0] === "remote") {
              return {
                stdout: "https://github.com/lbelyaev/aigile.git\n",
                stderr: "",
                exitCode: 0,
              };
            }
            if (command === "git" && args[0] === "symbolic-ref") {
              return { stdout: "", stderr: "missing", exitCode: 1 };
            }
            throw new Error("unexpected command");
          },
        }),
      ).resolves.toMatchObject({
        productId: "aigile",
        linearTeam: "LBE",
        linearProject: "Aigile",
        githubRepo: "lbelyaev/aigile",
        githubOwner: "lbelyaev",
        githubRepository: "aigile",
        baseBranch: "main",
        repoPath: root,
        worktreesPath: "/home/test/.aigile/worktrees/lbelyaev/aigile",
        agentWrite: true,
        dryRun: false,
        startRun: true,
        packageManager: "bun",
        verification: { checks: [["bun", "run", "check"]] },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets central products config override in-repo config", async () => {
    const root = mkdtempSync(join(tmpdir(), "aigile-central-override-"));
    try {
      mkdirSync(join(root, ".git"));
      writeFileSync(
        join(root, ".aigile.json"),
        JSON.stringify({
          version: 1,
          id: "repo",
          linear: { team: "RPO", project: "Repo" },
          github: { repo: "repo/local", baseBranch: "main" },
          defaultRun: { startRun: true, mode: "dry_run", publish: false },
        }),
      );
      const central = loadProductConfigFromJson(
        JSON.stringify({
          products: [
            {
              id: "central",
              linear: { team: "LBE", project: "Central" },
              github: { repo: "central/project", baseBranch: "develop" },
              defaultRun: { startRun: true, mode: "agent_write", publish: true },
            },
          ],
        }),
      );

      await expect(
        resolveProductCliContext(parseCliArgs(["run", "LBE-40", "--linear"]), central, {
          cwd: root,
          homeDir: "/home/test",
        }),
      ).resolves.toMatchObject({
        productId: "central",
        linearTeam: "LBE",
        linearProject: "Central",
        githubRepo: "central/project",
        baseBranch: "develop",
        agentWrite: true,
        publish: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a setup hint when the default product config file is missing", async () => {
    await expect(
      resolveProductCliContext(
        parseCliArgs(["watch", "--linear", "--product", "aigile", "--poll-interval", "30s"]),
        undefined,
        { cwd: "/repo/aigile", homeDir: "/home/test" },
      ),
    ).rejects.toThrow(
      /product config not found: config\/aigile\.products\.json\. Pass --products-config <path> or create config\/aigile\.products\.json from config\/aigile\.products\.example\.json/,
    );
  });

  it("lets explicit CLI flags override product defaults", async () => {
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
      await resolveProductCliContext(
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
          "--remote",
          "upstream",
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
      remote: "upstream",
      baseBranch: "develop",
      repoPath: "/override/repo",
      worktreesPath: "/override/worktrees",
      dryRun: true,
      agentWrite: false,
      publish: true,
      startRun: true,
    });
  });

  it("scaffolds config files with init and refuses overwrite without force", async () => {
    const root = mkdtempSync(join(tmpdir(), "aigile-init-"));
    try {
      const output = await runInitCli({ cwd: root, examplesDir: join(process.cwd(), "config") });
      expect(output).toContain("Created .aigile.json");
      expect(readFileSync(join(root, ".aigile.json"), "utf8")).toContain('"version": 1');
      expect(readFileSync(join(root, "config", "aigile.products.json"), "utf8")).toContain(
        '"products"',
      );
      expect(readFileSync(join(root, "config", "aigile.runtimes.json"), "utf8")).toContain(
        '"runtimes"',
      );
      await expect(
        runInitCli({ cwd: root, examplesDir: join(process.cwd(), "config") }),
      ).rejects.toThrow(/already exists/i);
      await expect(
        runInitCli({ cwd: root, examplesDir: join(process.cwd(), "config"), force: true }),
      ).resolves.toContain("Overwrote .aigile.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects watch without an explicit once pass", () => {
    expect(() => parseCliArgs(["watch"])).toThrow(/requires --once or --poll-interval/i);
  });

  it("rejects daemon without a poll interval", () => {
    expect(() => parseCliArgs(["daemon"])).toThrow(/daemon requires --poll-interval/i);
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
    expect(
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
    ).toEqual({
      mode: "watch",
      linear: true,
      linearTeam: "LBE",
      pollIntervalMs: 30_000,
      startRun: true,
      runtimeConfigPath: "config/aigile.runtimes.example.json",
    });
    expect(
      parseCliArgs([
        "watch",
        "--linear",
        "--linear-team",
        "LBE",
        "--poll-interval",
        "30s",
        "--start-run",
      ]),
    ).toEqual({
      mode: "watch",
      linear: true,
      linearTeam: "LBE",
      pollIntervalMs: 30_000,
      startRun: true,
    });
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

  it("suppresses consecutive idle Linear polls in normal output", async () => {
    const output = await runLinearWatchLoopCli({
      apiKey: "test-key",
      teamKey: "LBE",
      readyStatus: "Todo",
      claimStatus: "In Progress",
      pollIntervalMs: 1,
      maxPolls: 3,
      sleep: async () => {},
      fetchGraphql: async (query) => {
        if (query.includes("ReadyIssues")) return { issues: { nodes: [] } };
        return {};
      },
    });

    expect(output).not.toContain("Poll 1: idle heartbeat");
    expect(output).not.toContain("Poll 2: idle heartbeat");
    expect(output).not.toContain("Poll 3: idle heartbeat");
  });

  it("formats daemon startup output for configured products", () => {
    expect(
      formatDaemonStartupSummary(
        [
          {
            productId: "web",
            linearTeam: "LBE",
            linearProject: "Web",
            githubRepo: "lbelyaev/web",
            githubOwner: "lbelyaev",
            githubRepository: "web",
            remote: "origin",
            baseBranch: "main",
            repoPath: "/repo/web",
            worktreesPath: "/worktrees/web",
            dryRun: false,
            agentWrite: true,
            publish: true,
            startRun: true,
            mergePolicy: "auto",
          },
          {
            productId: "api",
            linearTeam: "API",
            linearProject: "API",
            githubRepo: "lbelyaev/api",
            githubOwner: "lbelyaev",
            githubRepository: "api",
            remote: "origin",
            baseBranch: "main",
            repoPath: "/repo/api",
            worktreesPath: "/worktrees/api",
            dryRun: true,
            agentWrite: false,
            publish: false,
            startRun: false,
            mergePolicy: "manual",
          },
        ],
        { pollIntervalMs: 30_000 },
      ),
    ).toBe(
      [
        "aigile  daemon started",
        "  products: web, api",
        "  merge policy: web=auto, api=manual",
        "         poll interval: 30000ms",
      ].join("\n"),
    );
  });

  it("runs startup reconciliation before the daemon watch loop can claim work", async () => {
    const sequence: string[] = [];
    const output = await runLinearDaemonSupervisorCli({
      contexts: [
        {
          productId: "aigile",
          linearTeam: "LBE",
          linearProject: "Aigile",
          githubRepo: "lbelyaev/aigile",
          githubOwner: "lbelyaev",
          githubRepository: "aigile",
          remote: "origin",
          baseBranch: "main",
          repoPath: "/repo/aigile",
          worktreesPath: "/worktrees/aigile",
          dryRun: false,
          agentWrite: true,
          publish: true,
          startRun: true,
        },
      ],
      loopInput: {
        apiKey: "test-key",
        teamKey: "LBE",
        pollIntervalMs: 1,
      },
      startupReconcile: async () => {
        sequence.push("reconcile:start");
        await Promise.resolve();
        sequence.push("reconcile:end");
        return {
          outcomes: [
            {
              kind: "updated",
              productId: "aigile",
              issueKey: "LBE-53",
              from: "In Review",
              to: "Done",
              branchName: "aigile/LBE-53",
              target: { owner: "lbelyaev", repo: "aigile" },
            },
          ],
        };
      },
      runLoop: async () => {
        sequence.push("runLoop");
        return "";
      },
    });

    expect(sequence).toEqual(["reconcile:start", "reconcile:end", "runLoop"]);
    expect(output).toContain("Startup reconciliation: scanning persisted runs");
    expect(output).toContain("Startup reconciliation: - aigile/LBE-53: updated In Review -> Done");
  });

  it("resumes startup runs before entering the daemon watch loop", async () => {
    const sequence: string[] = [];
    const resumed: string[] = [];
    const loopResumable: string[][] = [];

    const output = await runLinearDaemonSupervisorCli({
      contexts: [
        {
          productId: "aigile",
          linearTeam: "LBE",
          linearProject: "Aigile",
          githubRepo: "lbelyaev/aigile",
          githubOwner: "lbelyaev",
          githubRepository: "aigile",
          remote: "origin",
          baseBranch: "main",
          repoPath: "/repo/aigile",
          worktreesPath: "/worktrees/aigile",
          dryRun: false,
          agentWrite: true,
          publish: true,
          startRun: true,
        },
      ],
      loopInput: {
        apiKey: "test-key",
        teamKey: "LBE",
        pollIntervalMs: 1,
        resume: {
          listResumable: async () => ["LBE-30"],
          resumeRun: async (issueId) => {
            sequence.push(`resume:${issueId}`);
            resumed.push(issueId);
            return { outcome: "Workflow state: merged" };
          },
        },
      },
      startupReconcile: async () => {
        sequence.push("reconcile");
        return { outcomes: [] };
      },
      runLoop: async (loopInput) => {
        sequence.push("runLoop");
        loopResumable.push((await loopInput.resume?.listResumable()) ?? []);
        return "";
      },
    });

    expect(sequence).toEqual(["reconcile", "resume:LBE-30", "runLoop"]);
    expect(resumed).toEqual(["LBE-30"]);
    expect(loopResumable).toEqual([[]]);
    expect(output).toContain("Startup reconciliation: resumed LBE-30 (Workflow state: merged)");
  });

  it("stops the daemon supervisor cleanly when aborted between polls", async () => {
    const controller = new AbortController();
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];

    const output = await runLinearDaemonSupervisorCli({
      contexts: [
        {
          productId: "aigile",
          linearTeam: "LBE",
          linearProject: "Aigile",
          githubRepo: "lbelyaev/aigile",
          githubOwner: "lbelyaev",
          githubRepository: "aigile",
          remote: "origin",
          baseBranch: "main",
          repoPath: "/repo/aigile",
          worktreesPath: "/worktrees/aigile",
          dryRun: false,
          agentWrite: true,
          publish: false,
          startRun: true,
        },
      ],
      loopInput: {
        apiKey: "test-key",
        teamKey: "LBE",
        teamKeys: ["LBE"],
        pollIntervalMs: 1,
        signal: controller.signal,
        sleep: async (_durationMs, signal) => {
          expect(signal).toBe(controller.signal);
          controller.abort();
        },
        fetchGraphql: async (query, variables) => {
          calls.push({ query, variables });
          if (query.includes("ReadyIssues")) return { issues: { nodes: [] } };
          return {};
        },
      },
    });

    expect(output).toContain("aigile  daemon started");
    expect(output).toContain("Aigile watch: loop");
    expect(output).toContain("Stopped: aborted after 1 polls");
    expect(calls.filter((call) => call.query.includes("issueUpdate"))).toHaveLength(0);
    expect(calls.filter((call) => call.query.includes("commentCreate"))).toHaveLength(0);
  });

  it("resumes an interrupted run during the watch loop", async () => {
    const resumed: string[] = [];
    const output = await runLinearWatchLoopCli({
      apiKey: "test-key",
      teamKey: "LBE",
      readyStatus: "Todo",
      pollIntervalMs: 1,
      maxPolls: 1,
      sleep: async () => {},
      resume: {
        listResumable: async () => ["LBE-30"],
        resumeRun: async (issueId) => {
          resumed.push(issueId);
          return { outcome: "merged" };
        },
      },
      fetchGraphql: async (query) => {
        if (query.includes("ReadyIssues")) return { issues: { nodes: [] } };
        return {};
      },
    });

    expect(resumed).toEqual(["LBE-30"]);
    expect(output).toContain("Poll 1: resumed LBE-30 (merged)");
  });

  it("reconciles an in-flight issue to Done when its PR has merged", async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const reconcileCodeHost = {
      findPullRequestForBranch: async (branch: string) => ({
        id: "lbelyaev/aigile#1",
        number: 1,
        url: "https://github.com/lbelyaev/aigile/pull/1",
        mergeState: "merged" as const,
        open: false,
        branch,
      }),
    } as unknown as CodeHostAdapter;

    const output = await runLinearWatchLoopCli({
      apiKey: "test-key",
      teamKey: "LBE",
      readyStatus: "Todo",
      reviewStatus: "In Review",
      claimStatus: "In Progress",
      pollIntervalMs: 1,
      maxPolls: 1,
      sleep: async () => {},
      codeHost: reconcileCodeHost,
      pullRequestTarget: { owner: "lbelyaev", repo: "aigile" },
      fetchGraphql: async (query, variables) => {
        calls.push({ query, variables });
        if (query.includes("ReadyIssues")) {
          // The reconcile source lists "In Review" issues; the claim source lists "Todo" (none).
          const status = variables.readyStatus;
          if (status === "In Review") {
            return {
              issues: {
                nodes: [
                  {
                    id: "issue-id",
                    identifier: "LBE-8",
                    title: "In review issue",
                    description: "",
                    state: { name: "In Review" },
                    comments: { nodes: [] },
                  },
                ],
              },
            };
          }
          return { issues: { nodes: [] } };
        }
        if (query.includes("WorkflowStateByName")) {
          return { workflowStates: { nodes: [{ id: "state-done", name: "Done" }] } };
        }
        if (query.includes("IssueIdByKey")) return { issue: { id: "issue-id" } };
        if (query.includes("issueUpdate")) return {};
        return {};
      },
    });

    expect(output).toContain("Poll 1: reconciled LBE-8 (In Review -> Done)");
    expect(calls.filter((call) => call.query.includes("issueUpdate"))).toHaveLength(1);
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
      "Poll 1: run failed for LBE-18 product: unrouted phase: workspace; restored status to Todo: Issue branch aigile/LBE-18 is stale relative to origin/main",
    );
    expect(output).toContain("Agents: handled claimed issues");
    expect(statusUpdates).toHaveLength(2);
    expect(statusUpdates.at(-1)).toMatchObject({ status: "state-todo" });
  });

  it("treats escalated publish output from a claimed run as a contained run failure", async () => {
    const comments: unknown[] = [];

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
      startRun: async () =>
        formatDemoResult({
          issueKey: "LBE-19",
          finalState: "escalated",
          publicationFailure: {
            operation: "publish_pull_request",
            message: "gh pr create failed",
          },
          artifacts: [],
          timeline: [],
          durationMs: 0,
        }),
      fetchGraphql: async (query, variables) => {
        if (query.includes("ReadyIssues")) {
          return {
            issues: {
              nodes: [
                {
                  id: "issue-id",
                  identifier: "LBE-19",
                  title: "Contain publish failure",
                  description: "Acceptance:\n- Reports publish failure",
                  state: { name: "Todo" },
                  project: { id: "project-aigile", name: "Aigile" },
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
        if (query.includes("issueUpdate")) return {};
        if (query.includes("commentCreate")) {
          comments.push(variables);
          return {};
        }
        return {};
      },
    });

    expect(output).toContain(
      "Run LBE-19: Final state: escalated product: aigile repo: lbelyaev/aigile",
    );
    expect(output).toContain(
      "Poll 1: run failed for LBE-19 product: aigile phase: publish; restored status to Todo: gh pr create failed",
    );
    expect(output).not.toContain("Run LBE-19: completed");
    expect(
      comments.filter((comment) =>
        JSON.stringify(comment).includes("Aigile run failed for LBE-19"),
      ),
    ).toHaveLength(1);
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

  it("routes Linear watch runs across two products sharing a team", async () => {
    const started: Array<{
      issueKey: string;
      productId: string | undefined;
      repo: string | undefined;
    }> = [];

    const output = await runLinearWatchLoopCli({
      apiKey: "test-key",
      teamKey: "LBE",
      productRoutes: [
        { productId: "web", linearProject: "Web", githubRepo: "lbelyaev/web" },
        { productId: "api", linearProject: "API", githubRepo: "lbelyaev/api" },
      ],
      readyStatus: "Todo",
      claimStatus: "In Progress",
      pollIntervalMs: 1,
      maxPolls: 3,
      sleep: async () => {},
      startRun: async (issue, route) => {
        started.push({ issueKey: issue.key, productId: route?.productId, repo: route?.githubRepo });
        return [`Aigile demo run: ${issue.key}`, "Final state: merge_ready"].join("\n");
      },
      fetchGraphql: async (query) => {
        if (query.includes("ReadyIssues")) {
          return {
            issues: {
              nodes: [
                {
                  id: "issue-web",
                  identifier: "LBE-41",
                  title: "Web issue",
                  description: "",
                  state: { name: "Todo" },
                  project: { id: "project-web", name: "Web" },
                  comments: { nodes: [] },
                },
                {
                  id: "issue-api",
                  identifier: "LBE-42",
                  title: "API issue",
                  description: "",
                  state: { name: "Todo" },
                  project: { id: "project-api", name: "API" },
                  comments: { nodes: [] },
                },
                {
                  id: "issue-other",
                  identifier: "LBE-43",
                  title: "Other issue",
                  description: "",
                  state: { name: "Todo" },
                  project: { id: "project-other", name: "Other" },
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
        return {};
      },
    });

    expect(started).toEqual([
      { issueKey: "LBE-41", productId: "web", repo: "lbelyaev/web" },
      { issueKey: "LBE-42", productId: "api", repo: "lbelyaev/api" },
    ]);
    expect(output).toContain(
      "Poll 1: claimed LBE-41 (ready issues: 2) product: web repo: lbelyaev/web",
    );
    expect(output).toContain(
      "Poll 2: claimed LBE-42 (ready issues: 1) product: api repo: lbelyaev/api",
    );
    expect(output).toContain("Poll 1: skipped LBE-43 (project_mismatch)");
    expect(output).toContain("Run LBE-41: starting product: web repo: lbelyaev/web");
    expect(output).toContain("Run LBE-42: completed product: api repo: lbelyaev/api");
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
      getPullRequestChecks: async () => ({ status: "none", checks: [] }),
      appendPullRequestComment: async () => {},
      submitPullRequestReview: async () => {},
      recordCheckResult: async () => {},
      mergePullRequest: async () => {},
      findPullRequestForBranch: async () => undefined,
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
      retryEscalated: true,
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
      retryEscalated: true,
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

  it("does not post-sync already satisfied Linear runs outside the engine", async () => {
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
    expect(calls.map((call) => call.variables)).toEqual([{ key: "LBE-6" }]);
  });

  it("does not run legacy no-team final status sync", async () => {
    const progressLines: string[] = [];

    const output = await runLinearIssueWorkflowCli({
      apiKey: "test-key",
      issueKey: "LBE-6",
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      runtimeConfigPath: "config/aigile.runtimes.example.json",
      agentWrite: true,
      onProgressLine: (line) => progressLines.push(line),
      fetchGraphql: async (query, variables) => {
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
        if (query.includes("issueUpdate")) {
          throw new Error(`Linear rejected unresolved state id: ${String(variables.status)}`);
        }
        if (query.includes("commentCreate")) return {};
        throw new Error(`unexpected query: ${query}`);
      },
      runWorkspace: async (input) => ({
        issueKey: input.issue.key,
        finalState: "satisfied",
        artifacts: [],
        timeline: [{ label: "work_satisfied -> satisfied", elapsedMs: 1 }],
        durationMs: 1,
      }),
    });

    expect(output).toContain("Final state: satisfied");
    expect(progressLines).toEqual([]);
  });

  it("does not repeat a terminal status already synced by the workspace engine", async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];

    await runLinearIssueWorkflowCli({
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
      runWorkspace: async (input) => {
        await input.issueTracker?.updateIssueStatus(input.issue.key, "Done");
        return {
          issueKey: input.issue.key,
          finalState: "satisfied",
          artifacts: [],
          timeline: [{ label: "work_satisfied -> satisfied", elapsedMs: 1 }],
          durationMs: 1,
        };
      },
    });

    expect(calls.filter((call) => call.query.includes("issueUpdate"))).toHaveLength(1);
  });

  it("does not post-sync published Linear runs outside the engine", async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const codeHost: CodeHostAdapter = {
      createPullRequest: async () => {
        throw new Error("createPullRequest should not be called");
      },
      getPullRequest: async () => {
        throw new Error("getPullRequest should not be called");
      },
      // A merged PR reports mergeable "unknown"; the sync must NOT query mergeability
      // for a merged run (doing so would falsely look blocked). Throw to lock that in.
      getPullRequestMergeability: async () => {
        throw new Error("getPullRequestMergeability should not be called for a merged PR");
      },
      getPullRequestMergeState: async () => ({ status: "merged" }),
      getPullRequestChecks: async () => ({ status: "none", checks: [] }),
      appendPullRequestComment: async () => {},
      submitPullRequestReview: async () => {},
      recordCheckResult: async () => {},
      mergePullRequest: async () => {},
      findPullRequestForBranch: async () => undefined,
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
    expect(calls.map((call) => call.variables)).toEqual([{ key: "LBE-7" }]);
  });

  it("does not post-sync mocked published runs when pull requests have conflicts", async () => {
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
      getPullRequestChecks: async () => ({ status: "none", checks: [] }),
      appendPullRequestComment: async () => {},
      submitPullRequestReview: async () => {},
      recordCheckResult: async () => {},
      mergePullRequest: async () => {},
      findPullRequestForBranch: async () => undefined,
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
        if (query.includes("WorkflowStateByName")) {
          return { workflowStates: { nodes: [{ id: "state-review", name: "In Review" }] } };
        }
        if (query.includes("IssueIdByKey")) return { issue: { id: "issue-id" } };
        if (query.includes("issueUpdate")) return {};
        if (query.includes("commentCreate")) return {};
        throw new Error(`unexpected query: ${query}`);
      },
      runWorkspace: async (input) => ({
        issueKey: input.issue.key,
        finalState: "merge_ready",
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

    expect(output).toContain("Final state: merge_ready");
    expect(output).toContain("Pull request: https://github.com/lbelyaev/aigile/pull/8");
    expect(calls.map((call) => call.variables)).toEqual([{ key: "LBE-8" }]);
  });

  it("does not post-sync the final Linear status when no team key is configured", async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];

    await runLinearIssueWorkflowCli({
      apiKey: "test-key",
      issueKey: "LBE-10",
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      runtimeConfigPath: "config/aigile.runtimes.example.json",
      agentWrite: true,
      publish: true,
      fetchGraphql: async (query, variables) => {
        calls.push({ query, variables });
        if (query.includes("IssueByKey")) {
          return {
            issue: {
              id: "issue-id",
              identifier: "LBE-10",
              title: "Sync without team",
              description: "Acceptance:\n- Update status",
              state: { name: "Todo" },
              comments: { nodes: [] },
            },
          };
        }
        if (query.includes("issueUpdate")) return {};
        if (query.includes("commentCreate")) return {};
        throw new Error(`unexpected query: ${query}`);
      },
      runWorkspace: async (input) => ({
        issueKey: input.issue.key,
        finalState: "merged",
        pullRequest: {
          id: "lbelyaev/aigile#10",
          number: 10,
          url: "https://github.com/lbelyaev/aigile/pull/10",
          owner: "lbelyaev",
          repo: "aigile",
          branch: "aigile/LBE-10",
          baseBranch: "main",
          title: "LBE-10 Sync without team",
          body: "Demo PR",
          comments: [],
          checks: [],
          reviews: [],
        },
        artifacts: [],
        timeline: [],
        durationMs: 0,
      }),
    });

    expect(calls.map((call) => call.variables)).toEqual([{ key: "LBE-10" }]);
  });

  it("does not post-sync mocked published runs when pull request mergeability is unknown", async () => {
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
      getPullRequestChecks: async () => ({ status: "none", checks: [] }),
      appendPullRequestComment: async () => {},
      submitPullRequestReview: async () => {},
      recordCheckResult: async () => {},
      mergePullRequest: async () => {},
      findPullRequestForBranch: async () => undefined,
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
        if (query.includes("WorkflowStateByName")) {
          return { workflowStates: { nodes: [{ id: "state-review", name: "In Review" }] } };
        }
        if (query.includes("IssueIdByKey")) return { issue: { id: "issue-id" } };
        if (query.includes("issueUpdate")) return {};
        if (query.includes("commentCreate")) return {};
        throw new Error(`unexpected query: ${query}`);
      },
      runWorkspace: async (input) => ({
        issueKey: input.issue.key,
        finalState: "merge_ready",
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
    expect(calls.map((call) => call.variables)).toEqual([{ key: "LBE-9" }]);
  });

  it("does not post-sync open published Linear runs outside the engine", async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const codeHost: CodeHostAdapter = {
      createPullRequest: async () => {
        throw new Error("createPullRequest should not be called");
      },
      getPullRequest: async () => {
        throw new Error("getPullRequest should not be called");
      },
      getPullRequestMergeability: async () => ({ status: "mergeable" }),
      getPullRequestMergeState: async () => ({ status: "unmerged" }),
      getPullRequestChecks: async () => ({ status: "none", checks: [] }),
      appendPullRequestComment: async () => {},
      submitPullRequestReview: async () => {},
      recordCheckResult: async () => {},
      mergePullRequest: async () => {},
      findPullRequestForBranch: async () => undefined,
    };

    const output = await runLinearIssueWorkflowCli({
      apiKey: "test-key",
      issueKey: "LBE-14",
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
              identifier: "LBE-14",
              title: "Sync Linear status to In Review",
              description: "Acceptance:\n- Open PR means In Review",
              state: { name: "In Progress" },
              comments: { nodes: [] },
            },
          };
        }
        if (query.includes("WorkflowStateByName")) {
          return { workflowStates: { nodes: [{ id: "state-review", name: "In Review" }] } };
        }
        if (query.includes("IssueIdByKey")) return { issue: { id: "issue-id" } };
        if (query.includes("issueUpdate")) return {};
        if (query.includes("commentCreate")) return {};
        throw new Error(`unexpected query: ${query}`);
      },
      runWorkspace: async (input) => ({
        issueKey: input.issue.key,
        finalState: "merge_ready",
        pullRequest: {
          id: "lbelyaev/aigile#14",
          number: 14,
          url: "https://github.com/lbelyaev/aigile/pull/14",
          owner: "lbelyaev",
          repo: "aigile",
          branch: "aigile/LBE-14",
          baseBranch: "main",
          title: "LBE-14 Sync Linear status to In Review",
          body: "Demo PR",
          comments: [],
          checks: [],
          reviews: [],
        },
        artifacts: [
          {
            id: "verifier:LBE-14:local",
            kind: "verification.result",
            source: "verifier",
            payload: { status: "passed", commands: [] },
          },
        ],
        timeline: [{ label: "checker_passed -> merge_ready", elapsedMs: 1 }],
        durationMs: 1,
      }),
    });

    expect(output).toContain("Final state: merge_ready");
    expect(calls.map((call) => call.variables)).toEqual([{ key: "LBE-14" }]);
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

  it("formats workspace diff summaries and gates unified diff to verbose", () => {
    const status = {
      workspace: {
        issueKey: "LIN-795",
        branchName: "aigile/LIN-795",
        baseBranch: "main",
        worktreePath: "/repo/aigile/.worktrees/LIN-795",
      },
      state: "dirty" as const,
      currentBranch: "aigile/LIN-795",
      changedFiles: [" M packages/roles/src/acp-runner.ts", "?? scratch.md"],
    };
    const unifiedDiff = [
      "diff --git a/packages/roles/src/acp-runner.ts b/packages/roles/src/acp-runner.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");

    expect(formatIssueWorkspaceStatus(status)).toContain(
      ["Workspace diff:", "- M packages/roles/src/acp-runner.ts", "- ?? scratch.md"].join("\n"),
    );
    expect(formatIssueWorkspaceStatus(status)).not.toContain("diff --git");
    expect(formatIssueWorkspaceStatus(status, { level: "verbose", unifiedDiff })).toContain(
      ["Unified diff:", unifiedDiff].join("\n"),
    );
  });

  it("loads unified workspace diffs only for verbose status output", async () => {
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];

    const output = await runIssueWorkspaceStatus({
      issueKey: "LIN-795",
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      baseBranch: "main",
      progressLevel: "verbose",
      exec: async (command, args, options) => {
        calls.push({ command, args: [...args], cwd: options.cwd });
        if (command === "test") return { stdout: "", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "rev-parse") {
          return { stdout: "aigile/LIN-795\n", stderr: "", exitCode: 0 };
        }
        if (command === "git" && args[0] === "status") {
          return { stdout: " M packages/cli/src/main.ts\n", stderr: "", exitCode: 0 };
        }
        if (command === "git" && args[0] === "diff") {
          return {
            stdout: "diff --git a/packages/cli/src/main.ts b/packages/cli/src/main.ts\n",
            stderr: "",
            exitCode: 0,
          };
        }
        throw new Error("unexpected command");
      },
    });

    expect(output).toContain("Unified diff:");
    expect(output).toContain("diff --git a/packages/cli/src/main.ts b/packages/cli/src/main.ts");
    expect(calls.map((call) => [call.command, ...call.args])).toEqual([
      ["test", "-e", "/repo/aigile/.worktrees/LIN-795"],
      ["git", "rev-parse", "--abbrev-ref", "HEAD"],
      ["git", "status", "--short"],
      ["git", "diff"],
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
    expect(output).toContain("Workspace diff: none");
    expect(output).toContain("run LIN-404 --agent-write");
  });

  it("includes persisted merged workflow run status when available", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aigile-status-run-"));
    try {
      const store = createFileRunStore({ directory });
      const seed = async (
        type: WorkflowEvent["type"],
        artifact?: WorkflowArtifact,
      ): Promise<void> => {
        await store.appendEvent(
          "LIN-900",
          {
            type,
            issueId: "LIN-900",
            ...(artifact === undefined ? {} : { artifactId: artifact.id }),
          },
          artifact === undefined ? [] : [artifact],
        );
      };
      await seed("issue_received");
      await seed("plan_drafted", {
        id: "plan",
        kind: "architect.plan",
        source: "agent",
        provenance: {
          runtime: {
            runtimeId: "architect-runtime",
            transport: "stdio",
            model: "planner",
            tokenUsage: { totalTokens: 100 },
          },
        },
        payload: {},
      });
      await seed("plan_approved");
      await seed("developer_finished", {
        id: "dev-1",
        kind: "developer.attempt",
        source: "agent",
        provenance: {
          runtime: {
            runtimeId: "developer-runtime",
            transport: "stdio",
            model: "coder",
            tokenUsage: { inputTokens: 20, outputTokens: 30 },
          },
        },
        payload: {},
      });
      await seed("verification_passed");
      await seed("checker_passed");
      await seed("merge_completed", {
        id: "github-pr:acme/aigile#17",
        kind: "github.pull_request",
        source: "github",
        payload: { url: "https://github.local/acme/aigile/pull/17" },
      });

      const output = await runIssueWorkspaceStatus({
        issueKey: "LIN-900",
        repoPath: "/repo/aigile",
        worktreesPath: "/repo/aigile/.worktrees",
        baseBranch: "main",
        runStatePath: directory,
        exec: async (command, args) => {
          if (command === "test") return { stdout: "", stderr: "", exitCode: 1 };
          throw new Error(`unexpected ${command} ${args.join(" ")}`);
        },
      });

      expect(output).toContain("Workflow run:");
      expect(output).toContain("Workflow state: merged");
      expect(output).toContain("Outcome: merged");
      expect(output).toContain("Pull request: https://github.local/acme/aigile/pull/17");
      expect(output).toContain("Developer attempts: 1");
      expect(output).toContain("Token usage: partial, 150 total (20 input, 30 output)");
      expect(output).toContain("State: missing");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("includes persisted escalated workflow run reason and attempt count", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aigile-status-escalated-"));
    try {
      const store = createFileRunStore({ directory });
      const events: WorkflowEvent[] = [
        { type: "issue_received", issueId: "LIN-901" },
        { type: "plan_drafted", issueId: "LIN-901" },
        { type: "plan_approved", issueId: "LIN-901" },
        { type: "developer_finished", issueId: "LIN-901" },
        { type: "verification_passed", issueId: "LIN-901" },
        { type: "checker_passed", issueId: "LIN-901" },
        { type: "publish_failed", issueId: "LIN-901", reason: "pull request has merge conflicts" },
      ];
      for (const event of events) await store.appendEvent("LIN-901", event);

      const output = await runIssueWorkspaceStatus({
        issueKey: "LIN-901",
        repoPath: "/repo/aigile",
        worktreesPath: "/repo/aigile/.worktrees",
        baseBranch: "main",
        runStatePath: directory,
        exec: async (command) => {
          if (command === "test") return { stdout: "", stderr: "", exitCode: 1 };
          throw new Error("unexpected command");
        },
      });

      expect(output).toContain("Workflow state: escalated");
      expect(output).toContain("Outcome: escalated");
      expect(output).toContain("Escalation reason: pull request has merge conflicts");
      expect(output).toContain("Developer attempts: 1");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("prints a clear no-run-state message for issue status with no persisted run", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aigile-status-empty-"));
    try {
      const output = await runIssueWorkspaceStatus({
        issueKey: "LIN-902",
        repoPath: "/repo/aigile",
        worktreesPath: "/repo/aigile/.worktrees",
        baseBranch: "main",
        runStatePath: directory,
        exec: async (command) => {
          if (command === "test") return { stdout: "", stderr: "", exitCode: 1 };
          throw new Error("unexpected command");
        },
      });

      expect(output).toContain("Workflow run:");
      expect(output).toContain("No persisted run state found for LIN-902.");
      expect(output).toContain("State: missing");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves workspace status when a persisted run file is corrupt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aigile-status-corrupt-"));
    try {
      writeFileSync(join(directory, "LIN-905.json"), "{not-json");

      const output = await runIssueWorkspaceStatus({
        issueKey: "LIN-905",
        repoPath: "/repo/aigile",
        worktreesPath: "/repo/aigile/.worktrees",
        baseBranch: "main",
        runStatePath: directory,
        exec: async (command) => {
          if (command === "test") return { stdout: "", stderr: "", exitCode: 1 };
          throw new Error("unexpected command");
        },
      });

      expect(output).toContain("Workflow run:");
      expect(output).toContain("No persisted run state found for LIN-905.");
      expect(output).toContain("Aigile status: LIN-905");
      expect(output).toContain("State: missing");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("lists resumable runs when workflow status has no issue key", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aigile-status-list-"));
    try {
      const store = createFileRunStore({ directory });
      await store.appendEvent("LIN-903", { type: "issue_received", issueId: "LIN-903" });
      for (const type of [
        "issue_received",
        "plan_drafted",
        "plan_approved",
        "developer_finished",
        "verification_passed",
        "checker_passed",
        "merge_completed",
      ] as const) {
        await store.appendEvent("LIN-904", { type, issueId: "LIN-904" });
      }

      const output = await runWorkflowRunStatus({ runStatePath: directory });

      expect(output).toContain("Resumable workflow runs:");
      expect(output).toContain("- LIN-903");
      expect(output).not.toContain("LIN-904");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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

  it("runs standalone product reconciliation without watch or start-run", async () => {
    const store = createInMemoryRunStore();
    await store.appendEvent("LIN-321", { type: "issue_received", issueId: "LIN-321" });
    const tracker = createFakeIssueTrackerAdapter([
      {
        id: "LIN-321",
        key: "LIN-321",
        title: "Done issue",
        description: "",
        acceptanceCriteria: [],
        status: "In Review",
        comments: [],
      },
    ]);
    const codeHost = createFakeCodeHostAdapter();
    const pr = await codeHost.createPullRequest({
      owner: "org",
      repo: "repo",
      branch: "aigile/LIN-321",
      baseBranch: "main",
      title: "LIN-321",
      body: "LIN-321",
    });
    await codeHost.mergePullRequest(pr.id);

    const output = await runReconcileProductsCli({
      apiKey: "linear-key",
      productConfig: {
        products: [
          {
            id: "product",
            linear: { team: "ENG", project: "Project" },
            github: { repo: "org/repo", baseBranch: "main" },
            defaultRun: { startRun: true, mode: "agent_write", publish: true },
          },
        ],
      },
      createRunStore: () => store,
      createTracker: () => tracker,
      createCodeHost: () => codeHost,
    });

    expect(output).toContain("Aigile reconcile: products");
    expect(output).toContain("product/LIN-321: updated In Review -> Done");
    expect(await tracker.getIssue("LIN-321")).toMatchObject({ status: "Done" });
  });

  it("prints reconcile reasons for manual policy holds", () => {
    const output = formatReconcileProductsResult([
      {
        kind: "unchanged",
        productId: "product",
        issueKey: "LIN-321",
        status: "In Review",
        reason: "held by manual merge policy",
        branchName: "aigile/LIN-321",
        target: { owner: "org", repo: "repo" },
      },
    ]);

    expect(output).toContain("product/LIN-321: unchanged In Review");
    expect(output).toContain("held by manual merge policy");
  });
});
