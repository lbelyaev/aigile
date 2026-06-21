import { describe, expect, it } from "bun:test";
import { resolveMergePolicy } from "./merge-policy.js";

describe("resolveMergePolicy", () => {
  it("defaults to auto when there is no description or directive", () => {
    expect(resolveMergePolicy(undefined)).toBe("auto");
    expect(resolveMergePolicy("")).toBe("auto");
    expect(resolveMergePolicy("Implement the feature.\n\nAcceptance:\n- works")).toBe("auto");
  });

  it("honors an explicit aigile-merge directive (case- and space-insensitive)", () => {
    expect(resolveMergePolicy("aigile-merge: manual")).toBe("manual");
    expect(resolveMergePolicy("Do the thing.\n\nAigile-Merge:   manual\n")).toBe("manual");
    expect(resolveMergePolicy("aigile-merge: auto")).toBe("auto");
  });

  it("recognizes the no-automerge shorthand", () => {
    expect(resolveMergePolicy("Please review by hand. no-automerge")).toBe("manual");
    expect(resolveMergePolicy("automerge: off")).toBe("manual");
  });

  it("an explicit auto directive overrides a stray shorthand mention", () => {
    expect(resolveMergePolicy("aigile-merge: auto (ignore older no-automerge note)")).toBe("auto");
  });
});
