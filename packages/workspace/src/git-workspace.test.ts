import { describe, expect, it } from "bun:test";
import { createGitWorkspaceAdapter } from "./index.js";

describe("git workspace adapter", () => {
  it("creates an issue worktree with a safe branch name", async () => {
    const commands: Array<{ command: string; args: string[]; cwd: string }> = [];
    const adapter = createGitWorkspaceAdapter({
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      exec: async (command, args, options) => {
        commands.push({ command, args: [...args], cwd: options.cwd });
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    const workspace = await adapter.createIssueWorkspace({
      issueKey: "LIN 123!",
      baseBranch: "main",
    });

    expect(workspace).toEqual({
      issueKey: "LIN 123!",
      branchName: "aigile/LIN-123",
      worktreePath: "/repo/aigile/.worktrees/LIN-123",
      baseBranch: "main",
    });
    expect(commands).toEqual([{
      command: "git",
      args: ["worktree", "add", "-b", "aigile/LIN-123", "/repo/aigile/.worktrees/LIN-123", "main"],
      cwd: "/repo/aigile",
    }]);
  });

  it("summarizes worktree diff", async () => {
    const adapter = createGitWorkspaceAdapter({
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      exec: async (_command, args, options) => {
        expect(args).toEqual(["diff", "--stat"]);
        expect(options.cwd).toBe("/repo/aigile/.worktrees/LIN-123");
        return { stdout: " README.md | 2 ++", stderr: "", exitCode: 0 };
      },
    });

    await expect(adapter.diffSummary({
      issueKey: "LIN-123",
      branchName: "aigile/LIN-123",
      worktreePath: "/repo/aigile/.worktrees/LIN-123",
      baseBranch: "main",
    })).resolves.toBe(" README.md | 2 ++");
  });

  it("fails when git command exits non-zero", async () => {
    const adapter = createGitWorkspaceAdapter({
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      exec: async () => ({ stdout: "", stderr: "fatal", exitCode: 128 }),
    });

    await expect(adapter.createIssueWorkspace({
      issueKey: "LIN-123",
      baseBranch: "main",
    })).rejects.toThrow(/git worktree add failed/i);
  });
});
