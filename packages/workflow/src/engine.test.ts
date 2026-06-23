import { afterEach, describe, expect, it } from "bun:test";
import type { WorkflowArtifact, WorkflowEvent, WorkflowState } from "@aigile/types";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listResumableRuns,
  runWorkflowEngine,
  type WorkflowCommandHandler,
  type WorkflowCommandHandlers,
} from "./engine.js";
import { createFileRunStore, createInMemoryRunStore } from "./run-store.js";

const ev = (type: WorkflowEvent["type"], artifactId?: string): WorkflowEvent =>
  artifactId === undefined ? { type, issueId: "LIN-1" } : { type, issueId: "LIN-1", artifactId };

const art = (id: string, kind: string): WorkflowArtifact => ({
  id,
  kind,
  source: "agent",
  payload: {},
});

// A happy-path handler set; individual tests override the verification handler.
const baseHandlers = (verify: WorkflowCommandHandler): WorkflowCommandHandlers => ({
  start_architect_plan: async () => ({
    event: ev("plan_drafted", "plan"),
    artifact: art("plan", "architect.plan"),
  }),
  request_plan_approval: async () => ({ event: ev("plan_approved") }),
  start_developer_attempt: async ({ snapshot }) => ({
    event: ev("developer_finished", `dev-${snapshot.developerAttempts}`),
    artifact: art(`dev-${snapshot.developerAttempts}`, "developer.attempt"),
  }),
  run_verification: verify,
  start_checker_review: async () => ({ event: ev("checker_passed") }),
  merge_pull_request: async () => ({ event: ev("merge_completed") }),
});

