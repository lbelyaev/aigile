import type { AcpRuntimeProfile, RoleAssignment, WorkflowArtifact } from "@aigile/types";
import { isAcpRuntimeProfile, isRoleAssignment } from "@aigile/types";

export interface RoleRuntimeRegistryConfig {
  runtimes: readonly AcpRuntimeProfile[];
  assignments: readonly RoleAssignment[];
}

export interface RoleRuntimeRegistry {
  getAssignment: (roleId: string) => RoleAssignment;
  getRuntimeForRole: (roleId: string) => AcpRuntimeProfile;
}

export interface RoleRunInput {
  roleId: string;
  issueId: string;
  runtime: AcpRuntimeProfile;
  assignment: RoleAssignment;
  inputArtifacts: readonly WorkflowArtifact[];
}

export interface RoleRunner {
  run: (input: RoleRunInput) => Promise<WorkflowArtifact>;
}

export interface RunAssignedRoleInput {
  roleId: string;
  issueId: string;
  inputArtifacts: readonly WorkflowArtifact[];
  registry: RoleRuntimeRegistry;
  runner: RoleRunner;
}

export interface ScriptedRoleOutput {
  artifactKind: string;
  payload: unknown;
}

const requireValidRuntime = (runtime: unknown): AcpRuntimeProfile => {
  if (!isAcpRuntimeProfile(runtime)) {
    throw new Error("Invalid ACP runtime profile");
  }
  return runtime;
};

const requireValidAssignment = (assignment: unknown): RoleAssignment => {
  if (!isRoleAssignment(assignment)) {
    throw new Error("Invalid role assignment");
  }
  return assignment;
};

export const createRoleRuntimeRegistry = (
  config: RoleRuntimeRegistryConfig,
): RoleRuntimeRegistry => {
  const runtimes = new Map(
    config.runtimes.map((runtime) => [runtime.id, requireValidRuntime(runtime)]),
  );
  const assignments = new Map(
    config.assignments.map((assignment) => [assignment.roleId, requireValidAssignment(assignment)]),
  );

  const getAssignment = (roleId: string): RoleAssignment => {
    const assignment = assignments.get(roleId);
    if (!assignment) throw new Error(`No runtime assigned for role: ${roleId}`);
    return assignment;
  };

  const getRuntimeForRole = (roleId: string): AcpRuntimeProfile => {
    const assignment = getAssignment(roleId);
    const runtime = runtimes.get(assignment.runtimeProfileId);
    if (!runtime) {
      throw new Error(
        `Runtime profile not found for role "${roleId}": ${assignment.runtimeProfileId}`,
      );
    }
    return runtime;
  };

  return { getAssignment, getRuntimeForRole };
};

export const runAssignedRole = async (input: RunAssignedRoleInput): Promise<WorkflowArtifact> => {
  const assignment = input.registry.getAssignment(input.roleId);
  const runtime = input.registry.getRuntimeForRole(input.roleId);
  return input.runner.run({
    roleId: input.roleId,
    issueId: input.issueId,
    runtime,
    assignment,
    inputArtifacts: input.inputArtifacts,
  });
};

export const createScriptedRoleRunner = (
  outputsByRole: Record<string, ScriptedRoleOutput>,
): RoleRunner => ({
  run: async (input) => {
    const output = outputsByRole[input.roleId];
    if (!output) throw new Error(`No scripted output for role: ${input.roleId}`);
    return {
      id: `agent:${input.issueId}:${input.roleId}:${output.artifactKind}`,
      kind: output.artifactKind,
      source: "agent",
      producerRoleId: input.roleId,
      payload: structuredClone(output.payload),
    };
  },
});
