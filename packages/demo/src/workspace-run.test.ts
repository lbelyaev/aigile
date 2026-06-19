import { describe, expect, it } from "bun:test";
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
});
