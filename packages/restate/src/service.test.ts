import { describe, expect, it } from "bun:test";
import { createRestateIssueWorkflowService, createRestateServeOptions } from "./index.js";

describe("Restate service scaffold", () => {
  it("builds an issue workflow service with run and approvePlan handlers", () => {
    const workflowCalls: unknown[] = [];
    const service = createRestateIssueWorkflowService({
      executeCommand: async () => undefined,
      restate: {
        workflow: (definition) => {
          workflowCalls.push(definition);
          return { service: definition.name, handlers: Object.keys(definition.handlers) };
        },
      },
    });

    expect(service).toEqual({
      service: "AigileIssueWorkflow",
      handlers: ["run", "approvePlan"],
    });
    expect(workflowCalls).toHaveLength(1);
  });

  it("creates Restate serve options with the issue workflow service", () => {
    const service = { service: "AigileIssueWorkflow" };
    expect(createRestateServeOptions(service)).toEqual({
      services: [service],
    });
  });
});
