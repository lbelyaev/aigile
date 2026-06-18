# Aigile Agent Instructions

## Operating Rules

- Use Strict TDD: write or update a failing test first, then implement the smallest change that makes it pass.
- Use TypeScript and Bun for project code and tooling.
- Keep the repository as a monorepo when package boundaries are useful.
- Make one local commit per slice.
- Push only when preparing a PR or when explicitly requested; GitHub access may require biometric approval with a time-limited lease.

## Architecture Rules

- Do not hardcode Codex, Claude, or any provider-specific agent into core workflow logic.
- Model roles separately from runtimes. Any ACP-compatible agent may be assigned to a role through configuration.
- Keep Linear and GitHub as the intended sources of truth:
  - Linear owns intent, acceptance criteria, priority, and status.
  - GitHub owns code, pull requests, checks, review artifacts, and merge convergence.
- Keep FSM transition rules in pure, tested TypeScript.
- Keep side effects behind adapter/activity boundaries.
- Treat Restate as the durable execution host, not as the hidden owner of business rules.

## Initial Slice Discipline

- Prefer small packages with clear responsibilities.
- Add runtime guards or schema validation for persisted or external artifacts.
- Keep local fixtures until real Linear and GitHub integrations are wired.
- Reuse lessons from `~/dev/nexus` for ACP JSON-RPC, session updates, permission requests, and subprocess lifecycle.
