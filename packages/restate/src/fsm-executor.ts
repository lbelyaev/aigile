import { transitionWorkflow, type WorkflowCommand, type WorkflowSnapshot } from "@aigile/workflow";
import type { WorkflowEvent } from "@aigile/types";

export interface DurableStepContext {
  run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T>;
}

export type ExecuteWorkflowCommand<TResult = unknown> = (
  command: WorkflowCommand,
) => Promise<TResult> | TResult;

export interface ExecuteWorkflowEventsInput<TResult = unknown> {
  initialSnapshot: WorkflowSnapshot;
  events: readonly WorkflowEvent[];
  ctx: DurableStepContext;
  executeCommand: ExecuteWorkflowCommand<TResult>;
}

export interface ExecuteWorkflowEventsResult<TResult = unknown> {
  snapshot: WorkflowSnapshot;
  commandResults: TResult[];
}

export const executeWorkflowEventsWithDurableSteps = async <TResult = unknown>(
  input: ExecuteWorkflowEventsInput<TResult>,
): Promise<ExecuteWorkflowEventsResult<TResult>> => {
  let snapshot = input.initialSnapshot;
  const commandResults: TResult[] = [];

  for (const event of input.events) {
    const transition = transitionWorkflow(snapshot, event);
    snapshot = transition.snapshot;

    for (const command of transition.commands) {
      commandResults.push(await input.ctx.run(command.type, () => input.executeCommand(command)));
    }
  }

  return { snapshot, commandResults };
};
