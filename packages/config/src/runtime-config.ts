import { createRoleRuntimeRegistry, type RoleRuntimeRegistry } from "@aigile/roles";
import {
  isAcpRuntimeProfile,
  isRoleAssignment,
  type AcpRuntimeProfile,
  type RoleAssignment,
} from "@aigile/types";

export interface RuntimeConfig {
  runtimes: AcpRuntimeProfile[];
  assignments: RoleAssignment[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJson = (json: string): unknown => {
  try {
    return JSON.parse(json) as unknown;
  } catch (error) {
    throw new Error(
      `Runtime config was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export const loadRuntimeConfigFromJson = (json: string): RuntimeConfig => {
  const value = parseJson(json);
  if (!isRecord(value)) throw new Error("Runtime config must be an object");
  if (!Array.isArray(value.runtimes)) throw new Error("Runtime config runtimes must be an array");
  if (!Array.isArray(value.assignments))
    throw new Error("Runtime config assignments must be an array");

  const runtimes = value.runtimes.map((runtime, index) => {
    if (!isAcpRuntimeProfile(runtime)) throw new Error(`Invalid runtime at index ${index}`);
    return runtime;
  });
  const assignments = value.assignments.map((assignment, index) => {
    if (!isRoleAssignment(assignment)) throw new Error(`Invalid role assignment at index ${index}`);
    return assignment;
  });

  return { runtimes, assignments };
};

export const runtimeConfigToRegistry = (config: RuntimeConfig): RoleRuntimeRegistry =>
  createRoleRuntimeRegistry(config);
