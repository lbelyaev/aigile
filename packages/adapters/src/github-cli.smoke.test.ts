import { describe, expect, it } from "bun:test";
import { createGitHubCliCodeHostAdapter, type GitHubCliExec } from "./index.js";

const smokeIt = process.env.AIGILE_REAL_GH_SMOKE === "1" ? it : it.skip;

const realGhExec: GitHubCliExec = async (command, args, options) => {
  const spawnOptions =
    options.cwd === undefined
      ? { stdout: "pipe" as const, stderr: "pipe" as const }
      : { cwd: options.cwd, stdout: "pipe" as const, stderr: "pipe" as const };
  const proc = Bun.spawn([command, ...args], spawnOptions);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
};

describe("GitHub CLI real smoke", () => {
  smokeIt("accepts adapter gh pr view fields and rejects a known-bad field", async () => {
    const repo = process.env.AIGILE_REAL_GH_REPO;
    const pullRequestNumber = process.env.AIGILE_REAL_GH_PR;
    if (!repo || !pullRequestNumber) {
      throw new Error("Set AIGILE_REAL_GH_REPO=owner/repo and AIGILE_REAL_GH_PR=number");
    }
    const [owner, name] = repo.split("/");
    if (!owner || !name) throw new Error(`Invalid AIGILE_REAL_GH_REPO: ${repo}`);

    const adapter = createGitHubCliCodeHostAdapter({ exec: realGhExec });

    await expect(
      adapter.getPullRequestMergeability(`${repo}#${pullRequestNumber}`),
    ).resolves.toHaveProperty("status");
    await expect(
      adapter.getPullRequestMergeState(`${repo}#${pullRequestNumber}`),
    ).resolves.toHaveProperty("status");

    const badField = await realGhExec(
      "gh",
      ["pr", "view", pullRequestNumber, "--repo", `${owner}/${name}`, "--json", "merged"],
      {},
    );
    expect(badField.exitCode).not.toBe(0);
  });
});
