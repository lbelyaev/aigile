import { describe, expect, it } from "bun:test";
import { createGitWorkspaceAdapter } from "./index.js";
import { createDefaultExecCommand, defaultExecCommand } from "./git-workspace.js";

describe("git workspace adapter", () => {
  it("resolves successful spawn output through the default exec command", async () => {
    await expect(defaultExecCommand("printf", ["hello"], { cwd: process.cwd() })).resolves.toEqual({
      stdout: "hello",
      stderr: "",
      exitCode: 0,
    });
  });

  it("rejects clearly when spawn fails", async () => {
    await expect(
      defaultExecCommand("aigile-nonexistent-binary", [], { cwd: process.cwd() }),
    ).rejects.toThrow(/aigile-nonexistent-binary.*ENOENT/);
  });

  it("kills and rejects commands that exceed the configured timeout", async () => {
    const exec = createDefaultExecCommand({ timeoutMs: 25 });

    await expect(exec("sleep", ["1"], { cwd: process.cwd() })).rejects.toThrow(
      /sleep.*timed out.*25ms/,
    );
  });

  it("kills and rejects commands that exceed the configured output cap", async () => {
    const exec = createDefaultExecCommand({ maxOutputBytes: 4 });

    await expect(exec("printf", ["12345"], { cwd: process.cwd() })).rejects.toThrow(
      /printf.*output.*4 bytes/,
    );
  });

  it("creates an issue worktree with a safe branch name", async () => {
    const commands: Array<{ command: string; args: string[]; cwd: string }> = [];
    const adapter = createGitWorkspaceAdapter({
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      exec: async (command, args, options) => {
        commands.push({ command, args: [...args], cwd: options.cwd });
        if (command === "git" && args[0] === "fetch")
          return { stdout: "", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "rev-parse")
          return { stdout: "remote-base\n", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "merge-base")
          return { stdout: "", stderr: "", exitCode: 0 };
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
        command: "git",
        args: ["fetch", "origin", "main"],
        cwd: "/repo/aigile",
      },
      {
        command: "git",
        args: ["rev-parse", "--verify", "refs/remotes/origin/main"],
        cwd: "/repo/aigile",
      },
      {
        command: "git",
        args: ["rev-parse", "--verify", "refs/heads/main"],
        cwd: "/repo/aigile",
      },
      {
        command: "git",
        args: ["merge-base", "--is-ancestor", "refs/heads/main", "refs/remotes/origin/main"],
        cwd: "/repo/aigile",
      },
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
          "refs/remotes/origin/main",
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
        if (command === "git" && args[0] === "fetch")
          return { stdout: "", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "rev-parse")
          return { stdout: "remote-base\n", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "merge-base")
          return { stdout: "", stderr: "", exitCode: 0 };
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
        command: "git",
        args: ["fetch", "origin", "main"],
        cwd: "/repo/aigile",
      },
      {
        command: "git",
        args: ["rev-parse", "--verify", "refs/remotes/origin/main"],
        cwd: "/repo/aigile",
      },
      {
        command: "git",
        args: ["rev-parse", "--verify", "refs/heads/main"],
        cwd: "/repo/aigile",
      },
      {
        command: "git",
        args: ["merge-base", "--is-ancestor", "refs/heads/main", "refs/remotes/origin/main"],
        cwd: "/repo/aigile",
      },
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
        if (command === "git" && args[0] === "fetch")
          return { stdout: "", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "rev-parse" && args[1] === "--verify")
          return { stdout: "remote-base\n", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "merge-base")
          return { stdout: "", stderr: "", exitCode: 0 };
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
        command: "git",
        args: ["fetch", "origin", "main"],
        cwd: "/repo/aigile",
      },
      {
        command: "git",
        args: ["rev-parse", "--verify", "refs/remotes/origin/main"],
        cwd: "/repo/aigile",
      },
      {
        command: "git",
        args: ["rev-parse", "--verify", "refs/heads/main"],
        cwd: "/repo/aigile",
      },
      {
        command: "git",
        args: ["merge-base", "--is-ancestor", "refs/heads/main", "refs/remotes/origin/main"],
        cwd: "/repo/aigile",
      },
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
        args: ["merge-base", "--is-ancestor", "refs/remotes/origin/main", "aigile/LIN-123"],
        cwd: "/repo/aigile",
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
        if (command === "git" && args[0] === "fetch")
          return { stdout: "", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "rev-parse")
          return { stdout: "remote-base\n", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "merge-base")
          return { stdout: "", stderr: "", exitCode: 0 };
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
        command: "git",
        args: ["fetch", "origin", "main"],
        cwd: "/repo/aigile",
      },
      {
        command: "git",
        args: ["rev-parse", "--verify", "refs/remotes/origin/main"],
        cwd: "/repo/aigile",
      },
      {
        command: "git",
        args: ["rev-parse", "--verify", "refs/heads/main"],
        cwd: "/repo/aigile",
      },
      {
        command: "git",
        args: ["merge-base", "--is-ancestor", "refs/heads/main", "refs/remotes/origin/main"],
        cwd: "/repo/aigile",
      },
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
        args: ["merge-base", "--is-ancestor", "refs/remotes/origin/main", "aigile/LIN-123"],
        cwd: "/repo/aigile",
      },
      {
        command: "git",
        args: ["worktree", "list", "--porcelain"],
        cwd: "/repo/aigile",
      },
      {
        command: "git",
        args: ["worktree", "add", "/repo/aigile/.worktrees/LIN-123", "aigile/LIN-123"],
        cwd: "/repo/aigile",
      },
    ]);
  });

  it("reuses an existing branch checked out in another worktree", async () => {
    const commands: Array<{ command: string; args: string[]; cwd: string }> = [];
    const adapter = createGitWorkspaceAdapter({
      repoPath: "/repo/aigile",
      worktreesPath: "/home/test/.aigile/worktrees/aigile",
      exec: async (command, args, options) => {
        commands.push({ command, args: [...args], cwd: options.cwd });
        if (command === "git" && args[0] === "fetch")
          return { stdout: "", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "rev-parse")
          return { stdout: "remote-base\n", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "merge-base")
          return { stdout: "", stderr: "", exitCode: 0 };
        if (command === "test") return { stdout: "", stderr: "", exitCode: 1 };
        if (command === "git" && args[0] === "show-ref")
          return { stdout: "", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "worktree" && args[1] === "list") {
          return {
            stdout: [
              "worktree /repo/aigile",
              "HEAD main-sha",
              "branch refs/heads/main",
              "",
              "worktree /repo/aigile/.worktrees/LIN-123",
              "HEAD issue-sha",
              "branch refs/heads/aigile/LIN-123",
              "",
            ].join("\n"),
            stderr: "",
            exitCode: 0,
          };
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
    expect(commands).toContainEqual({
      command: "git",
      args: ["worktree", "list", "--porcelain"],
      cwd: "/repo/aigile",
    });
    expect(commands).not.toContainEqual({
      command: "git",
      args: ["worktree", "add", "/home/test/.aigile/worktrees/aigile/LIN-123", "aigile/LIN-123"],
      cwd: "/repo/aigile",
    });
  });

  it("fails clearly when the existing worktree is on a different branch", async () => {
    const adapter = createGitWorkspaceAdapter({
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      exec: async (command, args) => {
        if (command === "git" && args[0] === "fetch")
          return { stdout: "", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "rev-parse" && args[1] === "--verify")
          return { stdout: "remote-base\n", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "merge-base")
          return { stdout: "", stderr: "", exitCode: 0 };
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

  it("creates new worktrees from a fetched remote base when the local base is stale", async () => {
    const commands: Array<{ command: string; args: string[]; cwd: string }> = [];
    const adapter = createGitWorkspaceAdapter({
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      exec: async (command, args, options) => {
        commands.push({ command, args: [...args], cwd: options.cwd });
        if (command === "git" && args[0] === "fetch")
          return { stdout: "", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "rev-parse")
          return { stdout: "sha\n", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "merge-base")
          return { stdout: "", stderr: "", exitCode: 0 };
        if (command === "test") return { stdout: "", stderr: "", exitCode: 1 };
        if (command === "git" && args[0] === "show-ref")
          return { stdout: "", stderr: "", exitCode: 1 };
        if (command === "git" && args[0] === "worktree")
          return { stdout: "", stderr: "", exitCode: 0 };
        throw new Error("unexpected command");
      },
    });

    await adapter.createIssueWorkspace({ issueKey: "LIN-124", baseBranch: "main" });

    expect(commands).toContainEqual({
      command: "git",
      args: ["fetch", "origin", "main"],
      cwd: "/repo/aigile",
    });
    expect(commands).toContainEqual({
      command: "git",
      args: [
        "worktree",
        "add",
        "-b",
        "aigile/LIN-124",
        "/repo/aigile/.worktrees/LIN-124",
        "refs/remotes/origin/main",
      ],
      cwd: "/repo/aigile",
    });
  });

  it("fails when the local base diverged from the fetched remote base", async () => {
    const adapter = createGitWorkspaceAdapter({
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      exec: async (command, args) => {
        if (command === "git" && args[0] === "fetch")
          return { stdout: "", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "rev-parse")
          return { stdout: "sha\n", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "merge-base")
          return { stdout: "", stderr: "", exitCode: 1 };
        throw new Error("workspace checks should not run");
      },
    });

    await expect(
      adapter.checkIssueWorkspaceAvailability({ issueKey: "LIN-125", baseBranch: "main" }),
    ).rejects.toThrow(
      "Base branch main cannot be fast-forwarded to origin/main; synchronize or reset the local base branch before starting Aigile.",
    );
  });

  it("fails clearly when fetching the base branch fails", async () => {
    const adapter = createGitWorkspaceAdapter({
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      exec: async (command, args) => {
        if (command === "git" && args[0] === "fetch") {
          return { stdout: "", stderr: "fatal: no such remote", exitCode: 128 };
        }
        throw new Error("workspace checks should not run");
      },
    });

    await expect(
      adapter.createIssueWorkspace({ issueKey: "LIN-404", baseBranch: "main" }),
    ).rejects.toThrow("Failed to fetch origin main before starting Aigile: fatal: no such remote");
  });

  it("fast-forwards an existing stale issue branch with no worktree before attaching it", async () => {
    const commands: Array<{ command: string; args: string[]; cwd: string }> = [];
    const adapter = createGitWorkspaceAdapter({
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      exec: async (command, args, options) => {
        commands.push({ command, args: [...args], cwd: options.cwd });
        if (command === "git" && args[0] === "fetch")
          return { stdout: "", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "rev-parse")
          return { stdout: "sha\n", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "merge-base" && args[2] === "refs/heads/main") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (command === "test") return { stdout: "", stderr: "", exitCode: 1 };
        if (command === "git" && args[0] === "show-ref")
          return { stdout: "", stderr: "", exitCode: 0 };
        if (
          command === "git" &&
          args[0] === "merge-base" &&
          args[2] === "refs/remotes/origin/main"
        ) {
          return { stdout: "", stderr: "", exitCode: 1 };
        }
        if (
          command === "git" &&
          args[0] === "merge-base" &&
          args[3] === "refs/remotes/origin/main"
        ) {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (command === "git" && args[0] === "worktree" && args[1] === "list") {
          return {
            stdout: ["worktree /repo/aigile", "HEAD main-sha", "branch refs/heads/main", ""].join(
              "\n",
            ),
            stderr: "",
            exitCode: 0,
          };
        }
        if (command === "git" && args[0] === "branch")
          return { stdout: "", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "worktree" && args[1] === "add")
          return { stdout: "", stderr: "", exitCode: 0 };
        throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
      },
    });

    await expect(
      adapter.createIssueWorkspace({ issueKey: "LIN-126", baseBranch: "main" }),
    ).resolves.toMatchObject({
      branchName: "aigile/LIN-126",
      worktreePath: "/repo/aigile/.worktrees/LIN-126",
    });
    expect(commands).toContainEqual({
      command: "git",
      args: ["branch", "-f", "aigile/LIN-126", "refs/remotes/origin/main"],
      cwd: "/repo/aigile",
    });
    expect(commands).toContainEqual({
      command: "git",
      args: ["worktree", "add", "/repo/aigile/.worktrees/LIN-126", "aigile/LIN-126"],
      cwd: "/repo/aigile",
    });
  });

  it("fast-forwards a clean checked-out stale issue branch before reuse", async () => {
    const commands: Array<{ command: string; args: string[]; cwd: string }> = [];
    const adapter = createGitWorkspaceAdapter({
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      exec: async (command, args, options) => {
        commands.push({ command, args: [...args], cwd: options.cwd });
        if (command === "git" && args[0] === "fetch")
          return { stdout: "", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "rev-parse" && args[1] === "--verify")
          return { stdout: "sha\n", stderr: "", exitCode: 0 };
        if (command === "test") return { stdout: "", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "rev-parse")
          return { stdout: "aigile/LIN-126\n", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "merge-base" && args[2] === "refs/heads/main") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (
          command === "git" &&
          args[0] === "merge-base" &&
          args[2] === "refs/remotes/origin/main"
        ) {
          return { stdout: "", stderr: "", exitCode: 1 };
        }
        if (
          command === "git" &&
          args[0] === "merge-base" &&
          args[3] === "refs/remotes/origin/main"
        ) {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (command === "git" && args[0] === "status")
          return { stdout: "", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "merge")
          return { stdout: "", stderr: "", exitCode: 0 };
        throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
      },
    });

    await expect(
      adapter.createIssueWorkspace({ issueKey: "LIN-126", baseBranch: "main" }),
    ).resolves.toMatchObject({
      branchName: "aigile/LIN-126",
      worktreePath: "/repo/aigile/.worktrees/LIN-126",
    });
    expect(commands).toContainEqual({
      command: "git",
      args: ["status", "--short"],
      cwd: "/repo/aigile/.worktrees/LIN-126",
    });
    expect(commands).toContainEqual({
      command: "git",
      args: ["merge", "--ff-only", "refs/remotes/origin/main"],
      cwd: "/repo/aigile/.worktrees/LIN-126",
    });
  });

  it("resets a checked-out stale issue branch with abandoned uncommitted changes", async () => {
    const commands: Array<{ command: string; args: string[]; cwd: string }> = [];
    const adapter = createGitWorkspaceAdapter({
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      exec: async (command, args, options) => {
        commands.push({ command, args: [...args], cwd: options.cwd });
        if (command === "git" && args[0] === "fetch")
          return { stdout: "", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "rev-parse" && args[1] === "--verify")
          return { stdout: "sha\n", stderr: "", exitCode: 0 };
        if (command === "test") return { stdout: "", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "rev-parse")
          return { stdout: "aigile/LIN-126\n", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "merge-base" && args[2] === "refs/heads/main") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (
          command === "git" &&
          args[0] === "merge-base" &&
          args[2] === "refs/remotes/origin/main"
        ) {
          return { stdout: "", stderr: "", exitCode: 1 };
        }
        if (
          command === "git" &&
          args[0] === "merge-base" &&
          args[3] === "refs/remotes/origin/main"
        ) {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (command === "git" && args[0] === "status")
          return { stdout: " M packages/cli/src/main.ts\n", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "reset")
          return { stdout: "", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "clean")
          return { stdout: "", stderr: "", exitCode: 0 };
        throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
      },
    });

    await expect(
      adapter.createIssueWorkspace({ issueKey: "LIN-126", baseBranch: "main" }),
    ).resolves.toMatchObject({
      branchName: "aigile/LIN-126",
      worktreePath: "/repo/aigile/.worktrees/LIN-126",
    });
    expect(commands).toContainEqual({
      command: "git",
      args: ["reset", "--hard", "refs/remotes/origin/main"],
      cwd: "/repo/aigile/.worktrees/LIN-126",
    });
    expect(commands).toContainEqual({
      command: "git",
      args: ["clean", "-fd"],
      cwd: "/repo/aigile/.worktrees/LIN-126",
    });
    // a dirty worktree must not be fast-forward merged
    expect(commands).not.toContainEqual(
      expect.objectContaining({
        command: "git",
        args: ["merge", "--ff-only", "refs/remotes/origin/main"],
      }),
    );
  });

  it("blocks reuse of an existing diverged issue branch", async () => {
    const adapter = createGitWorkspaceAdapter({
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      exec: async (command, args) => {
        if (command === "git" && args[0] === "fetch")
          return { stdout: "", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "rev-parse")
          return { stdout: "sha\n", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "merge-base" && args[2] === "refs/heads/main") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (command === "test") return { stdout: "", stderr: "", exitCode: 1 };
        if (command === "git" && args[0] === "show-ref")
          return { stdout: "", stderr: "", exitCode: 0 };
        if (
          command === "git" &&
          args[0] === "merge-base" &&
          args[2] === "refs/remotes/origin/main"
        ) {
          return { stdout: "", stderr: "", exitCode: 1 };
        }
        if (
          command === "git" &&
          args[0] === "merge-base" &&
          args[3] === "refs/remotes/origin/main"
        ) {
          return { stdout: "", stderr: "", exitCode: 1 };
        }
        throw new Error("worktree add should not run");
      },
    });

    await expect(
      adapter.createIssueWorkspace({ issueKey: "LIN-126", baseBranch: "main" }),
    ).rejects.toThrow(
      "Issue branch aigile/LIN-126 diverged from origin/main; rebase or recreate it before starting Aigile.",
    );
  });

  it("fails when git command exits non-zero", async () => {
    const adapter = createGitWorkspaceAdapter({
      repoPath: "/repo/aigile",
      worktreesPath: "/repo/aigile/.worktrees",
      exec: async (command, args) => {
        if (command === "git" && args[0] === "fetch")
          return { stdout: "", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "rev-parse")
          return { stdout: "sha\n", stderr: "", exitCode: 0 };
        if (command === "git" && args[0] === "merge-base")
          return { stdout: "", stderr: "", exitCode: 0 };
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
