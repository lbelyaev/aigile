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
});
