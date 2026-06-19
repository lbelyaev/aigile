# Aigile

Aigile is a durable agentic development pipeline. It coordinates software work through typed artifacts, explicit state transitions, and source-of-truth integrations.

The initial product goal is to dogfood the system itself: turn Linear issues into GitHub pull requests through role-based collaboration between ACP-compatible agents.

## Development

```bash
bun install
bun run check
```

## Hand-Test Commands

```bash
bun run demo
bun run demo:agents
bun run demo:workspace
bun run demo:github
bun run demo:linear
bun run packages/cli/src/main.ts run LIN-123 --repo /tmp/aigile-demo-repo --worktrees /tmp/aigile-demo-repo/.worktrees --dry-run
```

## Restate

The workflow rules remain in pure TypeScript. The Restate package exposes a service scaffold:

```bash
bun run restate:service
```

The service wrapper is ready to be registered with a local Restate server once the server/runtime is installed for the target environment.

## Architecture Bias

- Roles are stable: architect, developer, checker, verifier.
- Agent providers are pluggable: any ACP-compatible agent can fulfill a role.
- Linear owns intent and status.
- GitHub owns code, pull requests, and review convergence.
- The workflow is an explicit durable FSM.
