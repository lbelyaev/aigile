import { describe, expect, it } from "bun:test";
import {
  createRoleRuntimeRegistry,
  createScriptedRoleRunner,
  type RoleRunner,
} from "@aigile/roles";
import { runDemoIssueWithWorkspace } from "./index.js";

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
        if (command === "git" && args[0] === "worktree") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (command === "git" && args[0] === "diff") {
          return { stdout: "packages/demo/src/run.ts | 4 ++++", stderr: "", exitCode: 0 };
        }
        return { stdout: `${command} ${args.join(" ")} in ${options.cwd}`, stderr: "", exitCode: 0 };
      },
    });

    expect(result.finalState).toBe("merged");
    expect(result.artifacts.map((artifact) => artifact.kind)).toEqual([
      "linear.issue",
      "workspace.issue_worktree",
      "architect.plan",
      "developer.attempt",
      "workspace.diff",
      "verification.result",
      "checker.verdict",
      "github.pull_request",
    ]);
    expect(result.artifacts.find((artifact) => artifact.kind === "workspace.issue_worktree")?.payload).toMatchObject({
      branchName: "aigile/LIN-123",
      worktreePath: "/repo/aigile/.worktrees/LIN-123",
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
        if (command === "git" && args[0] === "worktree") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (command === "git" && args[0] === "diff") {
          return { stdout: "custom.ts | 1 +", stderr: "", exitCode: 0 };
        }
        return { stdout: `${command} ${args.join(" ")} in ${options.cwd}`, stderr: "", exitCode: 0 };
      },
    });

    expect(result.artifacts.find((artifact) => artifact.kind === "architect.plan")?.payload).toMatchObject({
      summary: "Injected architect plan",
    });
    expect(result.artifacts.find((artifact) => artifact.kind === "developer.attempt")?.payload).toMatchObject({
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
        if (command === "git" && args[0] === "worktree") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (command === "git" && args[0] === "diff") {
          return { stdout: "dry-run diff | 1 +", stderr: "", exitCode: 0 };
        }
        return { stdout: `${command} ${args.join(" ")} in ${options.cwd}`, stderr: "", exitCode: 0 };
      },
    });

    expect(result.artifacts.find((artifact) => artifact.kind === "execution.policy")?.payload).toMatchObject({
      mode: "dry_run",
      fileWrites: "forbidden",
      commits: "forbidden",
    });
    expect(seenArtifactKinds.architect).toContain("execution.policy");
    expect(seenArtifactKinds.developer).toContain("execution.policy");
    expect(seenArtifactKinds.checker).toContain("execution.policy");
  });
});
