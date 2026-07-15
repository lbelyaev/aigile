import { describe, expect, it } from "bun:test";
import { effectiveMergePolicy, resolveMergePolicy } from "./merge-policy.js";

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

describe("effectiveMergePolicy", () => {
  it("uses the product default when the issue has no override", () => {
    expect(effectiveMergePolicy("auto", undefined)).toBe("auto");
    expect(effectiveMergePolicy("manual", "Implement the feature.")).toBe("manual");
  });

  it("defaults to auto when no product default or issue override is present", () => {
    expect(effectiveMergePolicy(undefined, undefined)).toBe("auto");
  });

  it("lets explicit issue directives override product defaults in both directions", () => {
    expect(effectiveMergePolicy("auto", "aigile-merge: manual")).toBe("manual");
    expect(effectiveMergePolicy("manual", "aigile-merge: auto")).toBe("auto");
    expect(effectiveMergePolicy("auto", "no-automerge")).toBe("manual");
  });
});
