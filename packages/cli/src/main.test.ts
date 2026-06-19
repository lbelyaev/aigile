import { describe, expect, it } from "bun:test";
import { formatDemoResult, selectDemoMode } from "./main.js";

describe("cli formatting", () => {
  it("formats demo output for hand testing", () => {
    expect(formatDemoResult({
      issueKey: "LIN-123",
      finalState: "merged",
      pullRequest: {
        id: "aigile/aigile#1",
        number: 1,
        url: "https://github.local/aigile/aigile/pull/1",
        owner: "aigile",
        repo: "aigile",
        branch: "aigile/LIN-123",
        baseBranch: "main",
        title: "LIN-123 Build hand-testable pipeline",
        body: "Demo PR",
        comments: [],
        checks: [],
      },
      artifacts: [],
      timeline: ["issue_received -> planning", "merge_completed -> merged"],
    })).toContain("Final state: merged");
  });

  it("selects the ACP-agent demo mode from argv", () => {
    expect(selectDemoMode(["demo:agents"])).toBe("agents");
    expect(selectDemoMode(["demo:workspace"])).toBe("workspace");
    expect(selectDemoMode(["demo:github"])).toBe("github");
    expect(selectDemoMode(["demo:linear"])).toBe("linear");
    expect(selectDemoMode([])).toBe("scripted");
  });
});
