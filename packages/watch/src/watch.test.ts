import { describe, expect, it } from "bun:test";
import { createFakeIssueTrackerAdapter, createFakeReadyIssueSource } from "@aigile/adapters";
import {
  ClaimedRunFailure,
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

  it("passes the selected product route to the claim callback", async () => {
    const seedIssues = [
      {
        id: "issue-1",
        key: "LIN-901",
        title: "Product route",
        description: "Start work with route context.",
        acceptanceCriteria: [],
        status: "ready",
        project: { id: "project-api", name: "API" },
        comments: [],
      },
    ];
    const claimedRoutes: unknown[] = [];

    await watchLoop({
      source: createFakeReadyIssueSource(seedIssues),
      tracker: createFakeIssueTrackerAdapter(seedIssues),
      pollIntervalMs: 1,
      maxPolls: 1,
      productRoutes: [
        { productId: "web", linearProject: "Web", githubRepo: "lbelyaev/web" },
        { productId: "api", linearProject: "API", githubRepo: "lbelyaev/api" },
      ],
      onClaimedIssue: async (_issue, route) => {
        claimedRoutes.push(route);
      },
    });

    expect(claimedRoutes).toEqual([
      { productId: "api", linearProject: "API", githubRepo: "lbelyaev/api" },
    ]);
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
            ? `${event.type}:${event.issueKey}:${event.productId}:${event.phase}:${event.restoredStatus}:${event.error}`
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
      "claimed_issue_run_failed:LIN-900::workspace:Todo:worktree is stale",
      "poll_started",
      "poll_idle",
      "watch_stopped",
    ]);
    expect(await tracker.getIssue("LIN-900")).toMatchObject({
      status: "Todo",
      comments: [
        defaultClaimComment,
        "Aigile run failed for LIN-900 (product: unrouted, phase: workspace): worktree is stale",
      ],
    });
  });

  it("records phase, product, and a concise failure comment for contained run failures", async () => {
    const seedIssues = [
      {
        id: "issue-1",
        key: "LIN-901",
        title: "Product run",
        description: "Contain a product run failure.",
        acceptanceCriteria: [],
        status: "Todo",
        project: { id: "project-web", name: "Web" },
        comments: [],
      },
    ];
    const tracker = createFakeIssueTrackerAdapter(seedIssues);
    const failures: WatchLoopEvent[] = [];

    await watchLoop({
      source: createFakeReadyIssueSource(seedIssues, "Todo"),
      tracker,
      claimStatus: "In Progress",
      pollIntervalMs: 1,
      maxPolls: 1,
      sleep: async () => {},
      productRoutes: [{ productId: "web", linearProject: "Web", githubRepo: "lbelyaev/web" }],
      onEvent: (event) => {
        if (event.type === "claimed_issue_run_failed") failures.push(event);
      },
      onClaimedIssue: async () => {
        throw new ClaimedRunFailure("preflight", "gh auth status failed");
      },
    });

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      type: "claimed_issue_run_failed",
      issueKey: "LIN-901",
      productId: "web",
      phase: "preflight",
      message: "gh auth status failed",
      outcome: {
        type: "failure",
        issueKey: "LIN-901",
        productId: "web",
        phase: "preflight",
        message: "gh auth status failed",
      },
    });
    expect((await tracker.getIssue("LIN-901")).comments).toEqual([
      defaultClaimComment,
      "Aigile run failed for LIN-901 (product: web, phase: preflight): gh auth status failed",
    ]);
  });

  it("contains role runtime, verification exhaustion, and publish failures as run outcomes", async () => {
    const phases = [
      ["runtime", "runtime config is invalid"],
      ["agent", "developer runtime exited"],
      ["verification", "verification failed after 3 attempts"],
      ["publish", "pull request creation failed"],
    ] as const;

    for (const [phase, message] of phases) {
      const seedIssues = [
        {
          id: `issue-${phase}`,
          key: `LIN-${phase}`,
          title: `${phase} failure`,
          description: "Contain phase-specific failures.",
          acceptanceCriteria: [],
          status: "Todo",
          comments: [],
        },
      ];
      const tracker = createFakeIssueTrackerAdapter(seedIssues);
      const failures: WatchLoopEvent[] = [];

      await watchLoop({
        source: createFakeReadyIssueSource(seedIssues, "Todo"),
        tracker,
        claimStatus: "In Progress",
        pollIntervalMs: 1,
        maxPolls: 1,
        sleep: async () => {},
        onEvent: (event) => {
          if (event.type === "claimed_issue_run_failed") failures.push(event);
        },
        onClaimedIssue: async () => {
          throw new ClaimedRunFailure(phase, message);
        },
      });

      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        issueKey: `LIN-${phase}`,
        productId: "",
        phase,
        message,
      });
      expect((await tracker.getIssue(`LIN-${phase}`)).comments.at(-1)).toBe(
        `Aigile run failed for LIN-${phase} (product: unrouted, phase: ${phase}): ${message}`,
      );
    }
  });

  it("keeps polling other eligible issues after a contained failure", async () => {
    const seedIssues = [
      {
        id: "issue-1",
        key: "LIN-902",
        title: "First issue",
        description: "Fails.",
        acceptanceCriteria: [],
        status: "Todo",
        comments: [],
      },
      {
        id: "issue-2",
        key: "LIN-903",
        title: "Second issue",
        description: "Still runs.",
        acceptanceCriteria: [],
        status: "Todo",
        comments: [],
      },
    ];
    const tracker = createFakeIssueTrackerAdapter(seedIssues);
    const started: string[] = [];
    const events: string[] = [];

    await watchLoop({
      source: createFakeReadyIssueSource(seedIssues, "Todo"),
      tracker,
      claimStatus: "In Progress",
      pollIntervalMs: 1,
      maxPolls: 2,
      sleep: async () => {},
      onEvent: (event) => events.push(event.type),
      onClaimedIssue: async (issue) => {
        started.push(issue.key);
        if (issue.key === "LIN-902") throw new ClaimedRunFailure("workspace", "workspace stale");
      },
    });

    expect(started).toEqual(["LIN-902", "LIN-903"]);
    expect(events).toEqual([
      "poll_started",
      "issue_claimed",
      "claimed_issue_run_failed",
      "poll_started",
      "issue_claimed",
      "watch_stopped",
    ]);
    expect((await tracker.getIssue("LIN-902")).status).toBe("Todo");
    expect((await tracker.getIssue("LIN-903")).status).toBe("In Progress");
  });

  it("continues polling when Linear failure restoration fails", async () => {
    const seedIssues = [
      {
        id: "issue-1",
        key: "LIN-904",
        title: "Restore fails",
        description: "Failure handling must be guarded.",
        acceptanceCriteria: [],
        status: "Todo",
        comments: [],
      },
      {
        id: "issue-2",
        key: "LIN-905",
        title: "Next issue",
        description: "Still runs.",
        acceptanceCriteria: [],
        status: "Todo",
        comments: [],
      },
    ];
    const fakeTracker = createFakeIssueTrackerAdapter(seedIssues);
    const started: string[] = [];

    await watchLoop({
      source: createFakeReadyIssueSource(seedIssues, "Todo"),
      tracker: {
        getIssue: fakeTracker.getIssue,
        updateIssueStatus: async (issueKey, status) => {
          if (issueKey === "LIN-904" && status === "Todo") throw new Error("Linear unavailable");
          await fakeTracker.updateIssueStatus(issueKey, status);
        },
        appendIssueComment: async (issueKey, comment) => {
          if (comment.startsWith("Aigile run failed")) throw new Error("Linear unavailable");
          await fakeTracker.appendIssueComment(issueKey, comment);
        },
      },
      claimStatus: "In Progress",
      pollIntervalMs: 1,
      maxPolls: 2,
      sleep: async () => {},
      onClaimedIssue: async (issue) => {
        started.push(issue.key);
        if (issue.key === "LIN-904") throw new ClaimedRunFailure("publish", "publish failed");
      },
    });

    expect(started).toEqual(["LIN-904", "LIN-905"]);
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

  it("skips an issue whose Linear project matches more than one product route", () => {
    const routed = routeReadyIssuesForProducts(
      [
        {
          id: "issue-1",
          key: "LIN-901",
          title: "Ambiguous product issue",
          description: "",
          acceptanceCriteria: [],
          status: "ready",
          project: { id: "shared-project", name: "Shared" },
          comments: [],
        },
      ],
      [
        { productId: "one", linearProject: "Shared", githubRepo: "lbelyaev/one" },
        { productId: "two", linearProject: "Shared", githubRepo: "lbelyaev/two" },
      ],
    );

    expect(routed.readyIssues).toEqual([]);
    expect(routed.skippedIssues).toMatchObject([
      { issueKey: "LIN-901", reason: "project_ambiguous" },
    ]);
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

  it("resumes interrupted runs each poll before claiming new work", async () => {
    const resumed: string[] = [];
    const events: WatchLoopEvent[] = [];

    await watchLoop({
      source: createFakeReadyIssueSource([]),
      tracker: createFakeIssueTrackerAdapter([]),
      pollIntervalMs: 1,
      maxPolls: 1,
      sleep: async () => {},
      resume: {
        listResumable: async () => ["LIN-7"],
        resumeRun: async (issueId) => {
          resumed.push(issueId);
          return { outcome: "merged" };
        },
      },
      onEvent: (event) => events.push(event),
    });

    expect(resumed).toEqual(["LIN-7"]);
    expect(events).toContainEqual({
      type: "run_resumed",
      poll: 1,
      issueId: "LIN-7",
      outcome: "merged",
    });
  });

  it("keeps polling when a resume fails", async () => {
    const events: WatchLoopEvent[] = [];
    await watchLoop({
      source: createFakeReadyIssueSource([]),
      tracker: createFakeIssueTrackerAdapter([]),
      pollIntervalMs: 1,
      maxPolls: 1,
      sleep: async () => {},
      resume: {
        listResumable: async () => ["LIN-7"],
        resumeRun: async () => {
          throw new Error("worktree gone");
        },
      },
      onEvent: (event) => events.push(event),
    });

    expect(events.some((e) => e.type === "run_resume_failed")).toBe(true);
    expect(events.some((e) => e.type === "watch_stopped")).toBe(true);
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
