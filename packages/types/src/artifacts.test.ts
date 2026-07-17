import { describe, expect, it } from "bun:test";
import {
  isArchitectPlanPayload,
  isCheckerVerdictPayload,
  isDeveloperAttemptPayload,
  isHumanReviewPayload,
  isReviewFinding,
  isReviewPunchListPayload,
  parseRoleArtifactResponse,
} from "./index.js";

describe("role artifact payloads", () => {
  it("validates architect plan payloads", () => {
    expect(
      isArchitectPlanPayload({
        summary: "Plan the work",
        scope: ["types", "workflow"],
        acceptanceCriteria: ["tests pass"],
        verificationCommands: ["bun run check"],
        risks: ["agent output drift"],
      }),
    ).toBe(true);

    expect(isArchitectPlanPayload({ summary: "missing lists" })).toBe(false);
  });

  it("validates developer attempt payloads", () => {
    expect(
      isDeveloperAttemptPayload({
        summary: "Implemented the change",
        changedFiles: ["packages/types/src/artifacts.ts"],
        verificationNotes: "Run bun test",
      }),
    ).toBe(true);

    expect(
      isDeveloperAttemptPayload({
        summary: "bad",
        changedFiles: [1],
      }),
    ).toBe(false);
  });

  it("validates checker verdict payloads", () => {
    expect(
      isCheckerVerdictPayload({
        verdict: "changes_requested",
        summary: "Needs another pass",
        reasons: ["missing test"],
      }),
    ).toBe(true);

    expect(
      isCheckerVerdictPayload({
        verdict: "unknown",
        summary: "bad",
        reasons: [],
      }),
    ).toBe(false);
  });

  it("validates structured review findings and punch lists", () => {
    const finding = {
      file: "packages/workflow/src/review-routing.ts",
      line: 12,
      scenario: "A workflow reducer change skips deep review.",
      severity: "high",
      confidence: 0.9,
      whyItMatters: "The merge path can accept a risky workflow change without independent review.",
      minimalFix: "Route workflow changes through the configured deep review strategy.",
    };

    expect(isReviewFinding(finding)).toBe(true);
    expect(isReviewPunchListPayload({ findings: [finding] })).toBe(true);
    expect(isReviewFinding({ ...finding, minimalFix: undefined })).toBe(false);
    expect(isReviewFinding({ ...finding, confidence: 1.2 })).toBe(false);
  });

  it("validates human review artifacts", () => {
    const finding = {
      file: "packages/workflow/src/reducer.ts",
      line: 42,
      scenario: "A published PR receives a code-owner change request.",
      severity: "high",
      confidence: 0.95,
      whyItMatters: "The workflow must re-enter development before merging.",
      minimalFix: "Route human changes through the developer loop.",
    };

    expect(
      isHumanReviewPayload({
        verdict: "changes_requested",
        summary: "Code owner requested a small rework pass.",
        findings: [finding],
        source: "github_pr_review",
        prReview: {
          reviewer: "octocat",
          pullRequestUrl: "https://github.com/acme/aigile/pull/12",
          reviewId: "PRR_kwDOA",
          submittedAt: "2026-07-17T12:00:00.000Z",
        },
      }),
    ).toBe(true);

    expect(
      isHumanReviewPayload({
        verdict: "changes_requested",
        summary: "Missing findings.",
        source: "github_pr_review",
      }),
    ).toBe(false);
  });

  it("parses role artifact responses from objects and JSON strings", () => {
    expect(
      parseRoleArtifactResponse({
        artifactKind: "checker.verdict",
        payload: {
          verdict: "pass",
          summary: "Looks good",
          reasons: [],
        },
      }),
    ).toEqual({
      artifactKind: "checker.verdict",
      payload: {
        verdict: "pass",
        summary: "Looks good",
        reasons: [],
      },
    });

    expect(
      parseRoleArtifactResponse(
        JSON.stringify({
          artifactKind: "developer.attempt",
          payload: {
            summary: "Done",
            changedFiles: ["README.md"],
            verificationNotes: "Not run",
          },
        }),
      ).artifactKind,
    ).toBe("developer.attempt");
  });

  it("parses role artifact responses from fenced JSON text", () => {
    expect(
      parseRoleArtifactResponse(
        [
          "```json",
          JSON.stringify({
            artifactKind: "architect.plan",
            payload: {
              summary: "Plan",
              scope: ["roles"],
              acceptanceCriteria: ["artifact parses"],
              verificationCommands: ["bun test packages/types"],
              risks: [],
            },
          }),
          "```",
        ].join("\n"),
      ).artifactKind,
    ).toBe("architect.plan");
  });

  it("parses the first valid role artifact object from noisy text", () => {
    expect(
      parseRoleArtifactResponse(
        [
          "I will return JSON:",
          '{"note":"not the artifact"}',
          "```json",
          JSON.stringify(
            {
              artifactKind: "architect.plan",
              payload: {
                summary: "Plan",
                scope: ["roles"],
                acceptanceCriteria: ["artifact parses"],
                verificationCommands: ["bun test packages/types"],
                risks: [],
              },
            },
            null,
            2,
          ),
          "```",
        ].join("\n"),
      ).artifactKind,
    ).toBe("architect.plan");
  });

  it("rejects malformed role artifact responses", () => {
    expect(() =>
      parseRoleArtifactResponse({
        artifactKind: "checker.verdict",
        payload: { verdict: "maybe", summary: "bad", reasons: [] },
      }),
    ).toThrow(/invalid checker verdict/i);

    expect(() => parseRoleArtifactResponse("not json")).toThrow(/valid json/i);
  });

  it("parses and validates review punch-list artifacts", () => {
    const response = parseRoleArtifactResponse({
      artifactKind: "review.punchlist",
      payload: {
        findings: [
          {
            file: "packages/types/src/artifacts.ts",
            line: 42,
            scenario: "Malformed reviewer output reaches the workflow.",
            severity: "medium",
            confidence: 0.8,
            whyItMatters: "Downstream developer feedback would be ambiguous.",
            minimalFix: "Reject malformed findings at the artifact boundary.",
          },
        ],
      },
    });

    expect(response.artifactKind).toBe("review.punchlist");
    expect(() =>
      parseRoleArtifactResponse({
        artifactKind: "review.punchlist",
        payload: { findings: [{ file: "missing required fields" }] },
      }),
    ).toThrow(/invalid review punch-list/i);
  });

  it("parses and validates human review artifacts", () => {
    const response = parseRoleArtifactResponse({
      artifactKind: "human.review",
      payload: {
        verdict: "changes_requested",
        summary: "Code owner requested rework.",
        findings: [
          {
            file: "packages/types/src/domain.ts",
            line: 44,
            scenario: "The workflow misses human PR review feedback.",
            severity: "medium",
            confidence: 0.85,
            whyItMatters: "A PR with requested changes could still merge.",
            minimalFix: "Add a human change-request workflow event.",
          },
        ],
        source: "github_pr_review",
      },
    });

    expect(response.artifactKind).toBe("human.review");
    expect(() =>
      parseRoleArtifactResponse({
        artifactKind: "human.review",
        payload: {
          verdict: "approved",
          summary: "Malformed finding.",
          findings: [{ file: "missing required fields" }],
          source: "github_pr_review",
        },
      }),
    ).toThrow(/invalid human review/i);
  });
});
