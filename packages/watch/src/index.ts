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

const defaultClaimStatus = "aigile:claimed";
const defaultClaimComment = "Aigile claimed this issue for local processing.";

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
  await input.tracker.updateIssueStatus(issue.key, claimStatus);
  await input.tracker.appendIssueComment(issue.key, claimComment);

  return {
    readyCount: readyIssues.length,
    claimedIssue: issue,
    actions: [
      `status:${issue.key}:${claimStatus}`,
      `comment:${issue.key}`,
    ],
  };
};

export { defaultClaimComment, defaultClaimStatus };
