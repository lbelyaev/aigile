import { describe, expect, it } from "bun:test";
import { loadRuntimeConfigFromJson, runtimeConfigToRegistry } from "./index.js";

describe("runtime config", () => {
  it("loads provider-neutral ACP runtime assignments from JSON", () => {
    const config = loadRuntimeConfigFromJson(
      JSON.stringify({
        runtimes: [
          {
            id: "architect-runtime",
            transport: "stdio",
            command: ["agent-acp", "--architect"],
            defaultModel: "configured-model",
          },
        ],
        assignments: [
          {
            roleId: "architect",
            runtimeProfileId: "architect-runtime",
            instructionRef: "roles/architect.md",
          },
        ],
      }),
    );

    expect(config.runtimes[0]).toEqual({
      id: "architect-runtime",
      transport: "stdio",
      command: ["agent-acp", "--architect"],
      defaultModel: "configured-model",
    });
    expect(config.assignments[0]).toEqual({
      roleId: "architect",
      runtimeProfileId: "architect-runtime",
      instructionRef: "roles/architect.md",
    });
  });

  it("builds a role runtime registry from config", () => {
    const registry = runtimeConfigToRegistry(
      loadRuntimeConfigFromJson(
        JSON.stringify({
          runtimes: [
            {
              id: "checker-runtime",
              transport: "stdio",
              command: ["agent-acp", "--checker"],
            },
          ],
          assignments: [
            {
              roleId: "checker",
              runtimeProfileId: "checker-runtime",
            },
          ],
        }),
      ),
    );

    expect(registry.getRuntimeForRole("checker")).toEqual({
      id: "checker-runtime",
      transport: "stdio",
      command: ["agent-acp", "--checker"],
    });
  });

  it("rejects invalid runtime config", () => {
    expect(() =>
      loadRuntimeConfigFromJson(
        JSON.stringify({
          runtimes: [{ id: "bad", transport: "stdio", command: [] }],
          assignments: [],
        }),
      ),
    ).toThrow(/invalid runtime/i);

    expect(() => loadRuntimeConfigFromJson("{bad json")).toThrow(/valid json/i);
  });
});
