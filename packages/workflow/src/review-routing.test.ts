import { describe, expect, it } from "bun:test";
import {
  reviewDepthForChangedFiles,
  reviewRoleForChangedFiles,
  reviewStrategyForChangedFiles,
} from "./review-routing.js";

describe("review risk-gating", () => {
  it("routes high-blast-radius workflow, reducer, and engine changes to deep review", () => {
    expect(reviewDepthForChangedFiles(["packages/workflow/src/reducer.ts"])).toBe("deep");
    expect(reviewDepthForChangedFiles(["packages/workflow/src/engine.ts"])).toBe("deep");
    expect(reviewDepthForChangedFiles(["packages/demo/src/engine-handlers.ts"])).toBe("deep");
    expect(reviewRoleForChangedFiles(["packages/workflow/src/reducer.ts"])).toBe("deep_reviewer");
  });

  it("routes trivial diffs to the light checker", () => {
    expect(reviewDepthForChangedFiles(["README.md", "docs/usage.md"])).toBe("light");
    expect(reviewRoleForChangedFiles(["README.md"])).toBe("checker");
  });

  it("selects configured review strategies for low and high blast-radius changes", () => {
    const config = {
      defaultMode: "light" as const,
      highRiskMode: "full" as const,
      strategies: {
        light: {
          mode: "light" as const,
          reviewers: ["checker"],
          angles: ["correctness"],
          maxFindings: 3,
          validationBudget: { maxCalls: 1, maxMinutes: 5 },
          concurrency: 1,
          skillHints: ["code_review"],
        },
        full: {
          mode: "full" as const,
          reviewers: ["deep_reviewer"],
          angles: ["correctness", "cross-file"],
          maxFindings: 10,
          validationBudget: { maxCalls: 20, maxMinutes: 20 },
          concurrency: 2,
          skillHints: ["code_review"],
        },
      },
    };

    expect(reviewStrategyForChangedFiles(["README.md"], config).mode).toBe("light");
    expect(reviewStrategyForChangedFiles(["packages/workflow/src/engine.ts"], config)).toEqual(
      config.strategies.full,
    );
    expect(reviewRoleForChangedFiles(["packages/workflow/src/engine.ts"], config)).toBe(
      "deep_reviewer",
    );
  });
});
