# Log Output Smoke Test

## Goal

Use this note when checking a local branch that changes Aigile operator logging. The smoke test should run one harmless documentation ticket through the local architect, developer, and deep-review path so the terminal output can be inspected before merging logging changes.

This is a manual visual check. It should not require runtime code changes, new dependencies, or changes to package scripts.

## Setup

1. Start from the branch that contains the logging changes under review.
2. Create or select a low-risk ticket whose implementation is documentation-only.
3. Confirm the local configuration points at the intended repository, ticket source, and agent runtimes.
4. Run the normal local Aigile command for one ticket, using dry-run settings only if the branch being inspected requires them.

## What To Inspect

A healthy run should make progress easy to follow from the terminal without opening generated artifacts first:

- Role and progress lines clearly show when architect, developer, verifier, checker, and deep-review work starts, waits, resumes, or finishes.
- Artifact summaries identify the important produced artifacts, such as plans, developer attempts, verifier results, checker decisions, and review notes.
- Tool details are visible enough to explain what happened without flooding the terminal with unbounded raw output.
- Deep-review progress is bounded and readable, including checkpoint or budget information when the review loop continues across steps.
- Failures or blocked states keep their role, issue, and artifact context close to the message that needs operator attention.

## Expected Result

The implementation ticket used for this smoke test should remain intentionally small and non-functional. After the run, review the terminal output for readability, then run the repository checks:

```sh
bun run check
```

Do not treat this smoke test as a substitute for automated verification. It exists to confirm that the local operator experience is readable while the normal checks still cover formatting, linting, type checking, and tests.
