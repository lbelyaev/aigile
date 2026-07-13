export type PublishFailureKind = "transient" | "terminal";

export interface PublishRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (durationMs: number) => Promise<void>;
}

export interface PublishRetryResolvedOptions {
  maxAttempts: number;
  baseDelayMs: number;
  sleep: (durationMs: number) => Promise<void>;
}

export const DEFAULT_PUBLISH_RETRY_OPTIONS: PublishRetryResolvedOptions = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  sleep: (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)),
};

const messageFor = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const classifyPublishFailure = (error: unknown): PublishFailureKind => {
  const message = messageFor(error);
  if (
    /permission denied|authentication failed|could not read username|repository not found|bad credentials|requires authentication/i.test(
      message,
    )
  ) {
    return "terminal";
  }
  if (
    /\bnon-fast-forward\b|fetch first|failed to push some refs|remote rejected|rejected/i.test(
      message,
    )
  ) {
    return "terminal";
  }
  if (
    /received disconnect|bye bye|connection reset|connection timed out|operation timed out|could not resolve host|kex_exchange_identification|ssh_exchange_identification|connection closed by remote host|502 bad gateway|503 service unavailable|504 gateway timeout|\b5\d\d\b/i.test(
      message,
    )
  ) {
    return "transient";
  }
  return "terminal";
};

export const resolvePublishRetryOptions = (
  options: PublishRetryOptions = {},
): PublishRetryResolvedOptions => ({
  maxAttempts: options.maxAttempts ?? DEFAULT_PUBLISH_RETRY_OPTIONS.maxAttempts,
  baseDelayMs: options.baseDelayMs ?? DEFAULT_PUBLISH_RETRY_OPTIONS.baseDelayMs,
  sleep: options.sleep ?? DEFAULT_PUBLISH_RETRY_OPTIONS.sleep,
});

export const withPublishRetry = async <T>(
  operation: string,
  action: () => Promise<T>,
  options: PublishRetryOptions = {},
): Promise<T> => {
  const retry = resolvePublishRetryOptions(options);
  let attempt = 0;
  let lastError: unknown;
  while (attempt < retry.maxAttempts) {
    attempt += 1;
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (classifyPublishFailure(error) !== "transient") throw error;
      if (attempt >= retry.maxAttempts) break;
      await retry.sleep(retry.baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw new Error(
    `${operation} transient failure exhausted after ${retry.maxAttempts} attempts: ${messageFor(lastError)}`,
  );
};
