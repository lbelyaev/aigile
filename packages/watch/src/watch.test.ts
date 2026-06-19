import { describe, expect, it } from "bun:test";
import { createFakeIssueTrackerAdapter, createFakeReadyIssueSource } from "@aigile/adapters";
import { defaultClaimComment, watchOnce } from "./index.js";

describe("watchOnce", () => {
  it("claims the first ready issue and posts an operator comment", async () => {
    const seedIssues = [{
      id: "issue-1",
      key: "LIN-900",
      title: "Watcher skeleton",
      description: "Claim one ready issue.",
      acceptanceCriteria: ["Ready issue is claimed"],
      status: "ready",
      comments: [],
    }, {
      id: "issue-2",
      key: "LIN-901",
      title: "Second ready issue",
      description: "Waits for the next pass.",
      acceptanceCriteria: [],
      status: "ready",
      comments: [],
    }];
    const tracker = createFakeIssueTrackerAdapter(seedIssues);

    const result = await watchOnce({
      source: createFakeReadyIssueSource(seedIssues),
      tracker,
    });

    expect(result).toMatchObject({
      readyCount: 2,
      claimedIssue: { key: "LIN-900" },
      actions: ["status:LIN-900:aigile:claimed", "comment:LIN-900"],
    });
    expect(await tracker.getIssue("LIN-900")).toMatchObject({
      status: "aigile:claimed",
      comments: [defaultClaimComment],
    });
    expect(await tracker.getIssue("LIN-901")).toMatchObject({
      status: "ready",
      comments: [],
    });
  });

  it("reports an idle pass when no ready issues exist", async () => {
    const result = await watchOnce({
      source: createFakeReadyIssueSource([]),
      tracker: createFakeIssueTrackerAdapter([]),
    });

    expect(result).toEqual({
      readyCount: 0,
      actions: ["no_ready_issues"],
    });
  });
});
