import { describe, expect, it } from "bun:test";
import { loadReviewStrategyConfig } from "./index.js";

describe("review strategy config", () => {
  it("defaults light, deep-parallel, and full strategies with explicit knobs", () => {
    const config = loadReviewStrategyConfig(undefined);

    expect(config.defaultMode).toBe("light");
    expect(config.highRiskMode).toBe("deep-parallel");
    expect(config.strategies.light).toMatchObject({
      mode: "light",
      reviewers: ["checker"],
      angles: ["correctness"],
      maxFindings: 3,
      validationBudget: { maxCalls: 1, maxMinutes: 5 },
      concurrency: 1,
      skillHints: ["code_review"],
    });
    expect(config.strategies["deep-parallel"]).toMatchObject({
      mode: "deep-parallel",
      reviewers: ["deep_reviewer"],
      maxFindings: 1,
      validationBudget: { maxCalls: 8, maxMinutes: 10 },
      concurrency: 4,
    });
    expect(config.strategies.full).toMatchObject({
      mode: "full",
      reviewers: ["deep_reviewer"],
      maxFindings: 10,
      validationBudget: { maxCalls: 20, maxMinutes: 20 },
      concurrency: 4,
    });
  });

  it("parses configured strategy fields and rejects unknown modes", () => {
    const config = loadReviewStrategyConfig({
      defaultMode: "light",
      highRiskMode: "full",
      strategies: {
        full: {
          reviewers: ["deep_reviewer", "checker"],
          angles: ["correctness", "cross-file"],
          maxFindings: 7,
          validationBudget: { maxCalls: 11, maxMinutes: 12 },
          concurrency: 2,
          skillHints: ["code_review", "repo_read"],
        },
      },
    });

    expect(config.highRiskMode).toBe("full");
    expect(config.strategies.full).toEqual({
      mode: "full",
      reviewers: ["deep_reviewer", "checker"],
      angles: ["correctness", "cross-file"],
      maxFindings: 7,
      validationBudget: { maxCalls: 11, maxMinutes: 12 },
      concurrency: 2,
      skillHints: ["code_review", "repo_read"],
    });

    expect(() =>
      loadReviewStrategyConfig({
        defaultMode: "maximum",
      }),
    ).toThrow(/defaultMode must be light, deep-parallel, or full/i);

    expect(() =>
      loadReviewStrategyConfig({
        strategies: {
          maximum: { reviewers: ["checker"] },
        },
      }),
    ).toThrow(/unknown review strategy mode/i);

    expect(() =>
      loadReviewStrategyConfig({
        strategies: {
          full: { reviewers: ["deep-reviewer"] },
        },
      }),
    ).toThrow(/reviewers must contain only checker or deep_reviewer/i);
  });

  it("rejects deep-reviewer strategies with fewer than two angles", () => {
    expect(() =>
      loadReviewStrategyConfig({
        strategies: {
          "deep-parallel": {
            reviewers: ["deep_reviewer"],
            angles: ["correctness"],
          },
        },
      }),
    ).toThrow(/deep_reviewer.*at least two angles/i);
  });
});
