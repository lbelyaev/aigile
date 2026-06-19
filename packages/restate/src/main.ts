import { createRestateIssueWorkflowService, createRestateServeOptions } from "./service.js";

export const createAigileRestateServeOptions = (): { services: unknown[] } => {
  const service = createRestateIssueWorkflowService({
    executeCommand: async (command) => ({
      command: command.type,
      issueId: command.issueId,
    }),
  });
  return createRestateServeOptions(service);
};

if (import.meta.path === Bun.main) {
  process.stdout.write("Aigile Restate service scaffold is ready.\n");
  process.stdout.write(
    "Register this service with a Restate server using the Restate CLI/runtime.\n",
  );
}
