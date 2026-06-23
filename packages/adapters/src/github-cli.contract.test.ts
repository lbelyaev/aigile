import { describe, expect, it } from "bun:test";
import {
  createFakeCodeHostAdapter,
  createGitHubCliCodeHostAdapter,
  type GitHubCliExec,
} from "./index.js";

const validPrViewJsonFields = Object.freeze(
  new Set([
    "additions",
    "assignees",
    "author",
    "autoMergeRequest",
    "baseRefName",
    "baseRefOid",
    "body",
    "changedFiles",
    "closed",
    "closedAt",
    "closingIssuesReferences",
    "comments",
    "commits",
    "createdAt",
    "deletions",
    "files",
    "fullDatabaseId",
    "headRefName",
    "headRefOid",
    "headRepository",
    "headRepositoryOwner",
    "id",
    "isCrossRepository",
    "isDraft",
    "labels",
    "latestReviews",
    "maintainerCanModify",
    "mergeCommit",
    "mergeStateStatus",
    "mergeable",
    "mergedAt",
    "mergedBy",
    "milestone",
    "number",
    "potentialMergeCommit",
    "projectCards",
    "projectItems",
    "reactionGroups",
    "reviewDecision",
    "reviewRequests",
    "reviews",
    "state",
    "statusCheckRollup",
    "title",
    "updatedAt",
    "url",
  ]),
);

const collectPrViewJsonFields = async (): Promise<string[]> => {
  const fields: string[] = [];
  const exec: GitHubCliExec = async (_command, args) => {
    const jsonFlagIndex = args.indexOf("--json");
    if (args[0] === "pr" && args[1] === "view" && jsonFlagIndex >= 0) {
      fields.push(...(args[jsonFlagIndex + 1] ?? "").split(",").filter(Boolean));
    }
    return { stdout: "{}", stderr: "", exitCode: 0 };
  };
  const adapter = createGitHubCliCodeHostAdapter({ exec });

  await adapter.getPullRequestMergeability("owner/repo#1");
  await adapter.getPullRequestMergeState("owner/repo#1");
  await adapter.findPullRequestForBranch("aigile/LIN-1", { owner: "owner", repo: "repo" });

  return fields;
};

describe("GitHub CLI adapter contracts", () => {
  it("requests only valid gh pr view --json fields", async () => {
    const fields = await collectPrViewJsonFields();

    expect(fields).toEqual([
      "mergeable",
      "mergeStateStatus",
      "state",
      "mergedAt",
      "number",
      "url",
      "state",
    ]);
    expect(validPrViewJsonFields.has("merged")).toBe(false);
    expect(fields.filter((field) => !validPrViewJsonFields.has(field))).toEqual([]);
  });

  it("surfaces merged pull request mergeability as unknown", async () => {
    const adapter = createGitHubCliCodeHostAdapter({
      exec: async () => ({
        stdout: JSON.stringify({ mergeStateStatus: "UNKNOWN" }),
        stderr: "",
        exitCode: 0,
      }),
    });

    await expect(adapter.getPullRequestMergeability("owner/repo#31")).resolves.toEqual({
      status: "unknown",
      mergeStateStatus: "UNKNOWN",
    });

    const fakeCodeHost = createFakeCodeHostAdapter({ mergeability: "mergeable", merged: true });
    const pr = await fakeCodeHost.createPullRequest({
      owner: "owner",
      repo: "repo",
      branch: "aigile/LIN-31",
      baseBranch: "main",
      title: "LIN-31 Handle merged PR",
      body: "body",
    });

    await expect(fakeCodeHost.getPullRequestMergeability(pr.id)).resolves.toEqual({
      status: "unknown",
    });
  });
});
