import { describe, expect, it } from "bun:test";
import { createRoleRuntimeRegistry, createScriptedRoleRunner, runAssignedRole } from "./index.js";

describe("role runner", () => {
  it("resolves role assignments to generic ACP runtime profiles", () => {
    const registry = createRoleRuntimeRegistry({
      runtimes: [
        {
          id: "runtime-architect",
          transport: "stdio",
          command: ["agent-acp", "--profile", "architect"],
        },
      ],
      assignments: [
        {
          roleId: "architect",
          runtimeProfileId: "runtime-architect",
          instructionRef: "roles/architect.md",
        },
      ],
    });

    expect(registry.getAssignment("architect")).toEqual({
      roleId: "architect",
      runtimeProfileId: "runtime-architect",
      instructionRef: "roles/architect.md",
    });
    expect(registry.getRuntimeForRole("architect")).toEqual({
      id: "runtime-architect",
      transport: "stdio",
      command: ["agent-acp", "--profile", "architect"],
    });
  });

  it("runs a scripted role and returns a workflow artifact", async () => {
    const registry = createRoleRuntimeRegistry({
      runtimes: [
        {
          id: "runtime-architect",
          transport: "stdio",
          command: ["agent-acp"],
        },
      ],
      assignments: [{ roleId: "architect", runtimeProfileId: "runtime-architect" }],
    });
    const runner = createScriptedRoleRunner({
      architect: {
        artifactKind: "architect.plan",
        payload: { summary: "Build the adapter" },
      },
    });

    const result = await runAssignedRole({
      roleId: "architect",
      issueId: "LIN-123",
      inputArtifacts: [],
      registry,
      runner,
    });

    expect(result).toEqual({
      id: "agent:LIN-123:architect:architect.plan",
      kind: "architect.plan",
      source: "agent",
      producerRoleId: "architect",
      payload: { summary: "Build the adapter" },
    });
  });

  it("fails clearly when a role is not assigned", () => {
    const registry = createRoleRuntimeRegistry({ runtimes: [], assignments: [] });

    expect(() => registry.getRuntimeForRole("checker")).toThrow(/no runtime assigned/i);
  });
});
