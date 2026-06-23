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
  issueStatusLabels: IssueStatusLabels;
}

export interface IssueStatusLabels {
  planning: string;
  developing: string;
  blocked: string;
  inReview: string;
  done: string;
}

export const DEFAULT_ISSUE_STATUS_LABELS: IssueStatusLabels = {
  planning: "In Progress",
  developing: "In Progress",
  // "Blocked" is not present in every Linear team's workflow. Status sync failures
  // are reported as progress lines; override this per team when needed.
  blocked: "Blocked",
  inReview: "In Review",
  done: "Done",
};

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

const readOptionalLabel = (
  value: Record<string, unknown>,
  key: keyof IssueStatusLabels,
): string => {
  const label = value[key];
  if (label === undefined) return DEFAULT_ISSUE_STATUS_LABELS[key];
  if (typeof label !== "string" || label.trim().length === 0) {
    throw new Error(`Runtime config issueStatusLabels.${key} must be a non-empty string`);
  }
  return label;
};

const loadIssueStatusLabels = (value: Record<string, unknown>): IssueStatusLabels => {
  const labels = value.issueStatusLabels;
  if (labels === undefined) return DEFAULT_ISSUE_STATUS_LABELS;
  if (!isRecord(labels)) throw new Error("Runtime config issueStatusLabels must be an object");
  return {
    planning: readOptionalLabel(labels, "planning"),
    developing: readOptionalLabel(labels, "developing"),
    blocked: readOptionalLabel(labels, "blocked"),
    inReview: readOptionalLabel(labels, "inReview"),
    done: readOptionalLabel(labels, "done"),
  };
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

  return { runtimes, assignments, issueStatusLabels: loadIssueStatusLabels(value) };
};

export const runtimeConfigToRegistry = (config: RuntimeConfig): RoleRuntimeRegistry =>
  createRoleRuntimeRegistry(config);
