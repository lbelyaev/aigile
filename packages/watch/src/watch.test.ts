import { describe, expect, it } from "bun:test";
import { createFakeIssueTrackerAdapter, createFakeReadyIssueSource } from "@aigile/adapters";
import { defaultClaimComment, watchLoop, watchOnce } from "./index.js";

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

  it("polls repeatedly without claiming the same issue twice in one process", async () => {
    const seedIssues = [{
      id: "issue-1",
      key: "LIN-900",
      title: "Watcher loop",
      description: "Claim once.",
      acceptanceCriteria: [],
      status: "ready",
      comments: [],
    }];
    const tracker = createFakeIssueTrackerAdapter(seedIssues);
    const events: string[] = [];

    await watchLoop({
      source: createFakeReadyIssueSource(seedIssues),
      tracker,
      pollIntervalMs: 1,
      maxPolls: 2,
      sleep: async () => {},
      onEvent: (event) => {
        events.push(event.type);
      },
    });

    expect(events).toEqual([
      "poll_started",
      "issue_claimed",
      "poll_started",
      "poll_idle",
      "watch_stopped",
    ]);
    expect(await tracker.getIssue("LIN-900")).toMatchObject({
      status: "aigile:claimed",
      comments: [defaultClaimComment],
    });
  });

  it("stops when aborted before a poll begins", async () => {
    const controller = new AbortController();
    controller.abort();
    const events: string[] = [];

    await watchLoop({
      source: createFakeReadyIssueSource([]),
      tracker: createFakeIssueTrackerAdapter([]),
      pollIntervalMs: 1,
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event.type);
      },
    });

    expect(events).toEqual(["watch_stopped"]);
  });

  it("runs a callback after a successful claim", async () => {
    const seedIssues = [{
      id: "issue-1",
      key: "LIN-900",
      title: "Watcher loop",
      description: "Start work after claim.",
      acceptanceCriteria: [],
      status: "ready",
      comments: [],
    }];
    const claimedIssueKeys: string[] = [];

    await watchLoop({
      source: createFakeReadyIssueSource(seedIssues),
      tracker: createFakeIssueTrackerAdapter(seedIssues),
      pollIntervalMs: 1,
      maxPolls: 1,
      onClaimedIssue: async (issue) => {
        claimedIssueKeys.push(issue.key);
      },
    });

    expect(claimedIssueKeys).toEqual(["LIN-900"]);
  });
});
