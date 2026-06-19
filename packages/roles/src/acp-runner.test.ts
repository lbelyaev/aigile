import { describe, expect, it } from "bun:test";
import { createAcpRoleRunner, type AcpRuntimeConnector } from "./index.js";

describe("ACP role runner", () => {
  it("runs a role through an ACP runtime and returns an artifact", async () => {
    const prompts: string[] = [];
    let killed = false;
    const connector: AcpRuntimeConnector = async () => ({
      session: {
        sessionId: "role-session-1",
        acpSessionId: "acp-session-1",
        prompt: async (text: string) => {
          prompts.push(text);
          return {
            artifactKind: "architect.plan",
            payload: { summary: "Plan from ACP" },
          };
        },
        cancel: () => undefined,
        onEvent: () => () => undefined,
      },
      process: {
        kill: async () => {
          killed = true;
        },
      },
    });
    const runner = createAcpRoleRunner({ connector });

    const artifact = await runner.run({
      roleId: "architect",
      issueId: "LIN-123",
      runtime: {
        id: "runtime-architect",
        transport: "stdio",
        command: ["agent-acp"],
      },
      assignment: {
        roleId: "architect",
        runtimeProfileId: "runtime-architect",
        instructionRef: "roles/architect.md",
      },
      inputArtifacts: [{
        id: "linear:LIN-123",
        kind: "linear.issue",
        source: "linear",
        payload: { title: "Build the runner" },
      }],
    });

    expect(prompts[0]).toContain("Role: architect");
    expect(prompts[0]).toContain("linear.issue");
    expect(artifact).toEqual({
      id: "agent:LIN-123:architect:architect.plan",
      kind: "architect.plan",
      source: "agent",
      producerRoleId: "architect",
      payload: { summary: "Plan from ACP" },
    });
    expect(killed).toBe(true);
  });
});
