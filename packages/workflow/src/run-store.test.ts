import { describe, expect, it } from "bun:test";
import type { WorkflowArtifact, WorkflowEvent } from "@aigile/types";
import { createInMemoryRunStore } from "./run-store.js";

const event = (type: WorkflowEvent["type"], artifactId?: string): WorkflowEvent =>
  artifactId === undefined ? { type, issueId: "LIN-1" } : { type, issueId: "LIN-1", artifactId };

const eventFor = (issueId: string, type: WorkflowEvent["type"]): WorkflowEvent => ({
  type,
  issueId,
});

const artifact = (id: string): WorkflowArtifact => ({
  id,
  kind: "architect.plan",
  source: "agent",
  payload: { summary: id },
});

describe("in-memory run store", () => {
  it("returns undefined for an unknown run", async () => {
    const store = createInMemoryRunStore();
    expect(await store.load("LIN-1")).toBeUndefined();
  });

  it("persists and replays appended events and artifacts in order", async () => {
    const store = createInMemoryRunStore();
    await store.appendEvent("LIN-1", event("issue_received"));
    await store.appendEvent("LIN-1", event("plan_drafted", "a1"), [artifact("a1")]);

    const run = await store.load("LIN-1");
    expect(run?.issueId).toBe("LIN-1");
    expect(run?.events.map((entry) => entry.type)).toEqual(["issue_received", "plan_drafted"]);
    expect(run?.artifacts.map((entry) => entry.id)).toEqual(["a1"]);
  });

  it("dedupes artifacts by id so a re-appended artifact stays unique", async () => {
    const store = createInMemoryRunStore();
    await store.appendEvent("LIN-1", event("plan_drafted", "a1"), [artifact("a1")]);
    await store.appendEvent("LIN-1", event("developer_finished", "a1"), [artifact("a1")]);

    const run = await store.load("LIN-1");
    expect(run?.artifacts.map((entry) => entry.id)).toEqual(["a1"]);
    expect(run?.events).toHaveLength(2);
  });

  it("checkpoints artifacts without appending a workflow event", async () => {
    const store = createInMemoryRunStore();
    await store.appendEvent("LIN-1", event("issue_received"));
    await store.appendArtifacts("LIN-1", [artifact("checkpoint-1")]);

    const run = await store.load("LIN-1");
    expect(run?.events.map((entry) => entry.type)).toEqual(["issue_received"]);
    expect(run?.artifacts.map((entry) => entry.id)).toEqual(["checkpoint-1"]);
  });

  it("isolates stored data from later mutation of inputs and reads", async () => {
    const store = createInMemoryRunStore();
    const stored = artifact("a1");
    await store.appendEvent("LIN-1", event("plan_drafted", "a1"), [stored]);
    (stored.payload as { summary: string }).summary = "mutated-after-append";

    const run = await store.load("LIN-1");
    run?.events.push(event("plan_rejected"));

    const reread = await store.load("LIN-1");
    expect((reread?.artifacts[0]?.payload as { summary: string }).summary).toBe("a1");
    expect(reread?.events).toHaveLength(1);
  });

  it("lists the issue ids of all persisted runs", async () => {
    const store = createInMemoryRunStore();
    expect(await store.list()).toEqual([]);
    await store.appendEvent("LIN-1", eventFor("LIN-1", "issue_received"));
    await store.appendEvent("LIN-2", eventFor("LIN-2", "issue_received"));
    expect((await store.list()).sort()).toEqual(["LIN-1", "LIN-2"]);
  });

  it("deletes a persisted run", async () => {
    const store = createInMemoryRunStore();
    await store.appendEvent("LIN-1", eventFor("LIN-1", "issue_received"));

    await store.deleteRun("LIN-1");

    expect(await store.load("LIN-1")).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });
});
