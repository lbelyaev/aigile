import { describe, expect, it } from "bun:test";
import {
  buildAcpRuntimeConnectInput,
  createAcpRoleRunner,
  type AcpRuntimeConnector,
} from "./index.js";

describe("ACP role runner", () => {
  it("emits progress while connecting, prompting, streaming, and stopping", async () => {
    const progress: string[] = [];
    let parsedPayload: unknown;
    let eventHandler:
      | ((
          event:
            | { type: "text_delta"; sessionId: string; delta: string }
            | {
                type: "permission_decision";
                sessionId: string;
                requestId: string;
                tool: string;
                description: string;
                decision: "allow_once" | "reject_once" | "cancelled";
              },
        ) => void)
      | undefined;
    const connector: AcpRuntimeConnector = async () => ({
      session: {
        sessionId: "role-session-1",
        acpSessionId: "acp-session-1",
        prompt: async () => {
          eventHandler?.({ type: "text_delta", sessionId: "role-session-1", delta: "working" });
          eventHandler?.({
            type: "permission_decision",
            sessionId: "role-session-1",
            requestId: "tool-1",
            tool: "Bash",
            description: JSON.stringify({ command: "git status --short" }),
            decision: "allow_once",
          });
          return {
            artifactKind: "architect.plan",
            payload: {
              summary: "Plan from ACP",
              scope: ["role runner"],
              acceptanceCriteria: ["artifact is parsed"],
              verificationCommands: ["bun run check"],
              risks: [],
            },
          };
        },
        cancel: () => undefined,
        onEvent: (handler) => {
          eventHandler = handler as typeof eventHandler;
          return () => {
            eventHandler = undefined;
          };
        },
      },
      process: {
        kill: async () => undefined,
      },
    });
    const runner = createAcpRoleRunner({
      connector,
      onProgress: (event) => {
        progress.push(event.type);
        if (event.type === "artifact_parsed") parsedPayload = event.artifactPayload;
      },
    });

    await runner.run({
      roleId: "architect",
      issueId: "LIN-123",
      runtime: {
        id: "runtime-architect",
        displayName: "Architect ACP",
        transport: "stdio",
        command: ["agent-acp"],
        defaultModel: "configured-model",
      },
      assignment: {
        roleId: "architect",
        runtimeProfileId: "runtime-architect",
      },
      inputArtifacts: [],
    });

    expect(progress).toEqual([
      "role_started",
      "runtime_connecting",
      "runtime_connected",
      "prompt_started",
      "text_delta",
      "permission_decision",
      "artifact_parsed",
      "runtime_stopped",
    ]);
    expect(parsedPayload).toEqual({
      summary: "Plan from ACP",
      scope: ["role runner"],
      acceptanceCriteria: ["artifact is parsed"],
      verificationCommands: ["bun run check"],
      risks: [],
    });
  });

  it("emits tool progress with raw input details", async () => {
    const toolProgress: Array<{ type: "tool_start" | "tool_end"; tool: string; detail?: string }> =
      [];
    let eventHandler:
      | ((
          event:
            | {
                type: "tool_start";
                sessionId: string;
                tool: string;
                toolCallId?: string;
                params?: unknown;
              }
            | {
                type: "tool_end";
                sessionId: string;
                tool: string;
                toolCallId?: string;
              },
        ) => void)
      | undefined;
    const connector: AcpRuntimeConnector = async () => ({
      session: {
        sessionId: "role-session-1",
        acpSessionId: "acp-session-1",
        prompt: async () => {
          eventHandler?.({
            type: "tool_start",
            sessionId: "role-session-1",
            tool: "Bash",
            toolCallId: "tool-1",
            params: { command: "bun test packages/cli/src/main.test.ts" },
          });
          eventHandler?.({
            type: "tool_end",
            sessionId: "role-session-1",
            tool: "Bash",
            toolCallId: "tool-1",
          });
          return {
            artifactKind: "developer.attempt",
            payload: {
              summary: "Tool detail emitted.",
              changedFiles: [],
              verificationNotes: "No verification needed.",
            },
          };
        },
        cancel: () => undefined,
        onEvent: (handler) => {
          eventHandler = handler as typeof eventHandler;
          return () => {
            eventHandler = undefined;
          };
        },
      },
      process: {
        kill: async () => undefined,
      },
    });
    const runner = createAcpRoleRunner({
      connector,
      onProgress: (event) => {
        if (event.type === "tool_start" || event.type === "tool_end") {
          toolProgress.push({
            type: event.type,
            tool: event.tool,
            ...(event.detail === undefined ? {} : { detail: event.detail }),
          });
        }
      },
    });

    await runner.run({
      roleId: "developer",
      issueId: "LIN-123",
      runtime: {
        id: "runtime-developer",
        transport: "stdio",
        command: ["agent-acp"],
      },
      assignment: {
        roleId: "developer",
        runtimeProfileId: "runtime-developer",
      },
      inputArtifacts: [],
    });

    expect(toolProgress).toEqual([
      {
        type: "tool_start",
        tool: "Bash",
        detail: "bun test packages/cli/src/main.test.ts",
      },
      {
        type: "tool_end",
        tool: "Bash",
        detail: "bun test packages/cli/src/main.test.ts",
      },
    ]);
  });

  it("builds ACP-standard initialize and session params for stdio runtimes", () => {
    const connectInput = buildAcpRuntimeConnectInput({
      roleId: "architect",
      issueId: "LIN-123",
      runtime: {
        id: "runtime-architect",
        transport: "stdio",
        command: ["agent-acp"],
        cwd: "/repo/aigile",
        envPassthrough: ["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"],
      },
      assignment: {
        roleId: "architect",
        runtimeProfileId: "runtime-architect",
      },
      inputArtifacts: [],
    });

    expect(connectInput).toMatchObject({
      command: ["agent-acp"],
      cwd: "/repo/aigile",
      envPassthrough: ["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"],
      sessionId: "LIN-123:architect",
      initializeParams: {
        protocolVersion: 1,
        clientCapabilities: {},
      },
      sessionParams: {
        cwd: "/repo/aigile",
        mcpServers: [],
      },
    });
    expect(connectInput.sessionParams).not.toHaveProperty("model");
    expect(connectInput.promptTimeoutMs).toBe(30 * 60 * 1_000);
  });

  it("substitutes defaultModel in runtime command arguments", () => {
    const connectInput = buildAcpRuntimeConnectInput({
      roleId: "developer",
      issueId: "LIN-123",
      runtime: {
        id: "codex-acp",
        transport: "stdio",
        command: ["codex-acp", "-c", 'model="${defaultModel}"'],
        defaultModel: "gpt-5.5",
      },
      assignment: {
        roleId: "developer",
        runtimeProfileId: "codex-acp",
      },
      inputArtifacts: [],
    });

    expect(connectInput.command).toEqual(["codex-acp", "-c", 'model="gpt-5.5"']);
    expect(connectInput.sessionParams.model).toBe("gpt-5.5");
  });

  it("allows the ACP prompt timeout to be configured for runtime connects", () => {
    const connectInput = buildAcpRuntimeConnectInput(
      {
        roleId: "architect",
        issueId: "LIN-123",
        runtime: {
          id: "runtime-architect",
          transport: "stdio",
          command: ["agent-acp"],
        },
        assignment: {
          roleId: "architect",
          runtimeProfileId: "runtime-architect",
        },
        inputArtifacts: [],
      },
      { promptTimeoutMs: 2_500 },
    );

    expect(connectInput.promptTimeoutMs).toBe(2_500);
  });

  it("builds a dry-run permission policy from execution policy artifacts", () => {
    const connectInput = buildAcpRuntimeConnectInput({
      roleId: "developer",
      issueId: "LIN-123",
      runtime: {
        id: "runtime-developer",
        transport: "stdio",
        command: ["agent-acp"],
      },
      assignment: {
        roleId: "developer",
        runtimeProfileId: "runtime-developer",
      },
      inputArtifacts: [
        {
          id: "policy:LIN-123:dry-run",
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
    });

    expect(
      connectInput.decidePermission?.({
        sessionId: "LIN-123:developer",
        requestId: "tool-1",
        tool: "Bash",
        description: JSON.stringify({ command: "git commit -m test" }),
        options: [],
      }),
    ).toBe("reject_once");
    expect(
      connectInput.decidePermission?.({
        sessionId: "LIN-123:developer",
        requestId: "tool-2",
        tool: "Edit",
        description: "/repo/README.md",
        options: [],
      }),
    ).toBe("reject_once");
    expect(
      connectInput.decidePermission?.({
        sessionId: "LIN-123:developer",
        requestId: "tool-3",
        tool: "Bash",
        description: JSON.stringify({ command: "git status --short" }),
        options: [],
      }),
    ).toBe("allow_once");
    expect(
      connectInput.decidePermission?.({
        sessionId: "LIN-123:developer",
        requestId: "tool-4",
        tool: "Bash",
        description: JSON.stringify({ command: "find . -type f" }),
        options: [],
      }),
    ).toBe("reject_once");
    expect(
      connectInput.decidePermission?.({
        sessionId: "LIN-123:developer",
        requestId: "tool-5",
        tool: "Bash",
        description: JSON.stringify({ command: "rg TODO" }),
        options: [],
      }),
    ).toBe("reject_once");
    expect(
      connectInput.decidePermission?.({
        sessionId: "LIN-123:developer",
        requestId: "tool-6",
        tool: "Bash",
        description: JSON.stringify({ command: "rg TODO packages/roles/src/acp-runner.ts" }),
        options: [],
      }),
    ).toBe("allow_once");
  });

  it("allows edits but blocks commits for agent-write execution policy", () => {
    const connectInput = buildAcpRuntimeConnectInput({
      roleId: "developer",
      issueId: "LIN-123",
      runtime: {
        id: "runtime-developer",
        transport: "stdio",
        command: ["agent-acp"],
      },
      assignment: {
        roleId: "developer",
        runtimeProfileId: "runtime-developer",
      },
      inputArtifacts: [
        {
          id: "policy:LIN-123:agent-write",
          kind: "execution.policy",
          source: "system",
          payload: {
            mode: "agent_write",
            fileWrites: "allowed",
            commits: "forbidden",
            shellCommands: "workspace",
          },
        },
      ],
    });

    expect(
      connectInput.decidePermission?.({
        sessionId: "LIN-123:developer",
        requestId: "tool-1",
        tool: "Edit",
        description: "/repo/README.md",
        options: [],
      }),
    ).toBe("allow_once");
    for (const tool of ["Write", "MultiEdit", "NotebookEdit"] as const) {
      expect(
        connectInput.decidePermission?.({
          sessionId: "LIN-123:developer",
          requestId: `tool-${tool}`,
          tool,
          description: "/repo/README.md",
          options: [],
        }),
      ).toBe("allow_once");
    }
    expect(
      connectInput.decidePermission?.({
        sessionId: "LIN-123:developer",
        requestId: "tool-2",
        tool: "Bash",
        description: JSON.stringify({ command: "git commit -m test" }),
        options: [],
      }),
    ).toBe("reject_once");
    expect(
      connectInput.decidePermission?.({
        sessionId: "LIN-123:developer",
        requestId: "tool-3",
        tool: "Bash",
        description: JSON.stringify({ command: "ls -R ." }),
        options: [],
      }),
    ).toBe("reject_once");
    for (const [requestId, command] of [
      ["tool-4", "git add packages/demo/src/run.ts"],
      ["tool-5", "git -C /repo/aigile commit -m test"],
      ["tool-6", "cd /repo/aigile && git push origin aigile/LIN-123"],
      ["tool-7", "git merge main"],
      ["tool-8", "git rebase main"],
      ["tool-9", "git reset --hard"],
      ["tool-9-newline", "echo ready\ngit push origin aigile/LIN-123"],
      ["tool-9-pr", "gh pr create --fill"],
      ["tool-9-hub-pr", "echo ready\nhub pull-request"],
    ] as const) {
      expect(
        connectInput.decidePermission?.({
          sessionId: "LIN-123:developer",
          requestId,
          tool: "Bash",
          description: JSON.stringify({ command }),
          options: [],
        }),
      ).toBe("reject_once");
    }
    expect(
      connectInput.decidePermission?.({
        sessionId: "LIN-123:developer",
        requestId: "tool-10",
        tool: "Bash",
        description: JSON.stringify({ command: "cd /repo/aigile && find . -type f" }),
        options: [],
      }),
    ).toBe("reject_once");
    for (const [requestId, command] of [
      ["tool-10-git-ls-files", "git ls-files"],
      ["tool-10-git-grep", "git grep TODO"],
      ["tool-10-grep-r", "grep -R TODO ."],
      ["tool-10-rg", "rg TODO"],
    ] as const) {
      expect(
        connectInput.decidePermission?.({
          sessionId: "LIN-123:developer",
          requestId,
          tool: "Bash",
          description: JSON.stringify({ command }),
          options: [],
        }),
      ).toBe("reject_once");
    }
    expect(
      connectInput.decidePermission?.({
        sessionId: "LIN-123:developer",
        requestId: "tool-11",
        tool: "Bash",
        description: JSON.stringify({ command: "bun test packages/roles/src/acp-runner.test.ts" }),
        options: [],
      }),
    ).toBe("allow_once");
  });

  it("allows read-only review tooling and rejects writes under review execution policy", () => {
    const connectInput = buildAcpRuntimeConnectInput({
      roleId: "checker",
      issueId: "LIN-123",
      runtime: {
        id: "runtime-checker",
        transport: "stdio",
        command: ["agent-acp"],
      },
      assignment: {
        roleId: "checker",
        runtimeProfileId: "runtime-checker",
      },
      inputArtifacts: [
        {
          id: "policy:LIN-123:review",
          kind: "execution.policy",
          source: "system",
          payload: {
            mode: "review",
            fileWrites: "forbidden",
            commits: "forbidden",
            pushes: "forbidden",
            shellCommands: "review_read_only",
          },
        },
      ],
    });

    for (const [requestId, command] of [
      ["review-read", "cat packages/roles/src/acp-runner.ts"],
      ["review-sed", "sed -n '1,120p' packages/roles/src/acp-runner.ts"],
      ["review-rg-targeted", "rg TODO packages/roles/src/acp-runner.ts"],
      ["review-rg-broad", "rg TODO"],
      ["review-rg-pr-mutation-pattern", 'rg "gh pr merge" packages/roles/src/acp-runner.ts'],
      [
        "review-rg-linear-mutation-pattern",
        'rg "mcp__linear__update_issue" packages/roles/src/acp-runner.test.ts',
      ],
      ["review-grep-broad", "grep -R TODO ."],
      ["review-diff", "git diff"],
      ["review-log", "git log --oneline -5"],
      ["review-show", "git show HEAD -- packages/roles/src/acp-runner.ts"],
      ["review-bun-test", "bun test packages/roles/src/acp-runner.test.ts"],
      ["review-bun-check", "bun run check"],
      ["review-tsc", "npx tsc --noEmit"],
      ["review-oracle", "bun test packages/roles/src/prompts.test.ts"],
    ] as const) {
      expect(
        connectInput.decidePermission?.({
          sessionId: "LIN-123:checker",
          requestId,
          tool: "Bash",
          kind: "execute",
          description: JSON.stringify({ command }),
          options: [],
        }),
      ).toBe("allow_once");
    }

    for (const [requestId, command] of [
      ["review-edit-shell", "printf test > README.md"],
      ["review-touch", "touch README.md"],
      ["review-git-add", "git add packages/roles/src/acp-runner.ts"],
      ["review-git-commit", "git commit -m test"],
      ["review-git-push", "git push origin aigile/LIN-123"],
      ["review-git-merge", "git merge main"],
      ["review-git-rebase", "git rebase main"],
      ["review-git-reset", "git reset --hard"],
      ["review-pr-create", "gh pr create --fill"],
      ["review-hub-pr", "hub pull-request"],
      ["review-build", "bun run build"],
    ] as const) {
      expect(
        connectInput.decidePermission?.({
          sessionId: "LIN-123:checker",
          requestId,
          tool: "Bash",
          kind: "execute",
          description: JSON.stringify({ command }),
          options: [],
        }),
      ).toBe("reject_once");
    }

    expect(
      connectInput.decidePermission?.({
        sessionId: "LIN-123:checker",
        requestId: "review-read-kind",
        tool: "Read",
        kind: "read",
        description: "/repo/aigile/packages/roles/src/acp-runner.ts",
        options: [],
      }),
    ).toBe("allow_once");
    expect(
      connectInput.decidePermission?.({
        sessionId: "LIN-123:checker",
        requestId: "review-search-kind",
        tool: "Search",
        kind: "search",
        description: JSON.stringify({ command: "rg TODO" }),
        options: [],
      }),
    ).toBe("allow_once");
    expect(
      connectInput.decidePermission?.({
        sessionId: "LIN-123:checker",
        requestId: "review-search-kind-pr-pattern",
        tool: "Search",
        kind: "search",
        description: JSON.stringify({ command: 'rg "gh pr merge"' }),
        options: [],
      }),
    ).toBe("allow_once");
    expect(
      connectInput.decidePermission?.({
        sessionId: "LIN-123:checker",
        requestId: "review-write-kind",
        tool: "Write",
        kind: "write",
        description: "/repo/aigile/README.md",
        options: [],
      }),
    ).toBe("reject_once");
    for (const [requestId, tool] of [
      ["review-linear-update", "mcp__linear__update_issue"],
      ["review-linear-comment", "mcp__linear__create_comment"],
      ["review-github-pr-review", "mcp__github__create_pull_request_review"],
      ["review-github-pr-merge", "mcp__github__merge_pull_request"],
    ] as const) {
      expect(
        connectInput.decidePermission?.({
          sessionId: "LIN-123:checker",
          requestId,
          tool,
          kind: "read",
          description: tool,
          options: [],
        }),
      ).toBe("reject_once");
    }
  });

  it("uses an injected deep-review policy over inherited agent-write policy", () => {
    const connectInput = buildAcpRuntimeConnectInput({
      roleId: "deep_reviewer",
      issueId: "LIN-123",
      runtime: {
        id: "runtime-deep-reviewer",
        transport: "stdio",
        command: ["agent-acp"],
      },
      assignment: {
        roleId: "deep_reviewer",
        runtimeProfileId: "runtime-deep-reviewer",
      },
      inputArtifacts: [
        {
          id: "policy:LIN-123:agent-write",
          kind: "execution.policy",
          source: "system",
          payload: {
            mode: "agent_write",
            fileWrites: "allowed",
            commits: "forbidden",
            shellCommands: "workspace",
          },
        },
        {
          id: "policy:LIN-123:deep-review",
          kind: "execution.policy",
          source: "system",
          payload: {
            mode: "review",
            fileWrites: "forbidden",
            commits: "forbidden",
            pushes: "forbidden",
            shellCommands: "review_read_only",
          },
        },
      ],
    });

    expect(
      connectInput.decidePermission?.({
        sessionId: "LIN-123:deep_reviewer",
        requestId: "deep-review-edit",
        tool: "Edit",
        kind: "edit",
        description: "/repo/aigile/README.md",
        options: [],
      }),
    ).toBe("reject_once");
    expect(
      connectInput.decidePermission?.({
        sessionId: "LIN-123:deep_reviewer",
        requestId: "deep-review-read",
        tool: "Bash",
        kind: "execute",
        description: JSON.stringify({ command: "git diff" }),
        options: [],
      }),
    ).toBe("allow_once");
  });

  it("classifies agent-write permissions by ACP tool kind regardless of tool label", () => {
    const connectInput = buildAcpRuntimeConnectInput({
      roleId: "developer",
      issueId: "LIN-123",
      runtime: { id: "runtime-developer", transport: "stdio", command: ["agent-acp"] },
      assignment: { roleId: "developer", runtimeProfileId: "runtime-developer" },
      inputArtifacts: [
        {
          id: "policy:LIN-123:agent-write",
          kind: "execution.policy",
          source: "system",
          payload: {
            mode: "agent_write",
            fileWrites: "allowed",
            commits: "forbidden",
            shellCommands: "workspace",
          },
        },
      ],
    });

    // codex labels shell calls with the command text and kind "execute"
    expect(
      connectInput.decidePermission?.({
        sessionId: "LIN-123:developer",
        requestId: "exec-1",
        tool: "bun run typecheck",
        kind: "execute",
        description: JSON.stringify({ command: "bun run typecheck" }),
        options: [],
      }),
    ).toBe("allow_once");
    // destructive / commit execute is still rejected
    expect(
      connectInput.decidePermission?.({
        sessionId: "LIN-123:developer",
        requestId: "exec-2",
        tool: "git commit -m wip",
        kind: "execute",
        description: JSON.stringify({ command: "git commit -m wip" }),
        options: [],
      }),
    ).toBe("reject_once");
    // edit kind is allowed even when the tool label is not "Edit"
    expect(
      connectInput.decidePermission?.({
        sessionId: "LIN-123:developer",
        requestId: "edit-1",
        tool: "apply_patch",
        kind: "edit",
        description: "/repo/aigile/packages/acp/src/process.ts",
        options: [],
      }),
    ).toBe("allow_once");
    // broad-discovery execute is rejected regardless of label
    expect(
      connectInput.decidePermission?.({
        sessionId: "LIN-123:developer",
        requestId: "exec-3",
        tool: "find . -type f",
        kind: "execute",
        description: JSON.stringify({ command: "find . -type f" }),
        options: [],
      }),
    ).toBe("reject_once");
  });

  it("allows broad read-only discovery for architect as warning-only under agent-write", () => {
    const connectInput = buildAcpRuntimeConnectInput({
      roleId: "architect",
      issueId: "LIN-123",
      runtime: { id: "runtime-architect", transport: "stdio", command: ["agent-acp"] },
      assignment: { roleId: "architect", runtimeProfileId: "runtime-architect" },
      inputArtifacts: [
        {
          id: "policy:LIN-123:agent-write",
          kind: "execution.policy",
          source: "system",
          payload: {
            mode: "agent_write",
            fileWrites: "allowed",
            commits: "forbidden",
            shellCommands: "workspace",
          },
        },
      ],
    });

    expect(
      connectInput.decidePermission?.({
        sessionId: "LIN-123:architect",
        requestId: "search-1",
        tool: "grep",
        kind: "search",
        description: "grep",
        options: [],
      }),
    ).toBe("allow_once");
    expect(
      connectInput.decidePermission?.({
        sessionId: "LIN-123:architect",
        requestId: "exec-1",
        tool: "Terminal",
        kind: "execute",
        description: JSON.stringify({ command: "grep TODO" }),
        options: [],
      }),
    ).toBe("allow_once");
  });

  it("rejects writes and non-read execution by ACP tool kind in dry-run", () => {
    const connectInput = buildAcpRuntimeConnectInput({
      roleId: "developer",
      issueId: "LIN-123",
      runtime: { id: "runtime-developer", transport: "stdio", command: ["agent-acp"] },
      assignment: { roleId: "developer", runtimeProfileId: "runtime-developer" },
      inputArtifacts: [
        {
          id: "policy:LIN-123:dry-run",
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
    });

    // edit kind rejected in dry-run even with a non-"Edit" label
    expect(
      connectInput.decidePermission?.({
        sessionId: "LIN-123:developer",
        requestId: "edit-1",
        tool: "apply_patch",
        kind: "edit",
        description: "/repo/aigile/packages/acp/src/process.ts",
        options: [],
      }),
    ).toBe("reject_once");
    // non-read execute rejected
    expect(
      connectInput.decidePermission?.({
        sessionId: "LIN-123:developer",
        requestId: "exec-1",
        tool: "bun run typecheck",
        kind: "execute",
        description: JSON.stringify({ command: "bun run typecheck" }),
        options: [],
      }),
    ).toBe("reject_once");
    // read-only execute allowed
    expect(
      connectInput.decidePermission?.({
        sessionId: "LIN-123:developer",
        requestId: "exec-2",
        tool: "git status --short",
        kind: "execute",
        description: JSON.stringify({ command: "git status --short" }),
        options: [],
      }),
    ).toBe("allow_once");
  });

  it("warns on broad-discovery tool starts under agent-write policy without failing the run", async () => {
    const progress: string[] = [];
    let killed = false;
    let eventHandler:
      | ((event: { type: "tool_start"; sessionId: string; tool: string; params?: unknown }) => void)
      | undefined;
    const connector: AcpRuntimeConnector = async () => ({
      session: {
        sessionId: "role-session-1",
        acpSessionId: "acp-session-1",
        prompt: async () => {
          eventHandler?.({
            type: "tool_start",
            sessionId: "role-session-1",
            tool: "Bash",
            params: { command: "cd /repo/aigile && rg TODO" },
          });
          return {
            artifactKind: "developer.attempt",
            payload: {
              summary: "Attempt should be rejected.",
              changedFiles: [],
              verificationNotes: "Policy should stop broad discovery.",
            },
          };
        },
        cancel: () => undefined,
        onEvent: (handler) => {
          eventHandler = handler as typeof eventHandler;
          return () => {
            eventHandler = undefined;
          };
        },
      },
      process: {
        kill: async () => {
          killed = true;
        },
      },
    });
    const runner = createAcpRoleRunner({
      connector,
      onProgress: (event) => progress.push(event.type),
    });

    await expect(
      runner.run({
        roleId: "developer",
        issueId: "LIN-123",
        runtime: {
          id: "runtime-developer",
          transport: "stdio",
          command: ["agent-acp"],
        },
        assignment: {
          roleId: "developer",
          runtimeProfileId: "runtime-developer",
        },
        inputArtifacts: [
          {
            id: "policy:LIN-123:agent-write",
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
      }),
    ).resolves.toMatchObject({ kind: "developer.attempt" });
    // Broad discovery is denied per-call and warned, but the run completes.
    expect(progress).toContain("policy_violation");
    expect(progress).toContain("artifact_parsed");
    expect(killed).toBe(true);
  });

  it("kills the runtime when setup after connect throws", async () => {
    const progress: string[] = [];
    let killCount = 0;
    const connector: AcpRuntimeConnector = async () => ({
      session: {
        sessionId: "role-session-1",
        acpSessionId: "acp-session-1",
        prompt: async () => {
          throw new Error("prompt should not start");
        },
        cancel: () => undefined,
        onEvent: () => {
          throw new Error("subscribe failed");
        },
      },
      process: {
        kill: async () => {
          killCount += 1;
        },
      },
    });
    const runner = createAcpRoleRunner({
      connector,
      onProgress: (event) => progress.push(event.type),
    });

    await expect(
      runner.run({
        roleId: "developer",
        issueId: "LIN-123",
        runtime: {
          id: "runtime-developer",
          transport: "stdio",
          command: ["agent-acp"],
        },
        assignment: {
          roleId: "developer",
          runtimeProfileId: "runtime-developer",
        },
        inputArtifacts: [],
      }),
    ).rejects.toThrow("subscribe failed");
    expect(killCount).toBe(1);
    expect(progress).toContain("runtime_stopped");
    expect(progress).not.toContain("prompt_started");
  });

  it("runs a role through an ACP runtime and returns an artifact", async () => {
    const prompts: string[] = [];
    let killed = false;
    const connector: AcpRuntimeConnector = async () => ({
      session: {
        sessionId: "role-session-1",
        acpSessionId: "acp-session-1",
        prompt: async (text: string) => {
          prompts.push(text);
          return {
            artifactKind: "architect.plan",
            payload: {
              summary: "Plan from ACP",
              scope: ["role runner"],
              acceptanceCriteria: ["artifact is parsed"],
              verificationCommands: ["bun run check"],
              risks: [],
            },
          };
        },
        cancel: () => undefined,
        onEvent: () => () => undefined,
      },
      process: {
        kill: async () => {
          killed = true;
        },
      },
    });
    const runner = createAcpRoleRunner({ connector });

    const artifact = await runner.run({
      roleId: "architect",
      issueId: "LIN-123",
      runtime: {
        id: "runtime-architect",
        displayName: "Architect ACP",
        transport: "stdio",
        command: ["agent-acp"],
        defaultModel: "configured-model",
      },
      assignment: {
        roleId: "architect",
        runtimeProfileId: "runtime-architect",
        instructionRef: "roles/architect.md",
      },
      inputArtifacts: [
        {
          id: "linear:LIN-123",
          kind: "linear.issue",
          source: "linear",
          payload: { title: "Build the runner" },
        },
      ],
    });

    expect(prompts[0]).toContain("Role: architect");
    expect(prompts[0]).toContain("linear.issue");
    expect(artifact).toEqual({
      id: "agent:LIN-123:architect:architect.plan",
      kind: "architect.plan",
      source: "agent",
      producerRoleId: "architect",
      provenance: {
        runtime: {
          runtimeId: "runtime-architect",
          runtimeDisplayName: "Architect ACP",
          transport: "stdio",
          command: ["agent-acp"],
          model: "configured-model",
        },
      },
      payload: {
        summary: "Plan from ACP",
        scope: ["role runner"],
        acceptanceCriteria: ["artifact is parsed"],
        verificationCommands: ["bun run check"],
        risks: [],
      },
    });
    expect(killed).toBe(true);
  });

  it("records runtime token usage in artifact provenance", async () => {
    let eventHandler:
      | ((event: {
          type: "token_usage";
          sessionId: string;
          usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
        }) => void)
      | undefined;
    const connector: AcpRuntimeConnector = async () => ({
      session: {
        sessionId: "role-session-1",
        acpSessionId: "acp-session-1",
        prompt: async () => {
          eventHandler?.({
            type: "token_usage",
            sessionId: "role-session-1",
            usage: {
              inputTokens: 1200,
              outputTokens: 500,
              totalTokens: 1700,
            },
          });
          return {
            artifactKind: "architect.plan",
            payload: {
              summary: "Plan from ACP",
              scope: ["role runner"],
              acceptanceCriteria: ["artifact is parsed"],
              verificationCommands: ["bun run check"],
              risks: [],
            },
          };
        },
        cancel: () => undefined,
        onEvent: (handler) => {
          eventHandler = handler as typeof eventHandler;
          return () => {
            eventHandler = undefined;
          };
        },
      },
      process: {
        kill: async () => undefined,
      },
    });
    const runner = createAcpRoleRunner({ connector });

    const artifact = await runner.run({
      roleId: "architect",
      issueId: "LIN-123",
      runtime: {
        id: "runtime-architect",
        transport: "stdio",
        command: ["agent-acp"],
      },
      assignment: {
        roleId: "architect",
        runtimeProfileId: "runtime-architect",
      },
      inputArtifacts: [],
    });

    expect(artifact.provenance?.runtime?.tokenUsage).toEqual({
      inputTokens: 1200,
      outputTokens: 500,
      totalTokens: 1700,
    });
  });

  it("warns on broad-discovery tool starts under dry-run policy without failing the run", async () => {
    const progress: string[] = [];
    let killed = false;
    let eventHandler:
      | ((event: { type: "tool_start"; sessionId: string; tool: string; params?: unknown }) => void)
      | undefined;
    const connector: AcpRuntimeConnector = async () => ({
      session: {
        sessionId: "role-session-1",
        acpSessionId: "acp-session-1",
        prompt: async () => {
          eventHandler?.({
            type: "tool_start",
            sessionId: "role-session-1",
            tool: 'find /repo/aigile -type f -name "*.ts"',
          });
          return {
            artifactKind: "architect.plan",
            payload: {
              summary: "Plan from ACP",
              scope: ["role runner"],
              acceptanceCriteria: ["artifact is parsed"],
              verificationCommands: ["bun run check"],
              risks: [],
            },
          };
        },
        cancel: () => undefined,
        onEvent: (handler) => {
          eventHandler = handler as typeof eventHandler;
          return () => {
            eventHandler = undefined;
          };
        },
      },
      process: {
        kill: async () => {
          killed = true;
        },
      },
    });
    const runner = createAcpRoleRunner({
      connector,
      onProgress: (event) => progress.push(event.type),
    });

    await expect(
      runner.run({
        roleId: "architect",
        issueId: "LIN-123",
        runtime: {
          id: "runtime-architect",
          transport: "stdio",
          command: ["agent-acp"],
        },
        assignment: {
          roleId: "architect",
          runtimeProfileId: "runtime-architect",
        },
        inputArtifacts: [
          {
            id: "policy:LIN-123:dry-run",
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
      }),
    ).resolves.toMatchObject({ kind: "architect.plan" });
    // Broad discovery is denied per-call and warned, but the run completes.
    expect(progress).toContain("policy_violation");
    expect(progress).toContain("artifact_parsed");
    expect(killed).toBe(true);
  });

  it("rejects observed file reads above the execution budget", async () => {
    const progress: string[] = [];
    let killed = false;
    let eventHandler:
      | ((event: { type: "tool_start"; sessionId: string; tool: string; params?: unknown }) => void)
      | undefined;
    const connector: AcpRuntimeConnector = async () => ({
      session: {
        sessionId: "role-session-1",
        acpSessionId: "acp-session-1",
        prompt: async () => {
          for (let index = 1; index <= 6; index += 1) {
            eventHandler?.({
              type: "tool_start",
              sessionId: "role-session-1",
              tool: "Read File",
              params: { path: `/repo/file-${index}.ts` },
            });
          }
          return {
            artifactKind: "architect.plan",
            payload: {
              summary: "Plan from ACP",
              scope: ["role runner"],
              acceptanceCriteria: ["artifact is parsed"],
              verificationCommands: ["bun run check"],
              risks: [],
            },
          };
        },
        cancel: () => undefined,
        onEvent: (handler) => {
          eventHandler = handler as typeof eventHandler;
          return () => {
            eventHandler = undefined;
          };
        },
      },
      process: {
        kill: async () => {
          killed = true;
        },
      },
    });
    const runner = createAcpRoleRunner({
      connector,
      onProgress: (event) => progress.push(event.type),
    });

    await expect(
      runner.run({
        roleId: "architect",
        issueId: "LIN-123",
        runtime: {
          id: "runtime-architect",
          transport: "stdio",
          command: ["agent-acp"],
        },
        assignment: {
          roleId: "architect",
          runtimeProfileId: "runtime-architect",
        },
        inputArtifacts: [
          {
            id: "policy:LIN-123:dry-run",
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
      }),
    ).rejects.toThrow(/Policy violation file_read_budget/);
    expect(progress).toContain("policy_violation");
    expect(progress).not.toContain("artifact_parsed");
    expect(killed).toBe(true);
  });

  it("allows focused file reads above the dry-run budget for agent-write runs", async () => {
    const progress: string[] = [];
    let eventHandler:
      | ((event: { type: "tool_start"; sessionId: string; tool: string; params?: unknown }) => void)
      | undefined;
    const connector: AcpRuntimeConnector = async () => ({
      session: {
        sessionId: "role-session-1",
        acpSessionId: "acp-session-1",
        prompt: async () => {
          for (let index = 1; index <= 6; index += 1) {
            eventHandler?.({
              type: "tool_start",
              sessionId: "role-session-1",
              tool: "Read File",
              params: { path: `/repo/file-${index}.ts` },
            });
          }
          return {
            artifactKind: "developer.attempt",
            payload: {
              summary: "Agent-write inspected focused files.",
              changedFiles: [],
              verificationNotes: "No changes required.",
            },
          };
        },
        cancel: () => undefined,
        onEvent: (handler) => {
          eventHandler = handler as typeof eventHandler;
          return () => {
            eventHandler = undefined;
          };
        },
      },
      process: {
        kill: async () => undefined,
      },
    });
    const runner = createAcpRoleRunner({
      connector,
      onProgress: (event) => progress.push(event.type),
    });

    await expect(
      runner.run({
        roleId: "developer",
        issueId: "LIN-123",
        runtime: {
          id: "runtime-developer",
          transport: "stdio",
          command: ["agent-acp"],
        },
        assignment: {
          roleId: "developer",
          runtimeProfileId: "runtime-developer",
        },
        inputArtifacts: [
          {
            id: "policy:LIN-123:agent-write",
            kind: "execution.policy",
            source: "system",
            payload: {
              mode: "agent_write",
              fileWrites: "allowed",
              commits: "forbidden",
              shellCommands: "workspace",
            },
          },
        ],
      }),
    ).resolves.toMatchObject({
      kind: "developer.attempt",
    });
    expect(progress).not.toContain("policy_violation");
    expect(progress).toContain("artifact_parsed");
  });

  it("allows broad review searches and file reads without dry-run budget violations", async () => {
    const progress: string[] = [];
    let eventHandler:
      | ((event: { type: "tool_start"; sessionId: string; tool: string; params?: unknown }) => void)
      | undefined;
    const connector: AcpRuntimeConnector = async () => ({
      session: {
        sessionId: "role-session-1",
        acpSessionId: "acp-session-1",
        prompt: async () => {
          eventHandler?.({
            type: "tool_start",
            sessionId: "role-session-1",
            tool: "Bash",
            params: { command: "rg TODO" },
          });
          for (let index = 1; index <= 6; index += 1) {
            eventHandler?.({
              type: "tool_start",
              sessionId: "role-session-1",
              tool: "Read File",
              params: { path: `/repo/file-${index}.ts` },
            });
          }
          return {
            artifactKind: "checker.verdict",
            payload: {
              verdict: "pass",
              summary: "Review policy allowed investigation.",
              reasons: [],
            },
          };
        },
        cancel: () => undefined,
        onEvent: (handler) => {
          eventHandler = handler as typeof eventHandler;
          return () => {
            eventHandler = undefined;
          };
        },
      },
      process: {
        kill: async () => undefined,
      },
    });
    const runner = createAcpRoleRunner({
      connector,
      onProgress: (event) => progress.push(event.type),
    });

    await expect(
      runner.run({
        roleId: "checker",
        issueId: "LIN-123",
        runtime: {
          id: "runtime-checker",
          transport: "stdio",
          command: ["agent-acp"],
        },
        assignment: {
          roleId: "checker",
          runtimeProfileId: "runtime-checker",
        },
        inputArtifacts: [
          {
            id: "policy:LIN-123:review",
            kind: "execution.policy",
            source: "system",
            payload: {
              mode: "review",
              fileWrites: "forbidden",
              commits: "forbidden",
              pushes: "forbidden",
              shellCommands: "review_read_only",
            },
          },
        ],
      }),
    ).resolves.toMatchObject({
      kind: "checker.verdict",
    });
    expect(progress).not.toContain("policy_violation");
    expect(progress).toContain("artifact_parsed");
  });

  it("parses artifact JSON from streamed ACP text events", async () => {
    let eventHandler:
      | ((event: { type: "text_delta"; sessionId: string; delta: string }) => void)
      | undefined;
    const connector: AcpRuntimeConnector = async () => ({
      session: {
        sessionId: "role-session-1",
        acpSessionId: "acp-session-1",
        prompt: async () => {
          eventHandler?.({
            type: "text_delta",
            sessionId: "role-session-1",
            delta: JSON.stringify({
              artifactKind: "checker.verdict",
              payload: {
                verdict: "pass",
                summary: "Streamed verdict",
                reasons: [],
              },
            }),
          });
          return undefined;
        },
        cancel: () => undefined,
        onEvent: (handler) => {
          eventHandler = handler as typeof eventHandler;
          return () => {
            eventHandler = undefined;
          };
        },
      },
      process: {
        kill: async () => undefined,
      },
    });
    const runner = createAcpRoleRunner({ connector });

    const artifact = await runner.run({
      roleId: "checker",
      issueId: "LIN-123",
      runtime: {
        id: "runtime-checker",
        transport: "stdio",
        command: ["agent-acp"],
      },
      assignment: {
        roleId: "checker",
        runtimeProfileId: "runtime-checker",
      },
      inputArtifacts: [],
    });

    expect(artifact).toEqual({
      id: "agent:LIN-123:checker:checker.verdict",
      kind: "checker.verdict",
      source: "agent",
      producerRoleId: "checker",
      provenance: {
        runtime: {
          runtimeId: "runtime-checker",
          transport: "stdio",
          command: ["agent-acp"],
          model: "runtime-default",
        },
      },
      payload: {
        verdict: "pass",
        summary: "Streamed verdict",
        reasons: [],
      },
    });
  });

  it("falls back to streamed artifact JSON when prompt result is not an artifact", async () => {
    let eventHandler:
      | ((event: { type: "text_delta"; sessionId: string; delta: string }) => void)
      | undefined;
    const connector: AcpRuntimeConnector = async () => ({
      session: {
        sessionId: "role-session-1",
        acpSessionId: "acp-session-1",
        prompt: async () => {
          eventHandler?.({
            type: "text_delta",
            sessionId: "role-session-1",
            delta: JSON.stringify({
              artifactKind: "architect.plan",
              payload: {
                summary: "Streamed plan",
                scope: ["fallback"],
                acceptanceCriteria: ["stream is parsed"],
                verificationCommands: ["bun test packages/roles"],
                risks: [],
              },
            }),
          });
          return { stopReason: "end_turn" };
        },
        cancel: () => undefined,
        onEvent: (handler) => {
          eventHandler = handler as typeof eventHandler;
          return () => {
            eventHandler = undefined;
          };
        },
      },
      process: {
        kill: async () => undefined,
      },
    });
    const runner = createAcpRoleRunner({ connector });

    const artifact = await runner.run({
      roleId: "architect",
      issueId: "LIN-123",
      runtime: {
        id: "runtime-architect",
        transport: "stdio",
        command: ["agent-acp"],
      },
      assignment: {
        roleId: "architect",
        runtimeProfileId: "runtime-architect",
      },
      inputArtifacts: [],
    });

    expect(artifact.payload).toMatchObject({ summary: "Streamed plan" });
  });

  it("rejects artifacts whose kind does not match the assigned core role", async () => {
    let killed = false;
    const connector: AcpRuntimeConnector = async () => ({
      session: {
        sessionId: "role-session-1",
        acpSessionId: "acp-session-1",
        prompt: async () => ({
          artifactKind: "developer.attempt",
          payload: {
            summary: "Wrong role output",
            changedFiles: ["README.md"],
            verificationNotes: "Not run",
          },
        }),
        cancel: () => undefined,
        onEvent: () => () => undefined,
      },
      process: {
        kill: async () => {
          killed = true;
        },
      },
    });
    const runner = createAcpRoleRunner({ connector });

    await expect(
      runner.run({
        roleId: "architect",
        issueId: "LIN-123",
        runtime: {
          id: "runtime-architect",
          transport: "stdio",
          command: ["agent-acp"],
        },
        assignment: {
          roleId: "architect",
          runtimeProfileId: "runtime-architect",
        },
        inputArtifacts: [],
      }),
    ).rejects.toThrow(/expected architect\.plan/i);
    expect(killed).toBe(true);
  });
});
