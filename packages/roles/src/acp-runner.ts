import { connectAcpRuntime, type AcpSession, type ConnectAcpRuntimeInput } from "@aigile/acp";
import { parseRoleArtifactResponse, type WorkflowArtifact } from "@aigile/types";
import type { RoleRunner, RoleRunInput } from "./runner.js";
import { buildRolePrompt, getDefaultRoleInstruction } from "./prompts.js";

export interface AcpRuntimeConnection {
  session: Pick<AcpSession, "sessionId" | "acpSessionId" | "prompt" | "cancel" | "onEvent">;
  process: {
    kill: () => Promise<void>;
  };
}

export type AcpRuntimeConnector = (input: RoleRunInput) => Promise<AcpRuntimeConnection>;

export type AcpRoleProgressEvent =
  | { type: "role_started"; roleId: string; issueId: string; runtimeId: string }
  | { type: "runtime_connecting"; roleId: string; issueId: string; runtimeId: string }
  | { type: "runtime_connected"; roleId: string; issueId: string; runtimeId: string; acpSessionId: string }
  | { type: "runtime_stderr"; roleId: string; issueId: string; runtimeId: string; chunk: string }
  | { type: "prompt_started"; roleId: string; issueId: string; runtimeId: string }
  | { type: "text_delta"; roleId: string; issueId: string; runtimeId: string; delta: string }
  | { type: "thinking_delta"; roleId: string; issueId: string; runtimeId: string; delta: string }
  | { type: "tool_start"; roleId: string; issueId: string; runtimeId: string; tool: string }
  | { type: "tool_end"; roleId: string; issueId: string; runtimeId: string; tool: string }
  | { type: "approval_request"; roleId: string; issueId: string; runtimeId: string; tool: string; description: string }
  | { type: "artifact_parsed"; roleId: string; issueId: string; runtimeId: string; artifactKind: string }
  | { type: "runtime_stopped"; roleId: string; issueId: string; runtimeId: string };

export interface AcpRoleRunnerOptions {
  connector?: AcpRuntimeConnector;
  onProgress?: (event: AcpRoleProgressEvent) => void;
}

export const buildAcpRuntimeConnectInput = (input: RoleRunInput): ConnectAcpRuntimeInput => {
  if (input.runtime.transport !== "stdio" || !input.runtime.command) {
    throw new Error(`ACP role runner currently supports stdio command runtimes only: ${input.runtime.id}`);
  }

  const connectInput: ConnectAcpRuntimeInput = {
    command: input.runtime.command,
    sessionId: `${input.issueId}:${input.roleId}`,
    initializeParams: {
      protocolVersion: 1,
      clientCapabilities: {},
    },
    sessionParams: {
      cwd: input.runtime.cwd ?? process.cwd(),
      mcpServers: [],
    },
  };
  if (input.runtime.defaultModel !== undefined) {
    connectInput.sessionParams.model = input.runtime.defaultModel;
  }
  if (input.runtime.cwd !== undefined) connectInput.cwd = input.runtime.cwd;
  if (input.runtime.env !== undefined) connectInput.env = input.runtime.env;

  return connectInput;
};

const defaultConnector: AcpRuntimeConnector = async (input) =>
  connectAcpRuntime(buildAcpRuntimeConnectInput(input));

const buildPrompt = (input: RoleRunInput): string => buildRolePrompt({
  roleId: input.roleId,
  issueId: input.issueId,
  instruction: [
    getDefaultRoleInstruction(input.roleId),
    input.assignment.instructionRef ? `Instruction reference: ${input.assignment.instructionRef}` : undefined,
  ].filter((line): line is string => line !== undefined).join("\n"),
  inputArtifacts: input.inputArtifacts,
});

const EXPECTED_ARTIFACT_KIND_BY_ROLE: Record<string, string> = {
  architect: "architect.plan",
  developer: "developer.attempt",
  checker: "checker.verdict",
};

const parsePromptArtifactResponse = (promptResult: unknown, streamedText: string) => {
  if (promptResult === undefined || promptResult === null) {
    return parseRoleArtifactResponse(streamedText);
  }
  try {
    return parseRoleArtifactResponse(promptResult);
  } catch (error) {
    if (streamedText.trim().length === 0) throw error;
    return parseRoleArtifactResponse(streamedText);
  }
};

const assertExpectedArtifactKind = (roleId: string, artifactKind: string): void => {
  const expected = EXPECTED_ARTIFACT_KIND_BY_ROLE[roleId];
  if (expected === undefined || artifactKind === expected) return;
  throw new Error(`Role "${roleId}" expected ${expected} but received ${artifactKind}`);
};

export const createAcpRoleRunner = (
  options: AcpRoleRunnerOptions = {},
): RoleRunner => {
  const progressBase = (input: RoleRunInput) => ({
    roleId: input.roleId,
    issueId: input.issueId,
    runtimeId: input.runtime.id,
  });
  const connector = options.connector ?? (async (input) => {
    const connectInput = buildAcpRuntimeConnectInput(input);
    connectInput.forwardStderr = (chunk) => options.onProgress?.({
      type: "runtime_stderr",
      ...progressBase(input),
      chunk,
    });
    return connectAcpRuntime(connectInput);
  });

  return {
    run: async (input) => {
      options.onProgress?.({ type: "role_started", ...progressBase(input) });
      options.onProgress?.({ type: "runtime_connecting", ...progressBase(input) });
      const connection = await connector(input);
      options.onProgress?.({
        type: "runtime_connected",
        ...progressBase(input),
        acpSessionId: connection.session.acpSessionId,
      });
      let streamedText = "";
      const unsubscribe = connection.session.onEvent((event) => {
        if (event.type === "text_delta") {
          streamedText += event.delta;
          options.onProgress?.({ type: "text_delta", ...progressBase(input), delta: event.delta });
          return;
        }
        if (event.type === "thinking_delta") {
          options.onProgress?.({ type: "thinking_delta", ...progressBase(input), delta: event.delta });
          return;
        }
        if (event.type === "tool_start") {
          options.onProgress?.({ type: "tool_start", ...progressBase(input), tool: event.tool });
          return;
        }
        if (event.type === "tool_end") {
          options.onProgress?.({ type: "tool_end", ...progressBase(input), tool: event.tool });
          return;
        }
        if (event.type === "approval_request") {
          options.onProgress?.({
            type: "approval_request",
            ...progressBase(input),
            tool: event.tool,
            description: event.description,
          });
        }
      });
      try {
        options.onProgress?.({ type: "prompt_started", ...progressBase(input) });
        const promptResult = await connection.session.prompt(buildPrompt(input));
        const response = parsePromptArtifactResponse(promptResult, streamedText);
        assertExpectedArtifactKind(input.roleId, response.artifactKind);
        options.onProgress?.({
          type: "artifact_parsed",
          ...progressBase(input),
          artifactKind: response.artifactKind,
        });
        return {
          id: `agent:${input.issueId}:${input.roleId}:${response.artifactKind}`,
          kind: response.artifactKind,
          source: "agent",
          producerRoleId: input.roleId,
          payload: structuredClone(response.payload),
        } satisfies WorkflowArtifact;
      } finally {
        unsubscribe();
        await connection.process.kill();
        options.onProgress?.({ type: "runtime_stopped", ...progressBase(input) });
      }
    },
  };
};
