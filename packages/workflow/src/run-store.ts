import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkflowArtifact, WorkflowEvent } from "@aigile/types";

/**
 * A persisted, event-sourced workflow run: the ordered event log plus the
 * artifacts produced along the way. The current snapshot is always derivable by
 * replaying `events` through `replayWorkflow`, so the log is the source of truth.
 */
export interface PersistedRun {
  issueId: string;
  events: WorkflowEvent[];
  artifacts: WorkflowArtifact[];
}

export interface RunStore {
  load(issueId: string): Promise<PersistedRun | undefined>;
  deleteRun(issueId: string): Promise<void>;
  appendEvent(
    issueId: string,
    event: WorkflowEvent,
    artifacts?: readonly WorkflowArtifact[],
  ): Promise<void>;
  // Issue ids of all persisted runs, so interrupted runs can be discovered and resumed.
  list(): Promise<string[]>;
}

const mergeArtifacts = (
  existing: readonly WorkflowArtifact[],
  incoming: readonly WorkflowArtifact[],
): WorkflowArtifact[] => {
  const byId = new Map(existing.map((artifact) => [artifact.id, artifact]));
  for (const artifact of incoming) {
    if (!byId.has(artifact.id)) byId.set(artifact.id, structuredClone(artifact));
  }
  return [...byId.values()];
};

export const createInMemoryRunStore = (): RunStore => {
  const runs = new Map<string, PersistedRun>();
  return {
    load: async (issueId) => {
      const run = runs.get(issueId);
      return run === undefined ? undefined : structuredClone(run);
    },
    deleteRun: async (issueId) => {
      runs.delete(issueId);
    },
    appendEvent: async (issueId, event, artifacts = []) => {
      const existing = runs.get(issueId) ?? { issueId, events: [], artifacts: [] };
      runs.set(issueId, {
        issueId,
        events: [...existing.events, structuredClone(event)],
        artifacts: mergeArtifacts(existing.artifacts, artifacts),
      });
    },
    list: async () => [...runs.keys()],
  };
};

const runFileSlug = (issueId: string): string =>
  issueId.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "run";

/**
 * A durable RunStore backed by one JSON file per run under `directory`. The file
 * is the persisted event log, so a fresh process (or store instance) over the
 * same directory reconstructs the run by loading and replaying it.
 */
export const createFileRunStore = (options: { directory: string }): RunStore => {
  const fileFor = (issueId: string): string =>
    join(options.directory, `${runFileSlug(issueId)}.json`);

  const readRun = async (issueId: string): Promise<PersistedRun | undefined> => {
    try {
      return JSON.parse(await readFile(fileFor(issueId), "utf8")) as PersistedRun;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };

  return {
    load: readRun,
    deleteRun: async (issueId) => {
      await rm(fileFor(issueId), { force: true });
    },
    appendEvent: async (issueId, event, artifacts = []) => {
      const existing = (await readRun(issueId)) ?? { issueId, events: [], artifacts: [] };
      const next: PersistedRun = {
        issueId,
        events: [...existing.events, event],
        artifacts: mergeArtifacts(existing.artifacts, artifacts),
      };
      await mkdir(options.directory, { recursive: true });
      await writeFile(fileFor(issueId), `${JSON.stringify(next, null, 2)}\n`);
    },
    list: async () => {
      let entries: string[];
      try {
        entries = await readdir(options.directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const issueIds: string[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        try {
          const run = JSON.parse(
            await readFile(join(options.directory, entry), "utf8"),
          ) as PersistedRun;
          if (typeof run.issueId === "string" && run.issueId.length > 0) issueIds.push(run.issueId);
        } catch {
          // Skip unreadable/corrupt run files rather than failing enumeration.
        }
      }
      return issueIds;
    },
  };
};
