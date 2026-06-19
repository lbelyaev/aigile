import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  WORKFLOW_STATES,
  WORKFLOW_EVENT_TYPES,
  isAcpRuntimeProfile,
  isRoleAssignment,
  isWorkflowArtifact,
  isWorkflowEvent,
} from "./index.js";

describe("domain schemas", () => {
  it("models agent runtimes as generic ACP command profiles", () => {
    expect(
      isAcpRuntimeProfile({
        id: "local-architect",
        displayName: "Local architect",
        transport: "stdio",
        command: ["custom-acp-agent", "--role", "architect"],
        defaultModel: "model-from-config",
        capabilities: {
          streaming: true,
          permissionRequests: true,
          sessionResume: false,
        },
      }),
    ).toBe(true);

    expect(
      isAcpRuntimeProfile({
        id: "bad-runtime",
        transport: "stdio",
        command: [],
      }),
    ).toBe(false);
  });

  it("assigns any role id to a configured runtime profile", () => {
    expect(
      isRoleAssignment({
        roleId: "security-reviewer",
        runtimeProfileId: "local-reviewer",
        instructionRef: "roles/security-reviewer.md",
      }),
    ).toBe(true);

    expect(
      isRoleAssignment({
        roleId: "",
        runtimeProfileId: "local-reviewer",
      }),
    ).toBe(false);
  });

  it("validates workflow artifact envelopes", () => {
    expect(
      isWorkflowArtifact({
        id: "artifact-1",
        kind: "architect.plan",
        source: "agent",
        producerRoleId: "architect",
        provenance: {
          runtime: {
            runtimeId: "codex-acp",
            transport: "stdio",
            command: ["npx", "-y", "@zed-industries/codex-acp"],
            model: "runtime-default",
            tokenUsage: {
              inputTokens: 1200,
              outputTokens: 500,
              totalTokens: 1700,
            },
          },
        },
        payload: { summary: "Plan the change" },
      }),
    ).toBe(true);

    expect(
      isWorkflowArtifact({
        id: "artifact-2",
        kind: "architect.plan",
        source: "agent",
      }),
    ).toBe(false);
  });

  it("defines explicit FSM states and event types", () => {
    expect(WORKFLOW_STATES).toContain("awaiting_plan_approval");
    expect(WORKFLOW_STATES).toContain("satisfied");
    expect(WORKFLOW_STATES).toContain("merged");
    expect(WORKFLOW_EVENT_TYPES).toContain("plan_drafted");
    expect(WORKFLOW_EVENT_TYPES).toContain("checker_requested_changes");
    expect(WORKFLOW_EVENT_TYPES).toContain("work_satisfied");
  });

  it("validates workflow events with optional artifact references", () => {
    expect(
      isWorkflowEvent({
        type: "plan_drafted",
        issueId: "LIN-123",
        artifactId: "artifact-1",
      }),
    ).toBe(true);

    expect(
      isWorkflowEvent({
        type: "not_real",
        issueId: "LIN-123",
      }),
    ).toBe(false);
  });

  it("does not bake provider names into the domain source", () => {
    const source = readFileSync(join(process.cwd(), "packages/types/src/domain.ts"), "utf8");

    expect(source).not.toContain("Codex");
    expect(source).not.toContain("Claude");
  });
});
