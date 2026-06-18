# Aigile

Aigile is a durable agentic development pipeline. It coordinates software work through typed artifacts, explicit state transitions, and source-of-truth integrations.

The initial product goal is to dogfood the system itself: turn Linear issues into GitHub pull requests through role-based collaboration between ACP-compatible agents.

## Development

```bash
bun install
bun run check
```

## Architecture Bias

- Roles are stable: architect, developer, checker, verifier.
- Agent providers are pluggable: any ACP-compatible agent can fulfill a role.
- Linear owns intent and status.
- GitHub owns code, pull requests, and review convergence.
- The workflow is an explicit durable FSM.
