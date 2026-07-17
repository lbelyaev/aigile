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
      inputArtifacts: [
        {
          id: "linear:LIN-123",
          kind: "linear.issue",
          source: "linear",
          payload: { title: "Build prompts" },
        },
        {
          id: "policy:LIN-123:dry-run",
          kind: "execution.policy",
          source: "system",
          payload: {
            mode: "dry_run",
            fileWrites: "forbidden",
            commits: "forbidden",
          },
        },
      ],
    });

    expect(prompt).toContain("Role: architect");
    expect(prompt).toContain("Issue: LIN-123");
    expect(prompt).toContain("Return only valid JSON");
    expect(prompt).toContain("artifactKind: architect.plan");
    expect(prompt).toContain('"summary": "string"');
    expect(prompt).toContain('"scope": [');
    expect(prompt).toContain('"acceptanceCriteria": [');
    expect(prompt).toContain('"verificationCommands": [');
    expect(prompt).toContain('"risks": [');
    expect(prompt).toContain("In dry_run mode, read at most 5 files");
    expect(prompt).toContain("In agent_write mode, keep file reads focused");
    expect(prompt).toContain("the developer role may edit files in the worktree");
    expect(prompt).toContain("must not commit, push, or open pull requests");
    expect(prompt).toContain("Execution policy artifacts are authoritative");
    expect(prompt).toContain("No agent-native skills were advertised");
    expect(prompt).toContain("Do not edit files");
    expect(prompt).toContain("No Markdown");
    expect(prompt).toContain('"artifactKind"');
    expect(prompt).toContain("linear.issue");
    expect(prompt).toContain("execution.policy");
    expect(prompt).not.toContain("Codex");
    expect(prompt).not.toContain("Claude");
  });

  it("asks checker runtimes to prefer advertised code review skills", () => {
    const prompt = buildRolePrompt({
      roleId: "checker",
      issueId: "LIN-456",
      instruction: getDefaultRoleInstruction("checker"),
      runtimeCapabilities: {
        skills: ["code_review", "repo_read"],
      },
      inputArtifacts: [
        {
          id: "workspace:LIN-456:diff",
          kind: "workspace.diff",
          source: "system",
          payload: { summary: "1 file changed" },
        },
      ],
    });

    expect(prompt).toContain("Advertised agent-native skills: code_review, repo_read");
    expect(prompt).toContain("may be used as an optional aid");
    expect(prompt).toContain("explicit checker methodology");
    expect(prompt).toContain("checker.verdict JSON contract is authoritative");
    expect(prompt).toContain('"findings": [');
    expect(prompt).toContain('"artifactKind": "checker.verdict"');
    expect(prompt).not.toContain("Claude");
    expect(prompt).not.toContain("Codex");
  });

  it("injects strategy skill hints only when the runtime advertised them", () => {
    const advertised = buildRolePrompt({
      roleId: "deep_reviewer",
      issueId: "LIN-456",
      instruction: getDefaultRoleInstruction("deep_reviewer"),
      runtimeCapabilities: {
        skills: ["code_review"],
      },
      reviewSkillHints: ["code_review", "repo_read"],
      inputArtifacts: [],
    });
    const missing = buildRolePrompt({
      roleId: "deep_reviewer",
      issueId: "LIN-456",
      instruction: getDefaultRoleInstruction("deep_reviewer"),
      runtimeCapabilities: {
        skills: ["repo_read"],
      },
      reviewSkillHints: ["code_review"],
      inputArtifacts: [],
    });

    expect(advertised).toContain("Chosen review strategy skill hints available: code_review");
    expect(advertised).toContain("checker.verdict JSON contract is authoritative");
    expect(missing).not.toContain("Chosen review strategy skill hints available: code_review");
    expect(missing).toContain("checker.verdict JSON contract is authoritative");
  });

  it("falls checker prompts back to manual review when no code review skill is advertised", () => {
    const prompt = buildRolePrompt({
      roleId: "checker",
      issueId: "LIN-789",
      instruction: getDefaultRoleInstruction("checker"),
      runtimeCapabilities: {
        skills: ["repo_read"],
      },
      inputArtifacts: [],
    });

    expect(prompt).toContain("Advertised agent-native skills: repo_read");
    expect(prompt).toContain("No code_review skill was advertised");
    expect(prompt).toContain("perform the explicit checker methodology manually");
    expect(prompt).toContain("correctness/diff-scan");
    expect(prompt).toContain("removed-behavior");
    expect(prompt).toContain("cross-file/callers");
    expect(prompt).toContain("tests-faithful-to-reality lens");
    expect(prompt).toContain(
      "mocks that return values real GitHub, Linear, CLIs, APIs, or adapters would not return",
    );
    expect(prompt).toContain("nonexistent gh --json fields");
    expect(prompt).toContain("nonexistent Linear states");
    expect(prompt).toContain("self-refutation pass");
    expect(prompt).toContain("bias to changes_requested");
    expect(prompt).toContain("checker.verdict JSON contract is authoritative");
  });
});
