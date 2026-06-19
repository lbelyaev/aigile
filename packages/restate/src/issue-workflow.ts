import { initialWorkflowSnapshot, type WorkflowCommand } from "@aigile/workflow";
import type { DurableStepContext, ExecuteWorkflowEventsResult } from "./fsm-executor.js";
import { executeWorkflowEventsWithDurableSteps } from "./fsm-executor.js";

export interface WorkflowRunContext extends DurableStepContext {
  promise: <T>(name: string) => Promise<T>;
}

export interface WorkflowApprovalSignalContext {
  promise: <T>(name: string) => {
    resolve: (value: T) => Promise<void>;
  };
}

export interface IssueWorkflowRunInput {
  issueId: string;
  planArtifactId: string;
}

export interface PlanApprovalInput {
  approved: boolean;
}

export interface IssueWorkflowHandlers<TResult = unknown> {
  run: (
    ctx: WorkflowRunContext,
    input: IssueWorkflowRunInput,
  ) => Promise<ExecuteWorkflowEventsResult<TResult>>;
  approvePlan: (ctx: WorkflowApprovalSignalContext, input: PlanApprovalInput) => Promise<void>;
}

export interface IssueWorkflowHandlerOptions<TResult = unknown> {
  executeCommand: (command: WorkflowCommand) => Promise<TResult> | TResult;
}

export const createIssueWorkflowHandlers = <TResult = unknown>(
  options: IssueWorkflowHandlerOptions<TResult>,
): IssueWorkflowHandlers<TResult> => ({
  run: async (ctx, input) => {
    const beforeApproval = await executeWorkflowEventsWithDurableSteps({
      initialSnapshot: initialWorkflowSnapshot(input.issueId),
      events: [
        { type: "issue_received", issueId: input.issueId },
        { type: "plan_drafted", issueId: input.issueId, artifactId: input.planArtifactId },
      ],
      ctx,
      executeCommand: options.executeCommand,
    });

    const approved = await ctx.promise<boolean>("plan-approval");
    const approvalEvent = approved ? "plan_approved" : "plan_rejected";
    const afterApproval = await executeWorkflowEventsWithDurableSteps({
      initialSnapshot: beforeApproval.snapshot,
      events: [{ type: approvalEvent, issueId: input.issueId }],
      ctx,
      executeCommand: options.executeCommand,
    });

    return {
      snapshot: afterApproval.snapshot,
      commandResults: [...beforeApproval.commandResults, ...afterApproval.commandResults],
    };
  },
  approvePlan: async (ctx, input) => {
    await ctx.promise<boolean>("plan-approval").resolve(input.approved);
  },
});
