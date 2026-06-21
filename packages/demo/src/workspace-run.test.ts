import { describe, expect, it } from "bun:test";
import {
  createRoleRuntimeRegistry,
  createScriptedRoleRunner,
  type RoleRunner,
} from "@aigile/roles";
import { mkdtemp, rm } from "node:fs/promises";
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
          steps.push(`publish:${input.branchName}:${input.remote}:${input.commitMessage}`);
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
        appendPullRequestComment: async () => undefined,
        submitPullRequestReview: async () => undefined,
        recordCheckResult: async () => undefined,
        mergePullRequest: async () => undefined,
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
      "publish:aigile/LIN-123:origin:LIN-123 Publish branch",
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
        appendPullRequestComment: async () => undefined,
        submitPullRequestReview: async () => undefined,
        recordCheckResult: async () => undefined,
        mergePullRequest: async () => undefined,
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
        runner: scriptedRunner(),
        exec: async (command, args) => {
          if (command === "test") return { stdout: "", stderr: "", exitCode: 1 };
          if (command === "git" && args[0] === "show-ref")
            return { stdout: "", stderr: "", exitCode: 1 };
          // staged changes present so the publisher commits before pushing
          if (command === "git" && args[0] === "diff" && args.includes("--cached"))
            return { stdout: "", stderr: "", exitCode: 1 };
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      });

      expect(result.finalState).toBe("merged");
      expect(result.pullRequest).toBeDefined();
      expect(result.artifacts.map((artifact) => artifact.kind)).toContain("github.pull_request");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
