import { connectAcpRuntime, type AcpSession, type ConnectAcpRuntimeInput } from "@aigile/acp";
import type { WorkflowArtifact } from "@aigile/types";
import type { RoleRunner, RoleRunInput } from "./runner.js";

export interface AcpRuntimeConnection {
  session: Pick<AcpSession, "sessionId" | "acpSessionId" | "prompt" | "cancel" | "onEvent">;
  process: {
    kill: () => Promise<void>;
  };
}

export type AcpRuntimeConnector = (input: RoleRunInput) => Promise<AcpRuntimeConnection>;

export interface AcpRoleRunnerOptions {
  connector?: AcpRuntimeConnector;
}

interface AcpArtifactResponse {
  artifactKind: string;
  payload: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isAcpArtifactResponse = (value: unknown): value is AcpArtifactResponse =>
  isRecord(value)
  && typeof value.artifactKind === "string"
  && value.artifactKind.trim().length > 0
  && "payload" in value;

const parseAcpArtifactResponse = (value: unknown): AcpArtifactResponse => {
  if (isAcpArtifactResponse(value)) return value;
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    if (isAcpArtifactResponse(parsed)) return parsed;
  }
  throw new Error("ACP role response did not include artifactKind and payload");
};

const defaultConnector: AcpRuntimeConnector = async (input) => {
  if (input.runtime.transport !== "stdio" || !input.runtime.command) {
    throw new Error(`ACP role runner currently supports stdio command runtimes only: ${input.runtime.id}`);
  }

  const connectInput: ConnectAcpRuntimeInput = {
    command: input.runtime.command,
    sessionId: `${input.issueId}:${input.roleId}`,
    initializeParams: {
      client: "aigile",
      roleId: input.roleId,
    },
    sessionParams: {
      cwd: input.runtime.cwd ?? process.cwd(),
      mcpServers: [],
      model: input.runtime.defaultModel,
    },
  };
  if (input.runtime.cwd !== undefined) connectInput.cwd = input.runtime.cwd;
  if (input.runtime.env !== undefined) connectInput.env = input.runtime.env;

  const connected = await connectAcpRuntime(connectInput);

  return connected;
};

const buildPrompt = (input: RoleRunInput): string => [
  `Role: ${input.roleId}`,
  `Issue: ${input.issueId}`,
  input.assignment.instructionRef ? `Instruction ref: ${input.assignment.instructionRef}` : undefined,
  "",
  "Return only JSON with this shape:",
  "{\"artifactKind\":\"...\",\"payload\":{...}}",
  "",
  "Input artifacts:",
  JSON.stringify(input.inputArtifacts, null, 2),
].filter((line): line is string => line !== undefined).join("\n");

export const createAcpRoleRunner = (
  options: AcpRoleRunnerOptions = {},
): RoleRunner => {
  const connector = options.connector ?? defaultConnector;

  return {
    run: async (input) => {
      const connection = await connector(input);
      try {
        const response = parseAcpArtifactResponse(await connection.session.prompt(buildPrompt(input)));
        return {
          id: `agent:${input.issueId}:${input.roleId}:${response.artifactKind}`,
          kind: response.artifactKind,
          source: "agent",
          producerRoleId: input.roleId,
          payload: structuredClone(response.payload),
        } satisfies WorkflowArtifact;
      } finally {
        await connection.process.kill();
      }
    },
  };
};
