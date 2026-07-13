import { describe, expect, it } from "bun:test";
import { createGitPublisher } from "./index.js";

describe("git publisher", () => {
  it("stages, commits, and pushes a workspace branch", async () => {
    const commands: string[][] = [];
    const publisher = createGitPublisher({
      exec: async (command, args, options) => {
        commands.push([command, ...args, `cwd=${options.cwd}`]);
        if (args.join(" ") === "diff --cached --quiet") {
          return { stdout: "", stderr: "", exitCode: 1 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    await publisher.publish({
      worktreePath: "/repo/.worktrees/LIN-123",
      branchName: "aigile/LIN-123",
      owner: "lbelyaev",
      repo: "aigile",
      commitMessage: "feat: implement LIN-123",
    });

    expect(commands).toEqual([
      ["git", "add", "-A", "cwd=/repo/.worktrees/LIN-123"],
      ["git", "diff", "--cached", "--quiet", "cwd=/repo/.worktrees/LIN-123"],
      ["git", "commit", "-m", "feat: implement LIN-123", "cwd=/repo/.worktrees/LIN-123"],
      [
        "git",
        "-c",
        "credential.helper=",
        "-c",
        "credential.helper=!gh auth git-credential",
        "push",
        "https://github.com/lbelyaev/aigile.git",
        "HEAD:aigile/LIN-123",
        "cwd=/repo/.worktrees/LIN-123",
      ],
    ]);
  });

  it("pushes without committing when no staged changes exist", async () => {
    const commands: string[][] = [];
    const publisher = createGitPublisher({
      exec: async (command, args, options) => {
        commands.push([command, ...args, `cwd=${options.cwd}`]);
        if (args.join(" ") === "diff --cached --quiet") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    await publisher.publish({
      worktreePath: "/repo/.worktrees/LBE-8",
      branchName: "aigile/LBE-8",
      owner: "aigile",
      repo: "demo",
      commitMessage: "feat: implement LBE-8",
    });

    expect(commands).toEqual([
      ["git", "add", "-A", "cwd=/repo/.worktrees/LBE-8"],
      ["git", "diff", "--cached", "--quiet", "cwd=/repo/.worktrees/LBE-8"],
      [
        "git",
        "-c",
        "credential.helper=",
        "-c",
        "credential.helper=!gh auth git-credential",
        "push",
        "https://github.com/aigile/demo.git",
        "HEAD:aigile/LBE-8",
        "cwd=/repo/.worktrees/LBE-8",
      ],
    ]);
  });

  it("fails when a git publish step fails", async () => {
    const publisher = createGitPublisher({
      exec: async () => ({ stdout: "", stderr: "git exploded", exitCode: 2 }),
    });

    await expect(
      publisher.publish({
        worktreePath: "/repo/.worktrees/LIN-123",
        branchName: "aigile/LIN-123",
        owner: "lbelyaev",
        repo: "aigile",
        commitMessage: "feat: implement LIN-123",
      }),
    ).rejects.toThrow(/git add failed/i);
  });

  it("retries a transient push failure and reuses the existing commit", async () => {
    const commands: string[][] = [];
    let pushCalls = 0;
    const publisher = createGitPublisher({
      retry: { maxAttempts: 2, baseDelayMs: 1, sleep: async () => {} },
      exec: async (command, args, options) => {
        commands.push([command, ...args, `cwd=${options.cwd}`]);
        if (args.join(" ") === "diff --cached --quiet") {
          return { stdout: "", stderr: "", exitCode: pushCalls === 0 ? 1 : 0 };
        }
        if (args.includes("push")) {
          pushCalls += 1;
          if (pushCalls === 1) {
            return {
              stdout: "",
              stderr: "Received disconnect from github.com port 22: Bye Bye",
              exitCode: 128,
            };
          }
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    await publisher.publish({
      worktreePath: "/repo/.worktrees/LBE-34",
      branchName: "aigile/LBE-34",
      owner: "aigile",
      repo: "demo",
      commitMessage: "feat: implement LBE-34",
    });

    expect(pushCalls).toBe(2);
    expect(commands.filter((command) => command.includes("commit"))).toHaveLength(1);
  });

  it("does not retry a rejected push", async () => {
    let pushCalls = 0;
    const publisher = createGitPublisher({
      retry: { maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} },
      exec: async (_command, args) => {
        if (args.join(" ") === "diff --cached --quiet") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (args.includes("push")) {
          pushCalls += 1;
          return {
            stdout: "",
            stderr: "! [rejected] HEAD -> aigile/LBE-34 (non-fast-forward)",
            exitCode: 1,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    await expect(
      publisher.publish({
        worktreePath: "/repo/.worktrees/LBE-34",
        branchName: "aigile/LBE-34",
        owner: "aigile",
        repo: "demo",
        commitMessage: "feat: implement LBE-34",
      }),
    ).rejects.toThrow(/non-fast-forward/i);
    expect(pushCalls).toBe(1);
  });
});
