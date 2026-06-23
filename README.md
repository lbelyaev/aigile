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
bun run packages/cli/src/main.ts watch --linear --product aigile --products-config config/aigile.products.example.json --runtime-config config/aigile.runtimes.example.json --poll-interval 30s --max-polls 1
```

### Progress output

Agent progress is printed to stderr. Control the verbosity with `--quiet` /
`--verbose` (default is `normal`):

- `--quiet` — lifecycle milestones only (role started/connected, artifacts
  parsed, policy violations, approval requests). No streamed text or per-tool
  lines.
- _normal_ (default) — milestones plus the agent's text output, tool starts, and
  permission decisions. Drops the noisiest streams (per-token "thinking",
  subprocess stderr, tool ends, connection chatter).
- `--verbose` — everything, including thinking, subprocess stderr, and tool ends.

The developer↔checker loop is bounded by `maxDeveloperAttempts` (default **3**);
after that the run escalates instead of looping further.

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
