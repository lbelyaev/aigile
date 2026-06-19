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

export interface AcpRoleRunnerOptions {
  connector?: AcpRuntimeConnector;
}

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

const buildPrompt = (input: RoleRunInput): string => buildRolePrompt({
  roleId: input.roleId,
  issueId: input.issueId,
  instruction: [
    getDefaultRoleInstruction(input.roleId),
    input.assignment.instructionRef ? `Instruction reference: ${input.assignment.instructionRef}` : undefined,
  ].filter((line): line is string => line !== undefined).join("\n"),
  inputArtifacts: input.inputArtifacts,
});

export const createAcpRoleRunner = (
  options: AcpRoleRunnerOptions = {},
): RoleRunner => {
  const connector = options.connector ?? defaultConnector;

  return {
    run: async (input) => {
      const connection = await connector(input);
      try {
        const response = parseRoleArtifactResponse(await connection.session.prompt(buildPrompt(input)));
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
