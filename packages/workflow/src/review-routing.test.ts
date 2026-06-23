import { describe, expect, it } from "bun:test";
import { reviewDepthForChangedFiles, reviewRoleForChangedFiles } from "./review-routing.js";

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
});
