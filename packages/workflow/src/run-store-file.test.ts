import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowArtifact, WorkflowEvent } from "@aigile/types";
import { createFileRunStore } from "./run-store.js";

const ev = (type: WorkflowEvent["type"], artifactId?: string): WorkflowEvent =>
  artifactId === undefined ? { type, issueId: "LIN-1" } : { type, issueId: "LIN-1", artifactId };

const art = (id: string): WorkflowArtifact => ({
  id,
  kind: "architect.plan",
  source: "agent",
  payload: { summary: id },
});

const tempDirs: string[] = [];
const makeDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "aigile-run-store-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("file run store", () => {
  it("returns undefined for an unknown run", async () => {
    const store = createFileRunStore({ directory: await makeDir() });
    expect(await store.load("LIN-1")).toBeUndefined();
  });

  it("persists across store instances over the same directory", async () => {
    const directory = await makeDir();
    const writer = createFileRunStore({ directory });
    await writer.appendEvent("LIN-1", ev("issue_received"));
    await writer.appendEvent("LIN-1", ev("plan_drafted", "a1"), [art("a1")]);

    // A fresh instance over the same directory simulates a new process.
    const reader = createFileRunStore({ directory });
    const run = await reader.load("LIN-1");
    expect(run?.events.map((entry) => entry.type)).toEqual(["issue_received", "plan_drafted"]);
    expect(run?.artifacts.map((entry) => entry.id)).toEqual(["a1"]);
  });

  it("dedupes artifacts by id across appends", async () => {
    const store = createFileRunStore({ directory: await makeDir() });
    await store.appendEvent("LIN-1", ev("plan_drafted", "a1"), [art("a1")]);
    await store.appendEvent("LIN-1", ev("developer_finished", "a1"), [art("a1")]);
    const run = await store.load("LIN-1");
    expect(run?.artifacts.map((entry) => entry.id)).toEqual(["a1"]);
    expect(run?.events).toHaveLength(2);
  });

  it("persists checkpointed artifacts without appending events", async () => {
    const directory = await makeDir();
    const writer = createFileRunStore({ directory });
    await writer.appendEvent("LIN-1", ev("issue_received"));
    await writer.appendArtifacts("LIN-1", [art("checkpoint-1")]);

    const reader = createFileRunStore({ directory });
    const run = await reader.load("LIN-1");
    expect(run?.events.map((entry) => entry.type)).toEqual(["issue_received"]);
    expect(run?.artifacts.map((entry) => entry.id)).toEqual(["checkpoint-1"]);
  });

  it("lists persisted run issue ids (empty for a missing directory)", async () => {
    const directory = join(await makeDir(), "nested-runs");
    const store = createFileRunStore({ directory });
    expect(await store.list()).toEqual([]); // directory does not exist yet

    await store.appendEvent("LIN-1", { type: "issue_received", issueId: "LIN-1" });
    await store.appendEvent("LIN-2", { type: "issue_received", issueId: "LIN-2" });
    expect((await store.list()).sort()).toEqual(["LIN-1", "LIN-2"]);
  });

  it("deletes a persisted run file", async () => {
    const store = createFileRunStore({ directory: await makeDir() });
    await store.appendEvent("LIN-1", ev("issue_received"));

    await store.deleteRun("LIN-1");

    expect(await store.load("LIN-1")).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });
});
