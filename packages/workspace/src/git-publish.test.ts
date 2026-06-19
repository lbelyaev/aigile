import { describe, expect, it } from "bun:test";
import { createGitPublisher } from "./index.js";

describe("git publisher", () => {
  it("stages, commits, and pushes a workspace branch", async () => {
    const commands: string[][] = [];
    const publisher = createGitPublisher({
      exec: async (command, args, options) => {
        commands.push([command, ...args, `cwd=${options.cwd}`]);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    await publisher.publish({
      worktreePath: "/repo/.worktrees/LIN-123",
      branchName: "aigile/LIN-123",
      remote: "origin",
      commitMessage: "feat: implement LIN-123",
    });

    expect(commands).toEqual([
      ["git", "add", "-A", "cwd=/repo/.worktrees/LIN-123"],
      ["git", "commit", "-m", "feat: implement LIN-123", "cwd=/repo/.worktrees/LIN-123"],
      ["git", "push", "-u", "origin", "aigile/LIN-123", "cwd=/repo/.worktrees/LIN-123"],
    ]);
  });

  it("fails when a git publish step fails", async () => {
    const publisher = createGitPublisher({
      exec: async () => ({ stdout: "", stderr: "nothing to commit", exitCode: 1 }),
    });

    await expect(
      publisher.publish({
        worktreePath: "/repo/.worktrees/LIN-123",
        branchName: "aigile/LIN-123",
        remote: "origin",
        commitMessage: "feat: implement LIN-123",
      }),
    ).rejects.toThrow(/git add failed/i);
  });
});
