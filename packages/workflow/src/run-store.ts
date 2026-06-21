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
  appendEvent(
    issueId: string,
    event: WorkflowEvent,
    artifacts?: readonly WorkflowArtifact[],
  ): Promise<void>;
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
    appendEvent: async (issueId, event, artifacts = []) => {
      const existing = runs.get(issueId) ?? { issueId, events: [], artifacts: [] };
      runs.set(issueId, {
        issueId,
        events: [...existing.events, structuredClone(event)],
        artifacts: mergeArtifacts(existing.artifacts, artifacts),
      });
    },
  };
};
