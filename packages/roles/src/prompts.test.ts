import { describe, expect, it } from "bun:test";
import { buildRolePrompt, getDefaultRoleInstruction } from "./index.js";

describe("role prompt builder", () => {
  it("provides default instructions for core roles", () => {
    expect(getDefaultRoleInstruction("architect")).toContain("Definition of Ready");
    expect(getDefaultRoleInstruction("developer")).toContain("developer.attempt");
    expect(getDefaultRoleInstruction("checker")).toContain("verdict");
  });

  it("builds a provider-neutral prompt with strict artifact JSON output", () => {
    const prompt = buildRolePrompt({
      roleId: "architect",
      issueId: "LIN-123",
      instruction: getDefaultRoleInstruction("architect"),
      inputArtifacts: [{
        id: "linear:LIN-123",
        kind: "linear.issue",
        source: "linear",
        payload: { title: "Build prompts" },
      }, {
        id: "policy:LIN-123:dry-run",
        kind: "execution.policy",
        source: "system",
        payload: {
          mode: "dry_run",
          fileWrites: "forbidden",
          commits: "forbidden",
        },
      }],
    });

    expect(prompt).toContain("Role: architect");
    expect(prompt).toContain("Issue: LIN-123");
    expect(prompt).toContain("Return only valid JSON");
    expect(prompt).toContain("artifactKind: architect.plan");
    expect(prompt).toContain("\"summary\": \"string\"");
    expect(prompt).toContain("\"scope\": [");
    expect(prompt).toContain("\"acceptanceCriteria\": [");
    expect(prompt).toContain("\"verificationCommands\": [");
    expect(prompt).toContain("\"risks\": [");
    expect(prompt).toContain("Read at most 5 files");
    expect(prompt).toContain("Execution policy artifacts are authoritative");
    expect(prompt).toContain("Do not edit files");
    expect(prompt).toContain("No Markdown");
    expect(prompt).toContain("\"artifactKind\"");
    expect(prompt).toContain("linear.issue");
    expect(prompt).toContain("execution.policy");
    expect(prompt).not.toContain("Codex");
    expect(prompt).not.toContain("Claude");
  });
});
