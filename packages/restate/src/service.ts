import * as restate from "@restatedev/restate-sdk";
import type { WorkflowCommand } from "@aigile/workflow";
import { createIssueWorkflowHandlers } from "./issue-workflow.js";

export interface RestateWorkflowDefinition {
  name: string;
  handlers: Record<string, unknown>;
}

export interface RestateWorkflowApi<TService = unknown> {
  workflow: (definition: RestateWorkflowDefinition) => TService;
}

export interface RestateIssueWorkflowServiceOptions<TResult = unknown, TService = unknown> {
  executeCommand: (command: WorkflowCommand) => Promise<TResult> | TResult;
  restate?: RestateWorkflowApi<TService>;
}

export const createRestateIssueWorkflowService = <TResult = unknown, TService = unknown>(
  options: RestateIssueWorkflowServiceOptions<TResult, TService>,
): TService => {
  const api = options.restate ?? (restate as unknown as RestateWorkflowApi<TService>);
  const handlers = createIssueWorkflowHandlers({ executeCommand: options.executeCommand });

  return api.workflow({
    name: "AigileIssueWorkflow",
    handlers: {
      run: handlers.run,
      approvePlan: handlers.approvePlan,
    },
  });
};

export const createRestateServeOptions = <TService>(
  service: TService,
): { services: TService[] } => ({
  services: [service],
});
