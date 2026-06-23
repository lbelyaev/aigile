import { describe, expect, it } from "bun:test";
import type { WorkflowArtifact } from "@aigile/types";
import {
  createAcpRoleRunner,
  createRoleRuntimeRegistry,
  runAssignedDeepReview,
  runAssignedRole,
} from "./index.js";
import {
  syntheticKnownMissAngles,
  syntheticKnownMissDeepReviewFixtures,
} from "./deep-review-known-miss-fixtures.js";

// Opt-in LIVE evaluation of the "evaluate it" deliverable: run the REAL deep_reviewer
// against the recorded known-miss diffs and assert it actually DETECTS each defect
// (not just that the pipeline aggregates a synthetic finding — that is the fast
// deterministic test in deep-review.test.ts). Skipped by default; it needs a real,
// authenticated agent runtime. Enable with:
//   AIGILE_REAL_DEEP_REVIEW_SMOKE=1 bun test packages/roles/src/deep-review.smoke.test.ts
const smokeIt = process.env.AIGILE_REAL_DEEP_REVIEW_SMOKE === "1" ? it : it.skip;

describe("deep review real smoke (opt-in)", () => {
  const registry = createRoleRuntimeRegistry({
    runtimes: [
      {
        id: "codex-acp",
        transport: "stdio",
        command: ["npx", "-y", "@zed-industries/codex-acp"],
        envPassthrough: [
          "OPENAI_API_KEY",
          "OPENAI_BASE_URL",
          "CODEX_HOME",
          "XDG_CONFIG_HOME",
          "XDG_DATA_HOME",
          "XDG_CACHE_HOME",
          "SSH_AUTH_SOCK",
        ],
      },
    ],
    assignments: [{ roleId: "deep_reviewer", runtimeProfileId: "codex-acp" }],
  });
  const runner = createAcpRoleRunner();
  const runRole = (
    _roleId: "deep_reviewer",
    inputArtifacts: readonly WorkflowArtifact[],
  ): Promise<WorkflowArtifact> =>
    runAssignedRole({
      roleId: "deep_reviewer",
      issueId: "deep-review-smoke",
      inputArtifacts,
      registry,
      runner,
    });

  for (const knownMiss of syntheticKnownMissDeepReviewFixtures) {
    smokeIt(
      `real deep review detects: ${knownMiss.name}`,
      async () => {
        const artifact = await runAssignedDeepReview({
          issueId: knownMiss.name.replace(/[^A-Z0-9]+/gi, "-"),
          inputArtifacts: [
            {
              id: `smoke:${knownMiss.name}:diff`,
              kind: "workspace.diff",
              source: "system",
              payload: {
                source: knownMiss.source,
                changedFiles: knownMiss.changedFiles,
                diff: knownMiss.diff,
              },
            },
          ],
          reviewerModel:
            registry.getRuntimeForRole("deep_reviewer").defaultModel ??
            registry.getRuntimeForRole("deep_reviewer").id,
          angles: syntheticKnownMissAngles,
          runRole,
        });

        const payload = artifact.payload as { verdict: string; reasons: readonly string[] };
        // The real reviewer must surface the defect, not pass it.
        expect(payload.verdict, knownMiss.name).not.toBe("pass");
        expect(
          payload.reasons.some((reason) =>
            reason.toLowerCase().includes(knownMiss.expectedFinding.toLowerCase()),
          ),
          knownMiss.name,
        ).toBe(true);
      },
      600_000,
    );
  }
});