describe("workflow engine", () => {
  it("drives a clean run from new to merged", async () => {
    const store = createInMemoryRunStore();
    const result = await runWorkflowEngine({
      issueId: "LIN-1",
      store,
      handlers: baseHandlers(async () => ({ event: ev("verification_passed") })),
    });

    expect(result.outcome).toBe("merged");
    expect(result.snapshot.state).toBe("merged");
    const persisted = await store.load("LIN-1");
    expect(persisted?.events[0]?.type).toBe("issue_received");
    expect(persisted?.events.at(-1)?.type).toBe("merge_completed");
  });

  it("dispatches the terminal command once before returning and skips it on terminal resume", async () => {
    const store = createInMemoryRunStore();
    const terminalCommands: string[] = [];
    const handlers = {
      ...baseHandlers(async () => ({ event: ev("verification_passed") })),
      sync_sources_of_truth: async ({ snapshot }) => {
        terminalCommands.push(snapshot.state);
        return {};
      },
    } satisfies WorkflowCommandHandlers;

    const first = await runWorkflowEngine({ issueId: "LIN-1", store, handlers });
    const second = await runWorkflowEngine({ issueId: "LIN-1", store, handlers });

    expect(first.outcome).toBe("merged");
    expect(second.outcome).toBe("merged");
    expect(terminalCommands).toEqual(["merged"]);
  });

  it("notifies on each state change including bootstrap and terminal states", async () => {
    const store = createInMemoryRunStore();
    const states: WorkflowState[] = [];

    const result = await runWorkflowEngine({
      issueId: "LIN-1",
      store,
      handlers: baseHandlers(async () => ({ event: ev("verification_passed") })),
      onStateChange: async ({ snapshot }) => {
        states.push(snapshot.state);
      },
    });

    expect(result.outcome).toBe("merged");
    expect(states).toEqual([
      "planning",
      "awaiting_plan_approval",
      "developing",
      "verifying",
      "checking",
      "merge_ready",
      "merged",
    ]);
  });

  it("keeps running when the state-change hook fails", async () => {
    const store = createInMemoryRunStore();
    const errors: string[] = [];

    const result = await runWorkflowEngine({
      issueId: "LIN-1",
      store,
      handlers: baseHandlers(async () => ({ event: ev("verification_passed") })),
      onStateChange: async () => {
        throw new Error("tracker unavailable");
      },
      onStateChangeError: async ({ error }) => {
        errors.push(error instanceof Error ? error.message : String(error));
      },
    });

    expect(result.outcome).toBe("merged");
    expect(errors).toContain("tracker unavailable");
  });

  it("retries development until verification passes, then merges", async () => {
    const store = createInMemoryRunStore();
    let verifyCalls = 0;
    const devAttempts: number[] = [];
    const handlers = baseHandlers(async () => {
      verifyCalls += 1;
      return { event: ev(verifyCalls < 3 ? "verification_failed" : "verification_passed") };
    });
    handlers.start_developer_attempt = async ({ snapshot }) => {
      devAttempts.push(snapshot.developerAttempts);
      return {
        event: ev("developer_finished", `dev-${snapshot.developerAttempts}`),
        artifact: art(`dev-${snapshot.developerAttempts}`, "developer.attempt"),
      };
    };

    const result = await runWorkflowEngine({ issueId: "LIN-1", store, handlers });

    expect(result.outcome).toBe("merged");
    expect(verifyCalls).toBe(3); // fail, fail, pass
    expect(devAttempts).toEqual([1, 2, 3]); // initial + two retries
  });

  it("keeps distinct artifact payloads across retries", async () => {
    const store = createInMemoryRunStore();
    let verifyCalls = 0;
    const handlers = baseHandlers(async () => {
      verifyCalls += 1;
      const passed = verifyCalls > 1;
      const artifactId = `verification-${verifyCalls}`;
      return {
        event: ev(passed ? "verification_passed" : "verification_failed", artifactId),
        artifact: {
          id: artifactId,
          kind: "verification.result",
          source: "verifier",
          payload: { status: passed ? "passed" : "failed" },
        },
      };
    });

    const result = await runWorkflowEngine({ issueId: "LIN-1", store, handlers });

    expect(result.outcome).toBe("merged");
    expect(
      result.artifacts
        .filter((artifact) => artifact.kind === "verification.result")
        .map((artifact) => artifact.payload),
    ).toEqual([{ status: "failed" }, { status: "passed" }]);
    expect(
      (await store.load("LIN-1"))?.artifacts
        .filter((artifact) => artifact.kind === "verification.result")
        .map((artifact) => artifact.payload),
    ).toEqual([{ status: "failed" }, { status: "passed" }]);
  });

  it("escalates after the developer-attempt budget is exhausted", async () => {
    const store = createInMemoryRunStore();
    let verifyCalls = 0;
    const states: WorkflowState[] = [];
    const handlers = baseHandlers(async () => {
      verifyCalls += 1;
      return { event: ev("verification_failed") };
    });

    const result = await runWorkflowEngine({
      issueId: "LIN-1",
      store,
      handlers,
      onStateChange: async ({ snapshot }) => {
        states.push(snapshot.state);
      },
    });

    expect(result.outcome).toBe("escalated");
    expect(result.snapshot.state).toBe("escalated");
    expect(verifyCalls).toBe(3); // three attempts then escalate (default maxDeveloperAttempts)
    expect(states.at(-1)).toBe("escalated");
  });

  it("respects a custom developer-attempt budget", async () => {
    const store = createInMemoryRunStore();
    let verifyCalls = 0;
    const handlers = baseHandlers(async () => {
      verifyCalls += 1;
      return { event: ev("verification_failed") };
    });

    const result = await runWorkflowEngine({
      issueId: "LIN-1",
      store,
      handlers,
      policy: { maxDeveloperAttempts: 1 },
    });

    expect(result.outcome).toBe("escalated");
    expect(verifyCalls).toBe(1);
  });

  it("stalls (without throwing) when a required command has no handler", async () => {
    const store = createInMemoryRunStore();
    const result = await runWorkflowEngine({ issueId: "LIN-1", store, handlers: {} });

    expect(result.outcome).toBe("stalled");
    expect(result.snapshot.state).toBe("planning"); // bootstrapped, then no architect handler
  });

  it("reaches the satisfied terminal when the checker reports work already satisfied", async () => {
    const store = createInMemoryRunStore();
    const handlers = baseHandlers(async () => ({ event: ev("verification_passed") }));
    handlers.start_checker_review = async () => ({ event: ev("work_satisfied") });

    const result = await runWorkflowEngine({ issueId: "LIN-1", store, handlers });
    expect(result.outcome).toBe("satisfied");
    expect(result.snapshot.state).toBe("satisfied");
  });

  it("retries development when the checker requests changes, then merges", async () => {
    const store = createInMemoryRunStore();
    let checkerCalls = 0;
    const devAttempts: number[] = [];
    const handlers = baseHandlers(async () => ({ event: ev("verification_passed") }));
    handlers.start_developer_attempt = async ({ snapshot }) => {
      devAttempts.push(snapshot.developerAttempts);
      return {
        event: ev("developer_finished", `dev-${snapshot.developerAttempts}`),
        artifact: art(`dev-${snapshot.developerAttempts}`, "developer.attempt"),
      };
    };
    handlers.start_checker_review = async () => {
      checkerCalls += 1;
      return { event: ev(checkerCalls < 2 ? "checker_requested_changes" : "checker_passed") };
    };

    const result = await runWorkflowEngine({ issueId: "LIN-1", store, handlers });
    expect(result.outcome).toBe("merged");
    expect(checkerCalls).toBe(2);
    expect(devAttempts).toEqual([1, 2]);
  });

  it("escalates when the checker escalates", async () => {
    const store = createInMemoryRunStore();
    const handlers = baseHandlers(async () => ({ event: ev("verification_passed") }));
    handlers.start_checker_review = async () => ({ event: ev("checker_escalated") });

    const result = await runWorkflowEngine({ issueId: "LIN-1", store, handlers });
    expect(result.outcome).toBe("escalated");
  });

  it("escalates when publishing the pull request fails", async () => {
    const store = createInMemoryRunStore();
    const handlers = baseHandlers(async () => ({ event: ev("verification_passed") }));
    handlers.merge_pull_request = async () => ({ event: ev("publish_failed") });

    const result = await runWorkflowEngine({ issueId: "LIN-1", store, handlers });
    expect(result.outcome).toBe("escalated");
  });

  it("surfaces the escalation reason in the result", async () => {
    const store = createInMemoryRunStore();
    const handlers = baseHandlers(async () => ({
      event: { type: "verification_failed", issueId: "LIN-1", reason: "type errors in worktree" },
    }));

    const result = await runWorkflowEngine({
      issueId: "LIN-1",
      store,
      handlers,
      policy: { maxDeveloperAttempts: 1 },
    });
    expect(result.outcome).toBe("escalated");
    expect(result.reason).toBe("type errors in worktree");
  });

  it("pauses when a handler returns no event, and resumes on re-run", async () => {
    const store = createInMemoryRunStore();
    let prMerged = false;
    const handlers = baseHandlers(async () => ({ event: ev("verification_passed") }));
    // merge handler pauses (PR published, not merged yet) until the PR is merged.
    handlers.merge_pull_request = async () => (prMerged ? { event: ev("merge_completed") } : {});

    const first = await runWorkflowEngine({ issueId: "LIN-1", store, handlers });
    expect(first.outcome).toBe("paused");
    expect(first.snapshot.state).toBe("merge_ready");

    prMerged = true; // external merge happens
    const second = await runWorkflowEngine({ issueId: "LIN-1", store, handlers });
    expect(second.outcome).toBe("merged");
    expect(second.snapshot.state).toBe("merged");
  });
});

