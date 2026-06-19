import type { IssueRecord, IssueTrackerAdapter, ReadyIssueSource } from "@aigile/adapters";

export interface WatchOnceInput {
  source: ReadyIssueSource;
  tracker: IssueTrackerAdapter;
  claimStatus?: string;
  claimComment?: string;
}

export interface WatchOnceResult {
  readyCount: number;
  actions: string[];
  claimedIssue?: IssueRecord;
}

export type WatchLoopStopReason = "aborted" | "max_polls";

export type WatchLoopEvent =
  | { type: "poll_started"; poll: number }
  | { type: "poll_idle"; poll: number; readyCount: number }
  | { type: "issue_claimed"; poll: number; issueKey: string; readyCount: number }
  | { type: "watch_stopped"; polls: number; reason: WatchLoopStopReason };

export interface WatchLoopInput extends WatchOnceInput {
  pollIntervalMs: number;
  maxPolls?: number;
  signal?: AbortSignal;
  sleep?: (durationMs: number, signal?: AbortSignal) => Promise<void>;
  onEvent?: (event: WatchLoopEvent) => void;
  onClaimedIssue?: (issue: IssueRecord) => Promise<void>;
}

const defaultClaimStatus = "aigile:claimed";
const defaultClaimComment = "Aigile claimed this issue for local processing.";

const defaultSleep = async (durationMs: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, durationMs);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
};

export const watchOnce = async (input: WatchOnceInput): Promise<WatchOnceResult> => {
  const readyIssues = await input.source.listReadyIssues();
  const issue = readyIssues[0];
  if (!issue) {
    return {
      readyCount: 0,
      actions: ["no_ready_issues"],
    };
  }

  const claimStatus = input.claimStatus ?? defaultClaimStatus;
  const claimComment = input.claimComment ?? defaultClaimComment;
  const hasClaimComment = issue.comments.includes(claimComment);
  await input.tracker.updateIssueStatus(issue.key, claimStatus);
  if (!hasClaimComment) {
    await input.tracker.appendIssueComment(issue.key, claimComment);
  }

  return {
    readyCount: readyIssues.length,
    claimedIssue: issue,
    actions: hasClaimComment
      ? [`status:${issue.key}:${claimStatus}`]
      : [
          `status:${issue.key}:${claimStatus}`,
          `comment:${issue.key}`,
        ],
  };
};

export const watchLoop = async (input: WatchLoopInput): Promise<void> => {
  const claimedKeys = new Set<string>();
  const sleep = input.sleep ?? defaultSleep;
  let polls = 0;

  while (input.signal?.aborted !== true) {
    polls += 1;
    input.onEvent?.({ type: "poll_started", poll: polls });
    const result = await watchOnce({
      source: {
        listReadyIssues: async () =>
          (await input.source.listReadyIssues()).filter((issue) => !claimedKeys.has(issue.key)),
      },
      tracker: input.tracker,
      ...(input.claimStatus === undefined ? {} : { claimStatus: input.claimStatus }),
      ...(input.claimComment === undefined ? {} : { claimComment: input.claimComment }),
    });

    if (result.claimedIssue === undefined) {
      input.onEvent?.({ type: "poll_idle", poll: polls, readyCount: result.readyCount });
    } else {
      claimedKeys.add(result.claimedIssue.key);
      input.onEvent?.({
        type: "issue_claimed",
        poll: polls,
        issueKey: result.claimedIssue.key,
        readyCount: result.readyCount,
      });
      await input.onClaimedIssue?.(result.claimedIssue);
    }

    if (input.maxPolls !== undefined && polls >= input.maxPolls) {
      input.onEvent?.({ type: "watch_stopped", polls, reason: "max_polls" });
      return;
    }
    await sleep(input.pollIntervalMs, input.signal);
  }

  input.onEvent?.({ type: "watch_stopped", polls, reason: "aborted" });
};

export { defaultClaimComment, defaultClaimStatus };
