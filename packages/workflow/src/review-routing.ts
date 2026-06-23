export type ReviewDepth = "light" | "deep";

const normalizedPath = (filePath: string): string => filePath.replaceAll("\\", "/");

const isHighBlastRadiusPath = (filePath: string): boolean => {
  const path = normalizedPath(filePath);
  const fileName = path.split("/").at(-1);
  return (
    fileName === "reducer.ts" ||
    fileName === "engine.ts" ||
    fileName?.startsWith("engine-") === true ||
    path.includes("/workflow/") ||
    path.startsWith("packages/workflow/") ||
    path.endsWith("/workflow")
  );
};

export const reviewDepthForChangedFiles = (changedFiles: readonly string[]): ReviewDepth =>
  changedFiles.some(isHighBlastRadiusPath) ? "deep" : "light";

export const reviewRoleForChangedFiles = (changedFiles: readonly string[]): string =>
  reviewDepthForChangedFiles(changedFiles) === "deep" ? "deep_reviewer" : "checker";
