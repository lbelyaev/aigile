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
        if (command === "test") return { stdout: "", stderr: "", exitCode: 1 };
        if (command === "git" && args[0] === "show-ref")
          return { stdout: "", stderr: "", exitCode: 1 };
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
    expect(commands).toEqual([
      {
        command: "test",
        args: ["-e", "/repo/aigile/.worktrees/LIN-123"],
        cwd: "/repo/aigile",
      },
      {
        command: "git",
        args: ["show-ref", "--verify", "--quiet", "refs/heads/aigile/LIN-123"],
        cwd: "/repo/aigile",
      },
      {
        command: "git",
        args: [
          "worktree",
          "add",
          "-b",
          "aigile/LIN-123",
          "/repo/aigile/.worktrees/LIN-123",
          "main",
        ],
        cwd: "/repo/aigile",
      },
    ]);
  });

  it("checks issue workspace availability without creating it", async () => {
    const commands: Array<{ command: string; args: string[]; cwd: string }> = [];
    const adapter = createGitWorkspaceAdapter({
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      exec: async (command, args, options) => {
        commands.push({ command, args: [...args], cwd: options.cwd });
        return { stdout: "", stderr: "", exitCode: 1 };
      },
    });

    await expect(
      adapter.checkIssueWorkspaceAvailability({
        issueKey: "LIN-123",
        baseBranch: "main",
      }),
    ).resolves.toEqual({
      issueKey: "LIN-123",
      branchName: "aigile/LIN-123",
      worktreePath: "/repo/aigile/.worktrees/LIN-123",
      baseBranch: "main",
    });
    expect(commands).toEqual([
      {
        command: "test",
        args: ["-e", "/repo/aigile/.worktrees/LIN-123"],
        cwd: "/repo/aigile",
      },
      {
        command: "git",
        args: ["show-ref", "--verify", "--quiet", "refs/heads/aigile/LIN-123"],
        cwd: "/repo/aigile",
      },
    ]);
  });

  it("reuses an existing issue worktree when it is on the expected branch", async () => {
    const commands: Array<{ command: string; args: string[]; cwd: string }> = [];
    const adapter = createGitWorkspaceAdapter({
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      exec: async (command, args, options) => {
        commands.push({ command, args: [...args], cwd: options.cwd });
        if (command === "test") return { stdout: "", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "rev-parse") {
          return { stdout: "aigile/LIN-123\n", stderr: "", exitCode: 0 };
        }
        throw new Error("unexpected command");
      },
    });

    await expect(
      adapter.createIssueWorkspace({
        issueKey: "LIN-123",
        baseBranch: "main",
      }),
    ).resolves.toEqual({
      issueKey: "LIN-123",
      branchName: "aigile/LIN-123",
      worktreePath: "/repo/aigile/.worktrees/LIN-123",
      baseBranch: "main",
    });
    expect(commands).toEqual([
      {
        command: "test",
        args: ["-e", "/repo/aigile/.worktrees/LIN-123"],
        cwd: "/repo/aigile",
      },
      {
        command: "git",
        args: ["rev-parse", "--abbrev-ref", "HEAD"],
        cwd: "/repo/aigile/.worktrees/LIN-123",
      },
    ]);
  });

  it("reattaches an existing issue branch when the worktree path is absent", async () => {
    const commands: Array<{ command: string; args: string[]; cwd: string }> = [];
    const adapter = createGitWorkspaceAdapter({
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      exec: async (command, args, options) => {
        commands.push({ command, args: [...args], cwd: options.cwd });
        if (command === "test") return { stdout: "", stderr: "", exitCode: 1 };
        if (command === "git" && args[0] === "show-ref")
          return { stdout: "", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "worktree")
          return { stdout: "", stderr: "", exitCode: 0 };
        throw new Error("unexpected command");
      },
    });

    await expect(
      adapter.createIssueWorkspace({
        issueKey: "LIN-123",
        baseBranch: "main",
      }),
    ).resolves.toMatchObject({
      branchName: "aigile/LIN-123",
      worktreePath: "/repo/aigile/.worktrees/LIN-123",
    });
    expect(commands).toEqual([
      {
        command: "test",
        args: ["-e", "/repo/aigile/.worktrees/LIN-123"],
        cwd: "/repo/aigile",
      },
      {
        command: "git",
        args: ["show-ref", "--verify", "--quiet", "refs/heads/aigile/LIN-123"],
        cwd: "/repo/aigile",
      },
      {
        command: "git",
        args: ["worktree", "add", "/repo/aigile/.worktrees/LIN-123", "aigile/LIN-123"],
        cwd: "/repo/aigile",
      },
    ]);
  });

  it("fails clearly when the existing worktree is on a different branch", async () => {
    const adapter = createGitWorkspaceAdapter({
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      exec: async (command, args) => {
        if (command === "test") return { stdout: "", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "rev-parse") {
          return { stdout: "aigile/LIN-999\n", stderr: "", exitCode: 0 };
        }
        throw new Error("worktree add should not run");
      },
    });

    await expect(
      adapter.createIssueWorkspace({
        issueKey: "LIN-123",
        baseBranch: "main",
      }),
    ).rejects.toThrow(
      "Issue worktree path already exists for branch aigile/LIN-999, expected aigile/LIN-123",
    );
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

    await expect(
      adapter.diffSummary({
        issueKey: "LIN-123",
        branchName: "aigile/LIN-123",
        worktreePath: "/repo/aigile/.worktrees/LIN-123",
        baseBranch: "main",
      }),
    ).resolves.toBe(" README.md | 2 ++");
  });

  it("reports dirty issue worktree status", async () => {
    const commands: Array<{ command: string; args: string[]; cwd: string }> = [];
    const adapter = createGitWorkspaceAdapter({
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      exec: async (command, args, options) => {
        commands.push({ command, args: [...args], cwd: options.cwd });
        if (command === "test") return { stdout: "", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "rev-parse") {
          return { stdout: "aigile/LIN-123\n", stderr: "", exitCode: 0 };
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

    await expect(
      adapter.getIssueWorkspaceStatus({
        issueKey: "LIN-123",
        baseBranch: "main",
      }),
    ).resolves.toEqual({
      workspace: {
        issueKey: "LIN-123",
        branchName: "aigile/LIN-123",
        worktreePath: "/repo/aigile/.worktrees/LIN-123",
        baseBranch: "main",
      },
      state: "dirty",
      currentBranch: "aigile/LIN-123",
      changedFiles: [" M packages/roles/src/acp-runner.ts", "?? scratch.md"],
    });
    expect(commands).toEqual([
      {
        command: "test",
        args: ["-e", "/repo/aigile/.worktrees/LIN-123"],
        cwd: "/repo/aigile",
      },
      {
        command: "git",
        args: ["rev-parse", "--abbrev-ref", "HEAD"],
        cwd: "/repo/aigile/.worktrees/LIN-123",
      },
      {
        command: "git",
        args: ["status", "--short"],
        cwd: "/repo/aigile/.worktrees/LIN-123",
      },
    ]);
  });

  it("reports missing issue worktree status without checking git", async () => {
    const commands: Array<{ command: string; args: string[]; cwd: string }> = [];
    const adapter = createGitWorkspaceAdapter({
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      exec: async (command, args, options) => {
        commands.push({ command, args: [...args], cwd: options.cwd });
        if (command === "test") return { stdout: "", stderr: "", exitCode: 1 };
        throw new Error("git should not run for missing status");
      },
    });

    await expect(
      adapter.getIssueWorkspaceStatus({
        issueKey: "LIN-404",
        baseBranch: "main",
      }),
    ).resolves.toMatchObject({
      state: "missing",
      changedFiles: [],
      workspace: {
        branchName: "aigile/LIN-404",
        worktreePath: "/repo/aigile/.worktrees/LIN-404",
      },
    });
    expect(commands).toEqual([
      {
        command: "test",
        args: ["-e", "/repo/aigile/.worktrees/LIN-404"],
        cwd: "/repo/aigile",
      },
    ]);
  });

  it("reports branch mismatch issue worktree status", async () => {
    const adapter = createGitWorkspaceAdapter({
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      exec: async (command, args) => {
        if (command === "test") return { stdout: "", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "rev-parse") {
          return { stdout: "aigile/LIN-999\n", stderr: "", exitCode: 0 };
        }
        throw new Error("git status should not run for branch mismatch");
      },
    });

    await expect(
      adapter.getIssueWorkspaceStatus({
        issueKey: "LIN-123",
        baseBranch: "main",
      }),
    ).resolves.toMatchObject({
      state: "branch_mismatch",
      currentBranch: "aigile/LIN-999",
      changedFiles: [],
    });
  });

  it("fails when git command exits non-zero", async () => {
    const adapter = createGitWorkspaceAdapter({
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      exec: async (command, args) => {
        if (command === "test") return { stdout: "", stderr: "", exitCode: 1 };
        if (command === "git" && args[0] === "show-ref")
          return { stdout: "", stderr: "", exitCode: 1 };
        return { stdout: "", stderr: "fatal", exitCode: 128 };
      },
    });

    await expect(
      adapter.createIssueWorkspace({
        issueKey: "LIN-123",
        baseBranch: "main",
      }),
    ).rejects.toThrow(/git worktree add failed/i);
  });
});
