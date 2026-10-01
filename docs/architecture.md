# The CLI assembles separate engine packages

`apps/cli` loads JSON configuration, credentials from the environment, a workspace, provider adapter, budget guard, and event sink. It runs a single task or replays recorded model responses. UI applications are documentation placeholders.

| Package | Responsibility |
| --- | --- |
| `protocol` | Shared message, tool, event, and usage contracts |
| `context` | Stable segments, estimates, context planning, retained evidence and recovery |
| `providers` | Model capabilities, protocol adaptation, usage normalization, rate snapshots |
| `tools` | Workspace access, reads, searches, writes, edits, commands, memory, query recipes |
| `checkpoints` | Shadow Git snapshots of workspace changes |
| `telemetry` | Run recordings, redaction and per-request accounting |
| `engine` | Session loop, retries, limits, approvals and request reservations |

The dependency check enforces declared package imports and allowed directions, including `apps/cli`. Provider-library types remain inside the adapter rather than becoming public protocol types.

A normal turn builds context, checks applicable limits, invokes the adapter, records usage, then handles requested tools. Static or model approval chooses whether sensitive actions proceed. Tool results become later context. Optional recovery keeps an external copy when active context is reduced. That copy must remain outside the task workspace.

The CLI saves runs under `~/.mountains/runs/`. Memories and recipes are separated per workspace under the configured Mountains home. Checkpoints are recovery aids, not proof of correctness. Model logs and checkpoints can contain private source; they are not public telemetry automatically.

There is no operating-system sandbox, interactive TUI, desktop implementation, automatic model migration, or complete native Windows verification in this snapshot. See [installation](installation.md), [approvals](approvals.md), and [evaluation](evaluation.md) for the practical limits.
