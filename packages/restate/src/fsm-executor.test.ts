import { describe, expect, it } from "bun:test";
import { executeWorkflowEventsWithDurableSteps } from "./index.js";
import { initialWorkflowSnapshot } from "@aigile/workflow";

describe("Restate-compatible FSM executor", () => {
  it("replays events and executes emitted commands through ctx.run steps", async () => {
    const durableSteps: string[] = [];
    const result = await executeWorkflowEventsWithDurableSteps({
      initialSnapshot: initialWorkflowSnapshot("LIN-123"),
      events: [
        { type: "issue_received", issueId: "LIN-123" },
        { type: "plan_drafted", issueId: "LIN-123", artifactId: "plan-1" },
        { type: "plan_approved", issueId: "LIN-123" },
      ],
      ctx: {
        run: async (name, fn) => {
          durableSteps.push(name);
          return fn();
        },
      },
      executeCommand: async (command) => ({ executed: command.type }),
    });

    expect(result.snapshot.state).toBe("developing");
    expect(durableSteps).toEqual([
      "start_architect_plan",
      "request_plan_approval",
      "start_developer_attempt",
    ]);
    expect(result.commandResults).toEqual([
      { executed: "start_architect_plan" },
      { executed: "request_plan_approval" },
      { executed: "start_developer_attempt" },
    ]);
  });
});
