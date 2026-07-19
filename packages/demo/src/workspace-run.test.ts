import { describe, expect, it } from "bun:test";
import { createFakeCodeHostAdapter, type CodeHostAdapter } from "@aigile/adapters";
import {
  createRoleRuntimeRegistry,
  createScriptedRoleRunner,
  type RoleRunner,
} from "@aigile/roles";
import type { ExecCommand } from "@aigile/workspace";
import { createFileRunStore } from "@aigile/workflow";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDemoIssueWithWorkspace, runWorkspaceIssueWithEngine } from "./index.js";

const availableWorkspaceTarget = (command: string, args: readonly string[]) => {
  if (command === "test") return { stdout: "", stderr: "", exitCode: 1 };
  if (command === "git" && args[0] === "show-ref") return { stdout: "", stderr: "", exitCode: 1 };
  return undefined;
};

describe("workspace-aware demo orchestration", () => {
  it("adds workspace and verifier artifacts to the role handoff", async () => {
    const result = await runDemoIssueWithWorkspace({
      issue: {
        id: "issue-1",
        key: "LIN-123",
        title: "Use a worktree",
        description: "Exercise local workspace flow.",
        acceptanceCriteria: ["workspace exists", "verification passes"],
        status: "todo",
        priority: 1,
        comments: [],
      },
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      exec: async (command, args, options) => {
        const preflight = availableWorkspaceTarget(command, args);
        if (preflight) return preflight;
        if (command === "git" && args[0] === "worktree") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (command === "git" && args[0] === "diff") {
          return { stdout: "packages/demo/src/run.ts | 4 ++++", stderr: "", exitCode: 0 };
        }
        return {
          stdout: `${command} ${args.join(" ")} in ${options.cwd}`,
          stderr: "",
          exitCode: 0,
        };
      },
    });

    expect(result.finalState).toBe("merge_ready");
    expect(result.artifacts.map((artifact) => artifact.kind)).toEqual([
      "linear.issue",
      "workspace.issue_worktree",
      "execution.policy",
      "architect.plan",
      "developer.attempt",
      "workspace.diff",
      "verification.result",
      "checker.verdict",
      "github.pull_request",
    ]);
    expect(
      result.artifacts.find((artifact) => artifact.kind === "workspace.issue_worktree")?.payload,
    ).toMatchObject({
      branchName: "aigile/LIN-123",
      worktreePath: "/repo/aigile/.worktrees/LIN-123",
    });
    expect(
      result.artifacts.find((artifact) => artifact.kind === "execution.policy")?.payload,
    ).toMatchObject({
      mode: "agent_write",
      fileWrites: "allowed",
      commits: "forbidden",
    });
  });

  it("can run workspace orchestration with injected role runtimes", async () => {
    const registry = createRoleRuntimeRegistry({
      runtimes: [{ id: "custom-runtime", transport: "stdio", command: ["custom-acp"] }],
      assignments: [
        { roleId: "architect", runtimeProfileId: "custom-runtime" },
        { roleId: "developer", runtimeProfileId: "custom-runtime" },
        { roleId: "checker", runtimeProfileId: "custom-runtime" },
      ],
    });
    const runner = createScriptedRoleRunner({
      architect: {
        artifactKind: "architect.plan",
        payload: {
          summary: "Injected architect plan",
          scope: ["custom"],
          acceptanceCriteria: ["custom role runner is used"],
          verificationCommands: ["bun run check"],
          risks: [],
        },
      },
      developer: {
        artifactKind: "developer.attempt",
        payload: {
          summary: "Injected developer attempt",
          changedFiles: ["custom.ts"],
          verificationNotes: "Workspace verifier still runs.",
        },
      },
      checker: {
        artifactKind: "checker.verdict",
        payload: {
          verdict: "pass",
          summary: "Injected checker verdict",
          reasons: [],
        },
      },
    });

    const result = await runDemoIssueWithWorkspace({
      issue: {
        id: "issue-1",
        key: "LIN-123",
        title: "Use injected roles",
        description: "Exercise configured role flow.",
        acceptanceCriteria: ["custom role runner is used"],
        status: "todo",
        priority: 1,
        comments: [],
      },
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      registry,
      runner,
      exec: async (command, args, options) => {
        const preflight = availableWorkspaceTarget(command, args);
        if (preflight) return preflight;
        if (command === "git" && args[0] === "worktree") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (command === "git" && args[0] === "diff") {
          return { stdout: "custom.ts | 1 +", stderr: "", exitCode: 0 };
        }
        return {
          stdout: `${command} ${args.join(" ")} in ${options.cwd}`,
          stderr: "",
          exitCode: 0,
        };
      },
    });

    expect(
      result.artifacts.find((artifact) => artifact.kind === "architect.plan")?.payload,
    ).toMatchObject({
      summary: "Injected architect plan",
    });
    expect(
      result.artifacts.find((artifact) => artifact.kind === "developer.attempt")?.payload,
    ).toMatchObject({
      changedFiles: ["custom.ts"],
    });
  });

  it("adds a dry-run execution policy artifact to every role handoff", async () => {
    const seenArtifactKinds: Record<string, string[]> = {};
    const seenPolicyModes: Record<string, unknown> = {};
    const registry = createRoleRuntimeRegistry({
      runtimes: [{ id: "custom-runtime", transport: "stdio", command: ["custom-acp"] }],
      assignments: [
        { roleId: "architect", runtimeProfileId: "custom-runtime" },
        { roleId: "developer", runtimeProfileId: "custom-runtime" },
        { roleId: "checker", runtimeProfileId: "custom-runtime" },
      ],
    });
    const runner: RoleRunner = {
      run: async (input) => {
        seenArtifactKinds[input.roleId] = input.inputArtifacts.map((artifact) => artifact.kind);
        seenPolicyModes[input.roleId] = (
          input.inputArtifacts.find((artifact) => artifact.kind === "execution.policy")?.payload as
            | { mode?: unknown }
            | undefined
        )?.mode;
        if (input.roleId === "architect") {
          return {
            id: "agent:LIN-123:architect:architect.plan",
            kind: "architect.plan",
            source: "agent",
            producerRoleId: "architect",
            payload: {
              summary: "Dry-run plan",
              scope: ["policy"],
              acceptanceCriteria: ["policy is visible"],
              verificationCommands: ["bun run check"],
              risks: [],
            },
          };
        }
        if (input.roleId === "developer") {
          return {
            id: "agent:LIN-123:developer:developer.attempt",
            kind: "developer.attempt",
            source: "agent",
            producerRoleId: "developer",
            payload: {
              summary: "Dry-run attempt",
              changedFiles: [],
              verificationNotes: "No writes performed.",
            },
          };
        }
        return {
          id: "agent:LIN-123:checker:checker.verdict",
          kind: "checker.verdict",
          source: "agent",
          producerRoleId: "checker",
          payload: {
            verdict: "pass",
            summary: "Dry-run policy was visible.",
            reasons: [],
          },
        };
      },
    };

    const result = await runDemoIssueWithWorkspace({
      issue: {
        id: "issue-1",
        key: "LIN-123",
        title: "Dry run",
        description: "Exercise dry-run policy.",
        acceptanceCriteria: ["policy is visible"],
        status: "todo",
        priority: 1,
        comments: [],
      },
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      dryRun: true,
      registry,
      runner,
      exec: async (command, args, options) => {
        const preflight = availableWorkspaceTarget(command, args);
        if (preflight) return preflight;
        if (command === "git" && args[0] === "worktree") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (command === "git" && args[0] === "diff") {
          return { stdout: "dry-run diff | 1 +", stderr: "", exitCode: 0 };
        }
        return {
          stdout: `${command} ${args.join(" ")} in ${options.cwd}`,
          stderr: "",
          exitCode: 0,
        };
      },
    });

    expect(
      result.artifacts.find((artifact) => artifact.kind === "execution.policy")?.payload,
    ).toMatchObject({
      mode: "dry_run",
      fileWrites: "forbidden",
      commits: "forbidden",
    });
    expect(seenArtifactKinds.architect).toContain("execution.policy");
    expect(seenArtifactKinds.developer).toContain("execution.policy");
    expect(seenArtifactKinds.checker).toContain("execution.policy");
    expect(seenPolicyModes.architect).toBe("dry_run");
    expect(seenPolicyModes.developer).toBe("dry_run");
    expect(seenPolicyModes.checker).toBe("review");
  });

  it("runs workspace verification after the developer role", async () => {
    let developerFinished = false;
    const registry = createRoleRuntimeRegistry({
      runtimes: [{ id: "custom-runtime", transport: "stdio", command: ["custom-acp"] }],
      assignments: [
        { roleId: "architect", runtimeProfileId: "custom-runtime" },
        { roleId: "developer", runtimeProfileId: "custom-runtime" },
        { roleId: "checker", runtimeProfileId: "custom-runtime" },
      ],
    });
    const runner: RoleRunner = {
      run: async (input) => {
        if (input.roleId === "architect") {
          return {
            id: "agent:LIN-123:architect:architect.plan",
            kind: "architect.plan",
            source: "agent",
            producerRoleId: "architect",
            payload: {
              summary: "Plan",
              scope: ["workspace"],
              acceptanceCriteria: ["verification follows development"],
              verificationCommands: ["bun run check"],
              risks: [],
            },
          };
        }
        if (input.roleId === "developer") {
          developerFinished = true;
          return {
            id: "agent:LIN-123:developer:developer.attempt",
            kind: "developer.attempt",
            source: "agent",
            producerRoleId: "developer",
            payload: {
              summary: "Attempt",
              changedFiles: ["README.md"],
              verificationNotes: "Verifier should run after this.",
            },
          };
        }
        return {
          id: "agent:LIN-123:checker:checker.verdict",
          kind: "checker.verdict",
          source: "agent",
          producerRoleId: "checker",
          payload: {
            verdict: "pass",
            summary: "Verification order is sound.",
            reasons: [],
          },
        };
      },
    };

    await runDemoIssueWithWorkspace({
      issue: {
        id: "issue-1",
        key: "LIN-123",
        title: "Verifier order",
        description: "Verify after developer role.",
        acceptanceCriteria: ["verification follows development"],
        status: "todo",
        priority: 1,
        comments: [],
      },
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      registry,
      runner,
      exec: async (command, args, options) => {
        const preflight = availableWorkspaceTarget(command, args);
        if (preflight) return preflight;
        if (command === "git" && args[0] === "worktree") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (command === "git" && args[0] === "diff") {
          return { stdout: "README.md | 1 +", stderr: "", exitCode: 0 };
        }
        if (command === "bun" && args[0] === "run" && args[1] === "check") {
          expect(developerFinished).toBe(true);
          return { stdout: "ok", stderr: "", exitCode: 0 };
        }
        return {
          stdout: `${command} ${args.join(" ")} in ${options.cwd}`,
          stderr: "",
          exitCode: 0,
        };
      },
    });
  });

  it("passes externally ingested review feedback to a resumed developer attempt", async () => {
    const runStatePath = await mkdtemp(join(tmpdir(), "aigile-review-feedback-"));
    try {
      const developerInputs: string[][] = [];
      const registry = createRoleRuntimeRegistry({
        runtimes: [{ id: "custom-runtime", transport: "stdio", command: ["custom-acp"] }],
        assignments: [
          { roleId: "architect", runtimeProfileId: "custom-runtime" },
          { roleId: "developer", runtimeProfileId: "custom-runtime" },
          { roleId: "checker", runtimeProfileId: "custom-runtime" },
        ],
      });
      const runner: RoleRunner = {
        run: async (input) => {
          if (input.roleId === "developer") {
            developerInputs.push(input.inputArtifacts.map((artifact) => artifact.kind));
          }
          if (input.roleId === "architect") {
            return {
              id: "agent:LIN-777:architect:architect.plan",
              kind: "architect.plan",
              source: "agent",
              producerRoleId: "architect",
              payload: {
                summary: "Plan",
                scope: ["workspace"],
                acceptanceCriteria: ["review feedback is visible"],
                verificationCommands: ["bun run check"],
                risks: [],
              },
            };
          }
          if (input.roleId === "developer") {
            return {
              id: "agent:LIN-777:developer:developer.attempt",
              kind: "developer.attempt",
              source: "agent",
              producerRoleId: "developer",
              payload: {
                summary: "Attempt",
                changedFiles: ["README.md"],
                verificationNotes: "Verifier should run.",
              },
            };
          }
          return {
            id: "agent:LIN-777:checker:checker.verdict",
            kind: "checker.verdict",
            source: "agent",
            producerRoleId: "checker",
            payload: {
              verdict: "pass",
              summary: "Checker passed.",
              reasons: [],
            },
          };
        },
      };
      const issue = {
        id: "issue-777",
        key: "LIN-777",
        title: "Review feedback",
        description: "aigile-merge: manual",
        acceptanceCriteria: [],
        status: "todo",
        comments: [],
      };
      const codeHost = createFakeCodeHostAdapter();
      const exec = async (command: string, args: readonly string[], options: { cwd?: string }) => {
        const preflight = availableWorkspaceTarget(command, args);
        if (preflight) return preflight;
        if (command === "git" && args[0] === "worktree")
          return { stdout: "", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "diff")
          return { stdout: "README.md | 1 +", stderr: "", exitCode: 0 };
        return {
          stdout: `${command} ${args.join(" ")} in ${options.cwd}`,
          stderr: "",
          exitCode: 0,
        };
      };

      await runWorkspaceIssueWithEngine({
        issue,
        repoPath: "/repo/aigile",
        worktreesPath: "/repo/aigile/.worktrees",
        runStatePath,
        registry,
        runner,
        codeHost,
        exec,
      });
      const feedback = {
        id: "review-feedback:LIN-777:review-1",
        kind: "review.feedback",
        source: "github" as const,
        payload: { source: "github", signalId: "review-1", body: "Please rework this." },
      };
      await createFileRunStore({ directory: runStatePath }).appendEvent(
        issue.key,
        {
          type: "review_changes_requested",
          issueId: issue.key,
          artifactId: feedback.id,
          reason: "Please rework this.",
        },
        [feedback],
      );

      const result = await runWorkspaceIssueWithEngine({
        issue,
        repoPath: "/repo/aigile",
        worktreesPath: "/repo/aigile/.worktrees",
        runStatePath,
        registry,
        runner,
        codeHost,
        exec,
      });

      expect(result.finalState).toBe("merge_ready");
      expect(developerInputs).toHaveLength(2);
      expect(developerInputs[1]).toContain("review.feedback");
    } finally {
      await rm(runStatePath, { recursive: true, force: true });
    }
  });

  it("runs the checker under a read-only review execution policy on the engine path", async () => {
    const runStatePath = await mkdtemp(join(tmpdir(), "aigile-checker-policy-"));
    try {
      let checkerPolicyMode: unknown;
      const registry = createRoleRuntimeRegistry({
        runtimes: [{ id: "custom-runtime", transport: "stdio", command: ["custom-acp"] }],
        assignments: [
          { roleId: "architect", runtimeProfileId: "custom-runtime" },
          { roleId: "developer", runtimeProfileId: "custom-runtime" },
          { roleId: "checker", runtimeProfileId: "custom-runtime" },
        ],
      });
      const runner: RoleRunner = {
        run: async (input) => {
          if (input.roleId === "checker") {
            const policy = input.inputArtifacts.find(
              (artifact) => artifact.kind === "execution.policy",
            );
            checkerPolicyMode = (policy?.payload as { mode?: unknown } | undefined)?.mode;
            return {
              id: "agent:CHK-1:checker:checker.verdict",
              kind: "checker.verdict",
              source: "agent",
              producerRoleId: "checker",
              payload: { verdict: "pass", summary: "ok", reasons: [] },
            };
          }
          if (input.roleId === "architect") {
            return {
              id: "agent:CHK-1:architect:architect.plan",
              kind: "architect.plan",
              source: "agent",
              producerRoleId: "architect",
              payload: {
                summary: "Plan",
                scope: ["x"],
                acceptanceCriteria: ["a"],
                verificationCommands: ["bun run check"],
                risks: [],
              },
            };
          }
          return {
            id: "agent:CHK-1:developer:developer.attempt",
            kind: "developer.attempt",
            source: "agent",
            producerRoleId: "developer",
            payload: { summary: "d", changedFiles: ["README.md"], verificationNotes: "ok" },
          };
        },
      };
      const issue = {
        id: "issue-chk",
        key: "CHK-1",
        title: "Checker policy",
        description: "aigile-merge: manual",
        acceptanceCriteria: [],
        status: "todo",
        comments: [],
      };
      const exec = async (command: string, args: readonly string[], options: { cwd?: string }) => {
        const preflight = availableWorkspaceTarget(command, args);
        if (preflight) return preflight;
        if (command === "git" && args[0] === "worktree")
          return { stdout: "", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "diff")
          return { stdout: "README.md | 1 +", stderr: "", exitCode: 0 };
        return {
          stdout: `${command} ${args.join(" ")} in ${options.cwd}`,
          stderr: "",
          exitCode: 0,
        };
      };

      await runWorkspaceIssueWithEngine({
        issue,
        repoPath: "/repo/aigile",
        worktreesPath: "/repo/aigile/.worktrees",
        runStatePath,
        registry,
        runner,
        codeHost: createFakeCodeHostAdapter(),
        exec,
      });

      expect(checkerPolicyMode).toBe("review");
    } finally {
      await rm(runStatePath, { recursive: true, force: true });
    }
  });

  it("uses an existing read-only workspace path in dry-run role handoffs", async () => {
    const seenWorkspaceArtifacts: unknown[] = [];
    const registry = createRoleRuntimeRegistry({
      runtimes: [{ id: "custom-runtime", transport: "stdio", command: ["custom-acp"] }],
      assignments: [
        { roleId: "architect", runtimeProfileId: "custom-runtime" },
        { roleId: "developer", runtimeProfileId: "custom-runtime" },
        { roleId: "checker", runtimeProfileId: "custom-runtime" },
      ],
    });
    const runner: RoleRunner = {
      run: async (input) => {
        seenWorkspaceArtifacts.push(
          input.inputArtifacts.find((artifact) => artifact.kind === "workspace.issue_worktree")
            ?.payload,
        );
        if (input.roleId === "architect") {
          return {
            id: "agent:LIN-123:architect:architect.plan",
            kind: "architect.plan",
            source: "agent",
            producerRoleId: "architect",
            payload: {
              summary: "Dry-run plan",
              scope: ["policy"],
              acceptanceCriteria: ["policy is visible"],
              verificationCommands: ["bun run check"],
              risks: [],
            },
          };
        }
        if (input.roleId === "developer") {
          return {
            id: "agent:LIN-123:developer:developer.attempt",
            kind: "developer.attempt",
            source: "agent",
            producerRoleId: "developer",
            payload: {
              summary: "Dry-run attempt",
              changedFiles: [],
              verificationNotes: "No writes performed.",
            },
          };
        }
        return {
          id: "agent:LIN-123:checker:checker.verdict",
          kind: "checker.verdict",
          source: "agent",
          producerRoleId: "checker",
          payload: {
            verdict: "pass",
            summary: "Dry-run policy was visible.",
            reasons: [],
          },
        };
      },
    };

    await runDemoIssueWithWorkspace({
      issue: {
        id: "issue-1",
        key: "LIN-123",
        title: "Dry run",
        description: "Exercise dry-run workspace artifact.",
        acceptanceCriteria: ["policy is visible"],
        status: "todo",
        priority: 1,
        comments: [],
      },
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      dryRun: true,
      registry,
      runner,
      exec: async (command, args, options) => {
        const preflight = availableWorkspaceTarget(command, args);
        if (preflight) return preflight;
        if (command === "git" && args[0] === "worktree") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (command === "git" && args[0] === "diff") {
          return { stdout: "dry-run diff | 1 +", stderr: "", exitCode: 0 };
        }
        return {
          stdout: `${command} ${args.join(" ")} in ${options.cwd}`,
          stderr: "",
          exitCode: 0,
        };
      },
    });

    expect(seenWorkspaceArtifacts).toContainEqual(
      expect.objectContaining({
        worktreePath: "/repo/aigile",
        simulatedWorktreePath: "/repo/aigile/.worktrees/LIN-123",
        mode: "dry_run",
      }),
    );
  });

  it("can publish a workspace branch before creating the pull request", async () => {
    const steps: string[] = [];

    const result = await runDemoIssueWithWorkspace({
      issue: {
        id: "issue-1",
        key: "LIN-123",
        title: "Publish branch",
        description: "Exercise workspace publish flow.",
        acceptanceCriteria: ["branch is pushed before PR"],
        status: "todo",
        priority: 1,
        comments: [],
      },
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      publish: true,
      publisher: {
        publish: async (input) => {
          steps.push(
            `publish:${input.branchName}:${input.remote}:${input.owner}/${input.repo}:${input.commitMessage}`,
          );
        },
      },
      codeHost: {
        createPullRequest: async (input) => {
          steps.push(`pr:${input.branch}`);
          return {
            id: "aigile/aigile#7",
            number: 7,
            url: "https://github.local/aigile/aigile/pull/7",
            ...input,
            comments: [],
            checks: [],
            reviews: [],
          };
        },
        getPullRequest: async () => ({
          id: "aigile/aigile#7",
          number: 7,
          url: "https://github.local/aigile/aigile/pull/7",
          owner: "aigile",
          repo: "aigile",
          branch: "aigile/LIN-123",
          baseBranch: "main",
          title: "LIN-123 Publish branch",
          body: "body",
          comments: [],
          checks: [],
          reviews: [],
        }),
        getPullRequestMergeability: async () => ({ status: "mergeable" }),
        getPullRequestMergeState: async () => ({ status: "unmerged" }),
        getPullRequestChecks: async () => ({ status: "none", checks: [] }),
        appendPullRequestComment: async () => undefined,
        submitPullRequestReview: async () => undefined,
        recordCheckResult: async () => undefined,
        mergePullRequest: async () => undefined,
        findPullRequestForBranch: async () => undefined,
      },
      exec: async (command, args, options) => {
        const preflight = availableWorkspaceTarget(command, args);
        if (preflight) return preflight;
        if (command === "git" && args[0] === "worktree") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (command === "git" && args[0] === "diff") {
          return { stdout: "packages/demo/src/run.ts | 1 +", stderr: "", exitCode: 0 };
        }
        return {
          stdout: `${command} ${args.join(" ")} in ${options.cwd}`,
          stderr: "",
          exitCode: 0,
        };
      },
    });

    expect(result.pullRequest?.url).toBe("https://github.local/aigile/aigile/pull/7");
    expect(steps).toEqual([
      "publish:aigile/LIN-123:origin:aigile/aigile:LIN-123 Publish branch",
      "pr:aigile/LIN-123",
    ]);
  });

  it("can stop after checker pass without creating a pull request", async () => {
    const result = await runDemoIssueWithWorkspace({
      issue: {
        id: "issue-1",
        key: "LIN-123",
        title: "Local agent write",
        description: "Exercise local-only agent write flow.",
        acceptanceCriteria: ["no PR without publish"],
        status: "todo",
        priority: 1,
        comments: [],
      },
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      createPullRequest: false,
      exec: async (command, args, options) => {
        const preflight = availableWorkspaceTarget(command, args);
        if (preflight) return preflight;
        if (command === "git" && args[0] === "worktree") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (command === "git" && args[0] === "diff") {
          return { stdout: "packages/demo/src/run.ts | 1 +", stderr: "", exitCode: 0 };
        }
        return {
          stdout: `${command} ${args.join(" ")} in ${options.cwd}`,
          stderr: "",
          exitCode: 0,
        };
      },
    });

    expect(result.finalState).toBe("merge_ready");
    expect(result.pullRequest).toBeUndefined();
    expect(result.artifacts.map((artifact) => artifact.kind)).not.toContain("github.pull_request");
    expect(result.timeline.map((entry) => entry.label)).toContain("checker_passed -> merge_ready");
    expect(result.timeline.map((entry) => entry.label)).not.toContain("merge_completed -> merged");
  });

  it("uses a configured pull request target for workspace publishing", async () => {
    const prInputs: Array<{ owner: string; repo: string; baseBranch: string }> = [];

    await runDemoIssueWithWorkspace({
      issue: {
        id: "issue-1",
        key: "LIN-123",
        title: "Target repo",
        description: "Exercise PR target config.",
        acceptanceCriteria: ["target is used"],
        status: "todo",
        priority: 1,
        comments: [],
      },
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      baseBranch: "develop",
      pullRequestTarget: {
        owner: "acme",
        repo: "project",
        baseBranch: "develop",
      },
      codeHost: {
        createPullRequest: async (input) => {
          prInputs.push({ owner: input.owner, repo: input.repo, baseBranch: input.baseBranch });
          return {
            id: "acme/project#9",
            number: 9,
            url: "https://github.local/acme/project/pull/9",
            ...input,
            comments: [],
            checks: [],
            reviews: [],
          };
        },
        getPullRequest: async () => ({
          id: "acme/project#9",
          number: 9,
          url: "https://github.local/acme/project/pull/9",
          owner: "acme",
          repo: "project",
          branch: "aigile/LIN-123",
          baseBranch: "develop",
          title: "LIN-123 Target repo",
          body: "body",
          comments: [],
          checks: [],
          reviews: [],
        }),
        getPullRequestMergeability: async () => ({ status: "mergeable" }),
        getPullRequestMergeState: async () => ({ status: "unmerged" }),
        getPullRequestChecks: async () => ({ status: "none", checks: [] }),
        appendPullRequestComment: async () => undefined,
        submitPullRequestReview: async () => undefined,
        recordCheckResult: async () => undefined,
        mergePullRequest: async () => undefined,
        findPullRequestForBranch: async () => undefined,
      },
      exec: async (command, args, options) => {
        const preflight = availableWorkspaceTarget(command, args);
        if (preflight) return preflight;
        if (command === "git" && args[0] === "worktree") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (command === "git" && args[0] === "diff") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return {
          stdout: `${command} ${args.join(" ")} in ${options.cwd}`,
          stderr: "",
          exitCode: 0,
        };
      },
    });

    expect(prInputs).toEqual([{ owner: "acme", repo: "project", baseBranch: "develop" }]);
  });
});

