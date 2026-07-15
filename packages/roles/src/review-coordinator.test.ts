import { describe, expect, it } from "bun:test";
import { createDeveloperPunchList, deduplicateReviewFindings } from "./index.js";
import type { ReviewFinding } from "@aigile/types";

const finding = (overrides: Partial<ReviewFinding>): ReviewFinding => ({
  file: "packages/workflow/src/review-routing.ts",
  line: 12,
  scenario: "Workflow reducer changes skip deep review",
  severity: "medium",
  confidence: 0.7,
  whyItMatters: "A risky workflow change can be accepted without independent review.",
  minimalFix: "Route high-blast-radius changes through deep review.",
  ...overrides,
});

describe("review coordinator", () => {
  it("deduplicates matching findings and orders highest severity and confidence first", () => {
    const findings = deduplicateReviewFindings([
      finding({ severity: "medium", confidence: 0.7 }),
      finding({ severity: "medium", confidence: 0.9, minimalFix: "Use the configured strategy." }),
      finding({
        file: "packages/types/src/artifacts.ts",
        line: 20,
        scenario: "Malformed findings are accepted",
        severity: "high",
        confidence: 0.8,
      }),
      finding({
        line: 18,
        scenario: "Distinct line remains separate",
        severity: "low",
        confidence: 0.95,
      }),
    ]);

    expect(findings).toHaveLength(3);
    expect(findings[0]?.severity).toBe("high");
    expect(findings[1]).toMatchObject({
      line: 12,
      confidence: 0.9,
      minimalFix: "Use the configured strategy.",
    });
    expect(findings[2]).toMatchObject({ line: 18, severity: "low" });
  });

  it("generates a concise structured developer punch list", () => {
    const punchList = createDeveloperPunchList(
      [
        finding({ severity: "low", confidence: 0.6 }),
        finding({ severity: "high", confidence: 0.9, scenario: "Coordinator drops a finding" }),
      ],
      1,
    );

    expect(punchList).toEqual({
      findings: [
        finding({
          severity: "high",
          confidence: 0.9,
          scenario: "Coordinator drops a finding",
        }),
      ],
    });
  });
});
