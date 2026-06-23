import { describe, expect, it } from "bun:test";
import type { IssueTrackerAdapter } from "@aigile/adapters";
import { syncIssueStatusForState } from "./status-sync.js";

const trackerThatRejectsStatus = (): IssueTrackerAdapter => ({
  getIssue: async () => {
    throw new Error("getIssue should not be called");
  },
  // Real Linear rejects a label with no matching workflow state.
  updateIssueStatus: async (_key, status) => {
    throw new Error(`Linear workflow state not found for team LBE: ${status}`);
  },
  appendIssueComment: async () => undefined,
});

describe("syncIssueStatusForState", () => {
  it("does not throw when the tracker rejects an unresolvable status label", async () => {
    const errors: Array<{ state: string; status: string; message: string }> = [];

    await expect(
      syncIssueStatusForState({
        issueTracker: trackerThatRejectsStatus(),
        issueKey: "LBE-99",
        state: "escalated",
        issueStatusLabels: { blocked: "Blocked" }, // not a real state on the team
        onError: (error, state, status) =>
          errors.push({
            state,
            status,
            message: error instanceof Error ? error.message : String(error),
          }),
      }),
    ).resolves.toBeUndefined();

    expect(errors).toEqual([
      { state: "escalated", status: "Blocked", message: expect.stringContaining("Blocked") },
    ]);
  });

  it("is a no-op when no tracker is provided", async () => {
    await expect(
      syncIssueStatusForState({ issueKey: "LBE-99", state: "merged" }),
    ).resolves.toBeUndefined();
  });
});