describe("durable engine-backed workspace run", () => {
  const scriptedRunner = (): RoleRunner =>
    createScriptedRoleRunner({
      architect: {
        artifactKind: "architect.plan",
        payload: {
          summary: "plan",
          scope: ["x"],
          acceptanceCriteria: ["a"],
          verificationCommands: ["bun run check"],
          risks: [],
        },
      },
      developer: {
        artifactKind: "developer.attempt",
        payload: { summary: "done", changedFiles: ["packages/x.ts"], verificationNotes: "ok" },
      },
      checker: {
        artifactKind: "checker.verdict",
        payload: { verdict: "pass", summary: "lgtm", reasons: [] },
      },
    });

  it("drives a run to merged through the engine and persists the event log", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aigile-engine-run-"));
    let current = 0;
    const runner = scriptedRunner();
    const timedRunner: RoleRunner = {
      run: async (input) => {
        current += 1_500;
        return runner.run(input);
      },
    };
    try {
      const result = await runWorkspaceIssueWithEngine({
        issue: {
          id: "i",
          key: "LIN-9",
          title: "Engine run",
          description: "",
          acceptanceCriteria: [],
          status: "todo",
          comments: [],
        },
        repoPath: "/repo/aigile",
        worktreesPath: "/repo/aigile/.worktrees",
        runStatePath: directory,
        runner: timedRunner,
        codeHost: createFakeCodeHostAdapter({ mergeability: "mergeable", merged: false }),
        exec: async (command, args) => {
          current += 100;
          if (command === "test") return { stdout: "", stderr: "", exitCode: 1 };
          if (command === "git" && args[0] === "show-ref")
            return { stdout: "", stderr: "", exitCode: 1 };
          // staged changes present so the publisher commits before pushing
          if (command === "git" && args[0] === "diff" && args.includes("--cached"))
            return { stdout: "", stderr: "", exitCode: 1 };
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        now: () => current,
      });

      expect(result.finalState).toBe("merged");
      expect(result.pullRequest).toBeDefined();
      expect(result.artifacts.map((artifact) => artifact.kind)).toContain("github.pull_request");
      expect(result.durationMs).toBeGreaterThan(1_000);
      expect(result.timeline.length).toBeGreaterThan(0);
      expect(result.stageTimings).toContainEqual(
        expect.objectContaining({ stage: "development", attempts: 1 }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("resumes after PR creation fails without recreating the published commit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aigile-engine-publish-resume-"));
    const baseCodeHost = createFakeCodeHostAdapter({ mergeability: "mergeable", merged: false });
    let createPullRequestCalls = 0;
    const codeHost: CodeHostAdapter = {
      ...baseCodeHost,
      createPullRequest: async (input) => {
        createPullRequestCalls += 1;
        if (createPullRequestCalls === 1) throw new Error("gh pr create transient failure");
        return baseCodeHost.createPullRequest(input);
      },
    };

    const roleCalls: string[] = [];
    const baseRunner = scriptedRunner();
    const runner: RoleRunner = {
      run: async (input) => {
        roleCalls.push(input.roleId);
        return baseRunner.run(input);
      },
    };

    let worktreeExists = false;
    let changedFilesAvailable = true;
    let staged = false;
    let headSubject = "origin/main";
    let localHead = "origin-main";
    let remoteHead: string | undefined;
    let publishCommitCount = 0;
    let resetSoftCount = 0;
    let pushCount = 0;

    const exec: ExecCommand = async (command, args) => {
      if (command === "test" && args[0] === "-e") {
        return { stdout: "", stderr: "", exitCode: worktreeExists ? 0 : 1 };
      }
      if (command === "git" && args[0] === "fetch") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command === "git" && args[0] === "rev-parse" && args[1] === "--verify") {
        return { stdout: "origin-main\n", stderr: "", exitCode: 0 };
      }
      if (command === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { stdout: "aigile/LIN-9\n", stderr: "", exitCode: 0 };
      }
      if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
        return { stdout: `${localHead}\n`, stderr: "", exitCode: 0 };
      }
      if (command === "git" && args[0] === "merge-base") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command === "git" && args[0] === "show-ref") {
        return { stdout: "", stderr: "", exitCode: worktreeExists ? 0 : 1 };
      }
      if (command === "git" && args[0] === "worktree" && args[1] === "add") {
        worktreeExists = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command === "git" && args[0] === "log" && args[1] === "-1") {
        return { stdout: `${headSubject}\n`, stderr: "", exitCode: 0 };
      }
      if (command === "git" && args[0] === "diff" && args.includes("--cached")) {
        return { stdout: "", stderr: "", exitCode: staged ? 1 : 0 };
      }
      if (command === "git" && args[0] === "diff" && args.includes("--quiet")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command === "git" && args[0] === "add") {
        if (changedFilesAvailable) staged = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command === "git" && args[0] === "commit") {
        const message = args[args.indexOf("-m") + 1];
        headSubject = message ?? "commit";
        if (headSubject === "LIN-9 Engine run") {
          publishCommitCount += 1;
          localHead = `publish-${publishCommitCount}`;
        } else {
          localHead = "checkpoint-1";
          changedFilesAvailable = false;
        }
        staged = false;
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command === "git" && args[0] === "reset" && args[1] === "--soft") {
        resetSoftCount += 1;
        staged = true;
        headSubject = "origin/main";
        localHead = "origin-main";
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command === "git" && args.includes("push")) {
        pushCount += 1;
        if (remoteHead !== undefined && remoteHead !== localHead) {
          return { stdout: "", stderr: "non-fast-forward", exitCode: 1 };
        }
        remoteHead = localHead;
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command === "bun") return { stdout: "", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    try {
      const first = await runWorkspaceIssueWithEngine({
        issue: {
          id: "i",
          key: "LIN-9",
          title: "Engine run",
          description: "",
          acceptanceCriteria: [],
          status: "todo",
          comments: [],
        },
        repoPath: "/repo/aigile",
        worktreesPath: "/repo/aigile/.worktrees",
        runStatePath: directory,
        runner,
        codeHost,
        exec,
      });

      expect(first.finalState).toBe("escalated");
      expect(first.publicationFailure).toEqual({
        operation: "publish_pull_request",
        message: "gh pr create transient failure",
      });
      expect(resetSoftCount).toBe(1);
      expect(publishCommitCount).toBe(1);
      expect(pushCount).toBe(1);
      expect(roleCalls).toEqual(["architect", "developer", "checker"]);

      const second = await runWorkspaceIssueWithEngine({
        issue: {
          id: "i",
          key: "LIN-9",
          title: "Engine run",
          description: "",
          acceptanceCriteria: [],
          status: "todo",
          comments: [],
        },
        repoPath: "/repo/aigile",
        worktreesPath: "/repo/aigile/.worktrees",
        runStatePath: directory,
        resumePublish: true,
        runner,
        codeHost,
        exec,
      });

      expect(second.finalState).toBe("merged");
      expect(createPullRequestCalls).toBe(2);
      expect(resetSoftCount).toBe(1);
      expect(publishCommitCount).toBe(1);
      expect(pushCount).toBe(2);
      expect(remoteHead).toBe("publish-1");
      expect(roleCalls).toEqual(["architect", "developer", "checker"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("updates terminal issue status through the engine command", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aigile-engine-status-"));
    const statuses: string[] = [];
    try {
      const result = await runWorkspaceIssueWithEngine({
        issue: {
          id: "i",
          key: "LIN-9",
          title: "Engine run",
          description: "",
          acceptanceCriteria: [],
          status: "Todo",
          comments: [],
        },
        repoPath: "/repo/aigile",
        worktreesPath: "/repo/aigile/.worktrees",
        runStatePath: directory,
        runner: scriptedRunner(),
        issueStatusLabels: {
          developing: "In Progress",
          blocked: "Blocked",
          inReview: "In Review",
          done: "Done",
        },
        issueTracker: {
          getIssue: async () => {
            throw new Error("getIssue should not be called");
          },
          updateIssueStatus: async (_key, status) => {
            statuses.push(status);
          },
          appendIssueComment: async () => undefined,
        },
        codeHost: createFakeCodeHostAdapter({ mergeability: "mergeable", merged: false }),
        exec: async (command, args) => {
          if (command === "test") return { stdout: "", stderr: "", exitCode: 1 };
          if (command === "git" && args[0] === "show-ref")
            return { stdout: "", stderr: "", exitCode: 1 };
          if (command === "git" && args[0] === "diff" && args.includes("--cached"))
            return { stdout: "", stderr: "", exitCode: 1 };
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      });

      expect(result.finalState).toBe("merged");
      expect(statuses).toEqual(["Done"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("moves unsuccessful engine runs to the blocked issue status", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aigile-engine-status-failed-"));
    const statuses: string[] = [];
    try {
      const result = await runWorkspaceIssueWithEngine({
        issue: {
          id: "i",
          key: "LIN-9",
          title: "Engine run",
          description: "",
          acceptanceCriteria: [],
          status: "Todo",
          comments: [],
        },
        repoPath: "/repo/aigile",
        worktreesPath: "/repo/aigile/.worktrees",
        runStatePath: directory,
        runner: scriptedRunner(),
        issueStatusLabels: {
          developing: "In Progress",
          blocked: "Blocked",
          inReview: "In Review",
          done: "Done",
        },
        issueTracker: {
          getIssue: async () => {
            throw new Error("getIssue should not be called");
          },
          updateIssueStatus: async (_key, status) => {
            statuses.push(status);
          },
          appendIssueComment: async () => undefined,
        },
        codeHost: createFakeCodeHostAdapter({ mergeability: "mergeable", merged: false }),
        exec: async (command, args) => {
          if (command === "test") return { stdout: "", stderr: "", exitCode: 1 };
          if (command === "git" && args[0] === "show-ref")
            return { stdout: "", stderr: "", exitCode: 1 };
          if (command === "bun" && args[0] === "run" && args[1] === "check")
            return { stdout: "", stderr: "failed", exitCode: 1 };
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      });

      expect(result.finalState).toBe("escalated");
      expect(statuses).toEqual(["Blocked"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("can retry after clearing a prior escalated run log", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aigile-engine-retry-"));
    try {
      const store = createFileRunStore({ directory });
      await store.appendEvent("LIN-9", { type: "issue_received", issueId: "LIN-9" });
      await store.appendEvent("LIN-9", {
        type: "plan_drafted",
        issueId: "LIN-9",
        artifactId: "plan",
      });
      await store.appendEvent("LIN-9", { type: "plan_approved", issueId: "LIN-9" });
      await store.appendEvent("LIN-9", {
        type: "developer_finished",
        issueId: "LIN-9",
        artifactId: "attempt",
      });
      await store.appendEvent("LIN-9", {
        type: "verification_failed",
        issueId: "LIN-9",
        artifactId: "verification",
      });
      await store.appendEvent("LIN-9", {
        type: "developer_finished",
        issueId: "LIN-9",
        artifactId: "attempt",
      });
      await store.appendEvent("LIN-9", {
        type: "verification_failed",
        issueId: "LIN-9",
        artifactId: "verification",
      });
      await store.appendEvent("LIN-9", {
        type: "developer_finished",
        issueId: "LIN-9",
        artifactId: "attempt",
      });
      await store.appendEvent("LIN-9", {
        type: "verification_failed",
        issueId: "LIN-9",
        artifactId: "verification",
      });

      const result = await runWorkspaceIssueWithEngine({
        issue: {
          id: "i",
          key: "LIN-9",
          title: "Retry escalated run",
          description: "",
          acceptanceCriteria: [],
          status: "todo",
          comments: [],
        },
        repoPath: "/repo/aigile",
        worktreesPath: "/repo/aigile/.worktrees",
        runStatePath: directory,
        retryEscalated: true,
        runner: scriptedRunner(),
        codeHost: createFakeCodeHostAdapter({ mergeability: "mergeable", merged: false }),
        exec: async (command, args) => {
          if (command === "test") return { stdout: "", stderr: "", exitCode: 1 };
          if (command === "git" && args[0] === "show-ref")
            return { stdout: "", stderr: "", exitCode: 1 };
          if (command === "git" && args[0] === "diff" && args.includes("--cached"))
            return { stdout: "", stderr: "", exitCode: 1 };
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      });

      expect(result.finalState).toBe("merged");
      const persisted = await store.load("LIN-9");
      expect(persisted?.events.map((event) => event.type)).not.toEqual([
        "issue_received",
        "plan_drafted",
        "plan_approved",
        "developer_finished",
        "verification_failed",
        "developer_finished",
        "verification_failed",
        "developer_finished",
        "verification_failed",
      ]);
      expect(persisted?.events.at(-1)?.type).toBe("merge_completed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not clear a merge-ready run when retryEscalated is set", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aigile-engine-retry-ready-"));
    try {
      const store = createFileRunStore({ directory });
      const seededEvents = [
        "issue_received",
        "plan_drafted",
        "plan_approved",
        "developer_finished",
        "verification_passed",
        "checker_passed",
      ] as const;
      await store.appendEvent("LIN-9", { type: "issue_received", issueId: "LIN-9" });
      await store.appendEvent("LIN-9", {
        type: "plan_drafted",
        issueId: "LIN-9",
        artifactId: "plan",
      });
      await store.appendEvent("LIN-9", { type: "plan_approved", issueId: "LIN-9" });
      await store.appendEvent("LIN-9", {
        type: "developer_finished",
        issueId: "LIN-9",
        artifactId: "attempt",
      });
      await store.appendEvent("LIN-9", {
        type: "verification_passed",
        issueId: "LIN-9",
        artifactId: "verification",
      });
      await store.appendEvent("LIN-9", {
        type: "checker_passed",
        issueId: "LIN-9",
        artifactId: "verdict",
      });

      const codeHost = createFakeCodeHostAdapter({
        mergeability: "mergeable",
        merged: false,
      });
      const pullRequest = await codeHost.createPullRequest({
        owner: "aigile",
        repo: "aigile",
        branch: "aigile/LIN-9",
        baseBranch: "main",
        title: "LIN-9 Already reviewed",
        body: "",
      });
      await codeHost.recordCheckResult(pullRequest.id, {
        name: "aigile/verifier",
        status: "passed",
        summary: "Verification passed.",
      });

      const roleCalls: string[] = [];
      const result = await runWorkspaceIssueWithEngine({
        issue: {
          id: "i",
          key: "LIN-9",
          title: "Already reviewed",
          description: "",
          acceptanceCriteria: [],
          status: "todo",
          comments: [],
        },
        repoPath: "/repo/aigile",
        worktreesPath: "/repo/aigile/.worktrees",
        runStatePath: directory,
        retryEscalated: true,
        runner: {
          run: async (input) => {
            roleCalls.push(input.roleId);
            throw new Error(`unexpected role call: ${input.roleId}`);
          },
        },
        codeHost,
        exec: async (command, args) => {
          if (command === "test") return { stdout: "", stderr: "", exitCode: 1 };
          if (command === "git" && args[0] === "show-ref")
            return { stdout: "", stderr: "", exitCode: 1 };
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      });

      expect(roleCalls).toEqual([]);
      expect(result.finalState).toBe("merged");
      const persisted = await store.load("LIN-9");
      const eventTypes = persisted?.events.map((event) => event.type) ?? [];
      expect(eventTypes.slice(0, seededEvents.length)).toEqual([...seededEvents]);
      expect(eventTypes.at(-1)).toBe("merge_completed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("can retry after clearing an unreadable run log", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aigile-engine-retry-corrupt-"));
    try {
      await writeFile(join(directory, "LIN-9.json"), "{not-json");

      const result = await runWorkspaceIssueWithEngine({
        issue: {
          id: "i",
          key: "LIN-9",
          title: "Retry corrupt run",
          description: "",
          acceptanceCriteria: [],
          status: "todo",
          comments: [],
        },
        repoPath: "/repo/aigile",
        worktreesPath: "/repo/aigile/.worktrees",
        runStatePath: directory,
        retryEscalated: true,
        runner: scriptedRunner(),
        codeHost: createFakeCodeHostAdapter({ mergeability: "mergeable", merged: false }),
        exec: async (command, args) => {
          if (command === "test") return { stdout: "", stderr: "", exitCode: 1 };
          if (command === "git" && args[0] === "show-ref")
            return { stdout: "", stderr: "", exitCode: 1 };
          if (command === "git" && args[0] === "diff" && args.includes("--cached"))
            return { stdout: "", stderr: "", exitCode: 1 };
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      });

      expect(result.finalState).toBe("merged");
      const persisted = await createFileRunStore({ directory }).load("LIN-9");
      expect(persisted?.events.at(0)?.type).toBe("issue_received");
      expect(persisted?.events.at(-1)?.type).toBe("merge_completed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
