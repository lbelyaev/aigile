import { describe, expect, it } from "bun:test";
import {
  buildAcpRuntimeConnectInput,
  createAcpRoleRunner,
  type AcpRuntimeConnector,
} from "./index.js";

describe("ACP role runner", () => {
  it("emits progress while connecting, prompting, streaming, and stopping", async () => {
    const progress: string[] = [];
    let eventHandler: ((event: { type: "text_delta"; sessionId: string; delta: string }) => void) | undefined;
    const connector: AcpRuntimeConnector = async () => ({
      session: {
        sessionId: "role-session-1",
        acpSessionId: "acp-session-1",
        prompt: async () => {
          eventHandler?.({ type: "text_delta", sessionId: "role-session-1", delta: "working" });
          return {
            artifactKind: "architect.plan",
            payload: {
              summary: "Plan from ACP",
              scope: ["role runner"],
              acceptanceCriteria: ["artifact is parsed"],
              verificationCommands: ["bun run check"],
              risks: [],
            },
          };
        },
        cancel: () => undefined,
        onEvent: (handler) => {
          eventHandler = handler as typeof eventHandler;
          return () => {
            eventHandler = undefined;
          };
        },
      },
      process: {
        kill: async () => undefined,
      },
    });
    const runner = createAcpRoleRunner({
      connector,
      onProgress: (event) => progress.push(event.type),
    });

    await runner.run({
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
      },
      inputArtifacts: [],
    });

    expect(progress).toEqual([
      "role_started",
      "runtime_connecting",
      "runtime_connected",
      "prompt_started",
      "text_delta",
      "artifact_parsed",
      "runtime_stopped",
    ]);
  });

  it("builds ACP-standard initialize and session params for stdio runtimes", () => {
    const connectInput = buildAcpRuntimeConnectInput({
      roleId: "architect",
      issueId: "LIN-123",
      runtime: {
        id: "runtime-architect",
        transport: "stdio",
        command: ["agent-acp"],
        cwd: "/repo/aigile",
      },
      assignment: {
        roleId: "architect",
        runtimeProfileId: "runtime-architect",
      },
      inputArtifacts: [],
    });

    expect(connectInput).toMatchObject({
      command: ["agent-acp"],
      cwd: "/repo/aigile",
      sessionId: "LIN-123:architect",
      initializeParams: {
        protocolVersion: 1,
        clientCapabilities: {},
      },
      sessionParams: {
        cwd: "/repo/aigile",
        mcpServers: [],
      },
    });
    expect(connectInput.sessionParams).not.toHaveProperty("model");
  });

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
            payload: {
              summary: "Plan from ACP",
              scope: ["role runner"],
              acceptanceCriteria: ["artifact is parsed"],
              verificationCommands: ["bun run check"],
              risks: [],
            },
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
      payload: {
        summary: "Plan from ACP",
        scope: ["role runner"],
        acceptanceCriteria: ["artifact is parsed"],
        verificationCommands: ["bun run check"],
        risks: [],
      },
    });
    expect(killed).toBe(true);
  });

  it("parses artifact JSON from streamed ACP text events", async () => {
    let eventHandler: ((event: { type: "text_delta"; sessionId: string; delta: string }) => void) | undefined;
    const connector: AcpRuntimeConnector = async () => ({
      session: {
        sessionId: "role-session-1",
        acpSessionId: "acp-session-1",
        prompt: async () => {
          eventHandler?.({
            type: "text_delta",
            sessionId: "role-session-1",
            delta: JSON.stringify({
              artifactKind: "checker.verdict",
              payload: {
                verdict: "pass",
                summary: "Streamed verdict",
                reasons: [],
              },
            }),
          });
          return undefined;
        },
        cancel: () => undefined,
        onEvent: (handler) => {
          eventHandler = handler as typeof eventHandler;
          return () => {
            eventHandler = undefined;
          };
        },
      },
      process: {
        kill: async () => undefined,
      },
    });
    const runner = createAcpRoleRunner({ connector });

    const artifact = await runner.run({
      roleId: "checker",
      issueId: "LIN-123",
      runtime: {
        id: "runtime-checker",
        transport: "stdio",
        command: ["agent-acp"],
      },
      assignment: {
        roleId: "checker",
        runtimeProfileId: "runtime-checker",
      },
      inputArtifacts: [],
    });

    expect(artifact).toEqual({
      id: "agent:LIN-123:checker:checker.verdict",
      kind: "checker.verdict",
      source: "agent",
      producerRoleId: "checker",
      payload: {
        verdict: "pass",
        summary: "Streamed verdict",
        reasons: [],
      },
    });
  });

  it("falls back to streamed artifact JSON when prompt result is not an artifact", async () => {
    let eventHandler: ((event: { type: "text_delta"; sessionId: string; delta: string }) => void) | undefined;
    const connector: AcpRuntimeConnector = async () => ({
      session: {
        sessionId: "role-session-1",
        acpSessionId: "acp-session-1",
        prompt: async () => {
          eventHandler?.({
            type: "text_delta",
            sessionId: "role-session-1",
            delta: JSON.stringify({
              artifactKind: "architect.plan",
              payload: {
                summary: "Streamed plan",
                scope: ["fallback"],
                acceptanceCriteria: ["stream is parsed"],
                verificationCommands: ["bun test packages/roles"],
                risks: [],
              },
            }),
          });
          return { stopReason: "end_turn" };
        },
        cancel: () => undefined,
        onEvent: (handler) => {
          eventHandler = handler as typeof eventHandler;
          return () => {
            eventHandler = undefined;
          };
        },
      },
      process: {
        kill: async () => undefined,
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
      },
      inputArtifacts: [],
    });

    expect(artifact.payload).toMatchObject({ summary: "Streamed plan" });
  });
});
