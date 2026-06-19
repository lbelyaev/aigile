import { describe, expect, it } from "bun:test";
import { createAigileRestateServeOptions } from "./main.js";

describe("Restate service entrypoint", () => {
  it("creates serve options for the Aigile issue workflow", () => {
    const options = createAigileRestateServeOptions();

    expect(options.services).toHaveLength(1);
  });
});
