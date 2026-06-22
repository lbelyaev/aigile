import { describe, expect, it } from "bun:test";
import { createFakeIssueTrackerAdapter, createFakeReadyIssueSource } from "@aigile/adapters";
import {
  defaultClaimComment,
  routeReadyIssuesForProducts,
  watchLoop,
  watchOnce,
  type WatchLoopEvent,
} from "./index.js";

describe("watchOnce", () => {
  it("claims the first ready issue and posts an operator comment", async () => {
    const seedIssues = [
      {
        id: "issue-1",
        key: "LIN-900",
        title: "Watcher skeleton",
        description: "Claim one ready issue.",
        acceptanceCriteria: ["Ready issue is claimed"],
        status: "ready",
        comments: [],
      },
      {
        id: "issue-2",
        key: "LIN-901",
        title: "Second ready issue",
        description: "Waits for the next pass.",
        acceptanceCriteria: [],
        status: "ready",
        comments: [],
      },
    ];
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

  it("updates status without appending a duplicate default claim comment", async () => {
    const seedIssues = [
      {
        id: "issue-1",
        key: "LIN-900",
        title: "Already claimed issue",
        description: "Do not duplicate the claim comment.",
        acceptanceCriteria: [],
        status: "ready",
        comments: [defaultClaimComment],
      },
    ];
    const tracker = createFakeIssueTrackerAdapter(seedIssues);

    const result = await watchOnce({
      source: createFakeReadyIssueSource(seedIssues),
      tracker,
    });

    expect(result).toMatchObject({
      readyCount: 1,
      claimedIssue: { key: "LIN-900" },
      actions: ["status:LIN-900:aigile:claimed"],
    });
    expect(await tracker.getIssue("LIN-900")).toMatchObject({
      status: "aigile:claimed",
      comments: [defaultClaimComment],
    });
  });

  it("checks a custom claim comment before appending", async () => {
    const customClaimComment = "Custom claim note.";
    const seedIssues = [
      {
        id: "issue-1",
        key: "LIN-900",
        title: "Already claimed issue",
        description: "Do not duplicate a configured claim comment.",
        acceptanceCriteria: [],
        status: "ready",
        comments: [customClaimComment],
      },
    ];
    const tracker = createFakeIssueTrackerAdapter(seedIssues);

    const result = await watchOnce({
      source: createFakeReadyIssueSource(seedIssues),
      tracker,
      claimComment: customClaimComment,
    });

    expect(result).toMatchObject({
      readyCount: 1,
      claimedIssue: { key: "LIN-900" },
      actions: ["status:LIN-900:aigile:claimed"],
    });
    expect(await tracker.getIssue("LIN-900")).toMatchObject({
      status: "aigile:claimed",
      comments: [customClaimComment],
    });
  });

  it("polls repeatedly without claiming the same issue twice in one process", async () => {
    const seedIssues = [
      {
        id: "issue-1",
        key: "LIN-900",
        title: "Watcher loop",
        description: "Claim once.",
        acceptanceCriteria: [],
        status: "ready",
        comments: [],
      },
    ];
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
    const seedIssues = [
      {
        id: "issue-1",
        key: "LIN-900",
        title: "Watcher loop",
        description: "Start work after claim.",
        acceptanceCriteria: [],
        status: "ready",
        comments: [],
      },
    ];
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

  it("restores the prior status and keeps the loop alive when claimed issue handling fails", async () => {
    const seedIssues = [
      {
        id: "issue-1",
        key: "LIN-900",
        title: "Watcher loop",
        description: "Start work after claim.",
        acceptanceCriteria: [],
        status: "Todo",
        comments: [],
      },
    ];
    const tracker = createFakeIssueTrackerAdapter(seedIssues);
    const events: string[] = [];

    await watchLoop({
      source: createFakeReadyIssueSource(seedIssues, "Todo"),
      tracker,
      claimStatus: "In Progress",
      pollIntervalMs: 1,
      maxPolls: 2,
      sleep: async () => {},
      onEvent: (event) => {
        events.push(
          event.type === "claimed_issue_run_failed"
            ? `${event.type}:${event.issueKey}:${event.restoredStatus}:${event.error}`
            : event.type,
        );
      },
      onClaimedIssue: async () => {
        throw new Error("worktree is stale");
      },
    });

    expect(events).toEqual([
      "poll_started",
      "issue_claimed",
      "claimed_issue_run_failed:LIN-900:Todo:worktree is stale",
      "poll_started",
      "poll_idle",
      "watch_stopped",
    ]);
    expect(await tracker.getIssue("LIN-900")).toMatchObject({
      status: "Todo",
      comments: [defaultClaimComment],
    });
  });

  it("claims a product-backed issue when the Linear project matches", async () => {
    const seedIssues = [
      {
        id: "issue-1",
        key: "LIN-900",
        title: "Product issue",
        description: "Claim matching project.",
        acceptanceCriteria: [],
        status: "ready",
        project: { id: "project-a", name: "Aigile" },
        comments: [],
      },
    ];
    const tracker = createFakeIssueTrackerAdapter(seedIssues);

    const result = await watchOnce({
      source: createFakeReadyIssueSource(seedIssues),
      tracker,
      productRoutes: [
        { productId: "aigile", linearProject: "Aigile", githubRepo: "lbelyaev/aigile" },
      ],
    });

    expect(result).toMatchObject({
      readyCount: 1,
      claimedIssue: { key: "LIN-900" },
      selectedRoute: {
        productId: "aigile",
        linearProject: "Aigile",
        githubRepo: "lbelyaev/aigile",
      },
      actions: ["status:LIN-900:aigile:claimed", "comment:LIN-900"],
    });
  });

  it("skips a product-backed issue when the Linear project does not match", async () => {
    const seedIssues = [
      {
        id: "issue-1",
        key: "LIN-900",
        title: "Wrong product issue",
        description: "Skip mismatched project.",
        acceptanceCriteria: [],
        status: "ready",
        project: { id: "project-b", name: "Other Project" },
        comments: [],
      },
    ];
    const tracker = createFakeIssueTrackerAdapter(seedIssues);

    const result = await watchOnce({
      source: createFakeReadyIssueSource(seedIssues),
      tracker,
      productRoutes: [
        { productId: "aigile", linearProject: "Aigile", githubRepo: "lbelyaev/aigile" },
      ],
    });

    expect(result).toMatchObject({
      readyCount: 0,
      actions: ["skip:LIN-900:project_mismatch", "no_ready_issues"],
      skippedIssues: [{ issueKey: "LIN-900", reason: "project_mismatch" }],
    });
    expect(await tracker.getIssue("LIN-900")).toMatchObject({ status: "ready", comments: [] });
  });

  it("skips a product-backed issue with no Linear project and reports the reason", async () => {
    const seedIssues = [
      {
        id: "issue-1",
        key: "LIN-900",
        title: "Unprojected issue",
        description: "Skip missing project.",
        acceptanceCriteria: [],
        status: "ready",
        comments: [],
      },
    ];
    const tracker = createFakeIssueTrackerAdapter(seedIssues);

    const result = await watchOnce({
      source: createFakeReadyIssueSource(seedIssues),
      tracker,
      productRoutes: [
        { productId: "aigile", linearProject: "Aigile", githubRepo: "lbelyaev/aigile" },
      ],
    });

    expect(result).toMatchObject({
      readyCount: 0,
      actions: ["skip:LIN-900:no_project", "no_ready_issues"],
      skippedIssues: [{ issueKey: "LIN-900", reason: "no_project" }],
    });
    expect(await tracker.getIssue("LIN-900")).toMatchObject({ status: "ready", comments: [] });
  });

  it("uses Linear project to disambiguate products on the same Linear team", () => {
    const routed = routeReadyIssuesForProducts(
      [
        {
          id: "issue-1",
          key: "LIN-900",
          title: "API issue",
          description: "",
          acceptanceCriteria: [],
          status: "ready",
          project: { id: "api-project", name: "API" },
          comments: [],
        },
      ],
      [
        { productId: "web", linearProject: "Web", githubRepo: "lbelyaev/web" },
        { productId: "api", linearProject: "API", githubRepo: "lbelyaev/api" },
      ],
    );

    expect(routed.readyIssues).toMatchObject([
      {
        issue: { key: "LIN-900" },
        route: { productId: "api", linearProject: "API", githubRepo: "lbelyaev/api" },
      },
    ]);
    expect(routed.skippedIssues).toEqual([]);
  });

  it("reconciles in-flight issue status each poll and emits an event", async () => {
    const inFlight = {
      id: "i",
      key: "LIN-7",
      title: "In review",
      description: "",
      acceptanceCriteria: [],
      status: "In Review",
      comments: [],
    };
    const events: WatchLoopEvent[] = [];

    await watchLoop({
      source: createFakeReadyIssueSource([]),
      tracker: createFakeIssueTrackerAdapter([inFlight]),
      pollIntervalMs: 1,
      maxPolls: 1,
      sleep: async () => {},
      reconcile: {
        listIssues: async () => [inFlight],
        reconcileIssue: async () => ({ kind: "updated", from: "In Review", to: "Done" }),
      },
      onEvent: (event) => events.push(event),
    });

    expect(events).toContainEqual({
      type: "issue_status_reconciled",
      poll: 1,
      issueKey: "LIN-7",
      from: "In Review",
      to: "Done",
    });
  });

  it("keeps polling when reconciliation throws", async () => {
    const events: string[] = [];
    await watchLoop({
      source: createFakeReadyIssueSource([]),
      tracker: createFakeIssueTrackerAdapter([]),
      pollIntervalMs: 1,
      maxPolls: 1,
      sleep: async () => {},
      reconcile: {
        listIssues: async () => {
          throw new Error("linear unavailable");
        },
        reconcileIssue: async () => ({ kind: "no_pull_request" }),
      },
      onEvent: (event) => events.push(event.type),
    });

    expect(events).toContain("watch_stopped");
  });
});
