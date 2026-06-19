import { describe, expect, it } from "bun:test";
import { createIssueWorkflowHandlers, type WorkflowApprovalSignalContext } from "./index.js";

describe("issue workflow handlers", () => {
  it("waits for durable plan approval before continuing", async () => {
    let approvalResolver: ((value: boolean) => void) | undefined;
    const steps: string[] = [];
    const workflow = createIssueWorkflowHandlers({
      executeCommand: async (command) => ({ command: command.type }),
    });

    const runPromise = workflow.run({
      run: async (name, fn) => {
        steps.push(name);
        return fn();
      },
      promise: async (name) => {
        expect(name).toBe("plan-approval");
        return new Promise<boolean>((resolve) => {
          approvalResolver = resolve;
        }) as Promise<never>;
      },
    }, {
      issueId: "LIN-123",
      planArtifactId: "plan-1",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(steps).toEqual(["start_architect_plan", "request_plan_approval"]);
    approvalResolver?.(true);

    await expect(runPromise).resolves.toMatchObject({
      snapshot: {
        issueId: "LIN-123",
        state: "developing",
      },
    });
    expect(steps).toEqual([
      "start_architect_plan",
      "request_plan_approval",
      "start_developer_attempt",
    ]);
  });

  it("resolves approval through a shared workflow handler", async () => {
    const resolutions: unknown[] = [];
    const workflow = createIssueWorkflowHandlers({
      executeCommand: async () => undefined,
    });
    const ctx: WorkflowApprovalSignalContext = {
      promise: (name) => {
        expect(name).toBe("plan-approval");
        return {
          resolve: async (value) => {
            resolutions.push(value);
          },
        };
      },
    };

    await workflow.approvePlan(ctx, { approved: true });

    expect(resolutions).toEqual([true]);
  });
});
