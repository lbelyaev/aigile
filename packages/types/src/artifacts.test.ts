import { describe, expect, it } from "bun:test";
import {
  isArchitectPlanPayload,
  isCheckerVerdictPayload,
  isDeveloperAttemptPayload,
  parseRoleArtifactResponse,
} from "./index.js";

describe("role artifact payloads", () => {
  it("validates architect plan payloads", () => {
    expect(isArchitectPlanPayload({
      summary: "Plan the work",
      scope: ["types", "workflow"],
      acceptanceCriteria: ["tests pass"],
      verificationCommands: ["bun run check"],
      risks: ["agent output drift"],
    })).toBe(true);

    expect(isArchitectPlanPayload({ summary: "missing lists" })).toBe(false);
  });

  it("validates developer attempt payloads", () => {
    expect(isDeveloperAttemptPayload({
      summary: "Implemented the change",
      changedFiles: ["packages/types/src/artifacts.ts"],
      verificationNotes: "Run bun test",
    })).toBe(true);

    expect(isDeveloperAttemptPayload({
      summary: "bad",
      changedFiles: [1],
    })).toBe(false);
  });

  it("validates checker verdict payloads", () => {
    expect(isCheckerVerdictPayload({
      verdict: "changes_requested",
      summary: "Needs another pass",
      reasons: ["missing test"],
    })).toBe(true);

    expect(isCheckerVerdictPayload({
      verdict: "unknown",
      summary: "bad",
      reasons: [],
    })).toBe(false);
  });

  it("parses role artifact responses from objects and JSON strings", () => {
    expect(parseRoleArtifactResponse({
      artifactKind: "checker.verdict",
      payload: {
        verdict: "pass",
        summary: "Looks good",
        reasons: [],
      },
    })).toEqual({
      artifactKind: "checker.verdict",
      payload: {
        verdict: "pass",
        summary: "Looks good",
        reasons: [],
      },
    });

    expect(parseRoleArtifactResponse(JSON.stringify({
      artifactKind: "developer.attempt",
      payload: {
        summary: "Done",
        changedFiles: ["README.md"],
        verificationNotes: "Not run",
      },
    })).artifactKind).toBe("developer.attempt");
  });

  it("rejects malformed role artifact responses", () => {
    expect(() => parseRoleArtifactResponse({
      artifactKind: "checker.verdict",
      payload: { verdict: "maybe", summary: "bad", reasons: [] },
    })).toThrow(/invalid checker verdict/i);

    expect(() => parseRoleArtifactResponse("not json")).toThrow(/valid json/i);
  });
});
