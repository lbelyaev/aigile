import { describe, expect, it } from "bun:test";
import { createFakeIssueTrackerAdapter } from "@aigile/adapters";
import { syncIssueStatusForState } from "./status-sync.js";

describe("syncIssueStatusForState", () => {
  it("does not throw when the tracker rejects an unresolvable status label", async () => {
    const errors: Array<{ state: string; status: string; message: string }> = [];
    const issueTracker = createFakeIssueTrackerAdapter(
      [
        {
          id: "issue-1",
          key: "LBE-99",
          title: "Sync status",
          description: "",
          acceptanceCriteria: [],
          status: "Todo",
          comments: [],
        },
      ],
      { validStatusLabels: ["In Progress", "Done"] },
    );

    await expect(
      syncIssueStatusForState({
        issueTracker,
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