describe("workflow engine durable resume", () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("resumes from the persisted log after a crash without redoing completed phases", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aigile-engine-"));
    tempDirs.push(directory);

    let architectCalls = 0;
    const countingArchitect: WorkflowCommandHandler = async () => {
      architectCalls += 1;
      return { event: ev("plan_drafted", "plan"), artifact: art("plan", "architect.plan") };
    };

    // Run 1: the verification handler throws, simulating a crash mid-run.
    const crashing = baseHandlers(async () => {
      throw new Error("boom: process crashed during verification");
    });
    crashing.start_architect_plan = countingArchitect;
    await expect(
      runWorkflowEngine({
        issueId: "LIN-1",
        store: createFileRunStore({ directory }),
        handlers: crashing,
      }),
    ).rejects.toThrow("boom");

    // The log persisted up to the last completed step; no verification event.
    const afterCrash = await createFileRunStore({ directory }).load("LIN-1");
    expect(afterCrash?.events.map((entry) => entry.type)).toEqual([
      "issue_received",
      "plan_drafted",
      "plan_approved",
      "developer_finished",
    ]);

    // Run 2: a fresh store over the same directory resumes and completes.
    const healthy = baseHandlers(async () => ({ event: ev("verification_passed") }));
    healthy.start_architect_plan = countingArchitect;
    const result = await runWorkflowEngine({
      issueId: "LIN-1",
      store: createFileRunStore({ directory }),
      handlers: healthy,
    });

    expect(result.outcome).toBe("merged");
    expect(architectCalls).toBe(1); // architect ran once total — not re-run on resume
  });
});

describe("listResumableRuns", () => {
  it("returns only runs that have not reached a stop state", async () => {
    const store = createInMemoryRunStore();
    const seed = async (issueId: string, types: WorkflowEvent["type"][]) => {
      for (const type of types) await store.appendEvent(issueId, { type, issueId });
    };
    // Completed (merged) -> stop state -> excluded.
    await seed("DONE-1", [
      "issue_received",
      "plan_drafted",
      "plan_approved",
      "developer_finished",
      "verification_passed",
      "checker_passed",
      "merge_completed",
    ]);
    // Paused at merge_ready (no merge_completed yet) -> included.
    await seed("PAUSED-1", [
      "issue_received",
      "plan_drafted",
      "plan_approved",
      "developer_finished",
      "verification_passed",
      "checker_passed",
    ]);
    // Interrupted right after planning -> included.
    await seed("STALLED-1", ["issue_received"]);

    const resumable = (await listResumableRuns(store)).sort();
    expect(resumable).toEqual(["PAUSED-1", "STALLED-1"]);
  });
});
