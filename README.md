# Mountains

[简体中文](README.zh-CN.md)

Mountains is an early-stage coding agent for cache-priced models such as DeepSeek, GLM, and Kimi, with a focus on lower cost, responsive execution, and practical controls.

The current product is a single-task CLI and a set of TypeScript engine packages. TUI and desktop applications are planned. There are no published formal benchmark results or demonstrated cost or speed advantages in this repository.

## What is implemented

- Stable prompt and tool prefixes, with optional price-aware removal of older tool output from active context.
- Optional context recovery: retained output can be fetched again, and older interaction groups can be replaced with a program-generated execution record when the configured window fills.
- File reading, searching, editing, writing, and command execution, with approval checks and change detection.
- Static approval rules, plus an optional independent model that reviews requested actions.
- Per-task limits and a shared spending record. Optional request reservations account for the main model and the approval model together.
- Provider-reported input, cache, output, and reasoning usage, with versioned local cost estimates. These estimates are not provider invoices.
- Local run recordings, shadow Git checkpoints, and optional project memory checked against current evidence.

Most optional features are disabled in the default configuration. The built-in approval policy allows ordinary writes and network commands. Start with the read-only example below and read the [approval guide](docs/approvals.md) before enabling writes.

## Install and try the CLI

Requirements for the complete `npm run check`: Node.js **22.19.0 or newer**, npm, Git, ripgrep (`rg`), Python 3 (`python3`), and Bash on `PATH`. Python is optional for CLI tasks that do not use Python-based code lookup. Command tasks may require additional project tools. Native Windows installation and runtime behavior have not been verified in this preparation.

From the repository root:

```sh
npm ci
npm run check
npm run mountains
```

The final command prints usage and exits with code `2`; this is the existing CLI behavior. The CLI accepts `run` and `replay`, and does not provide a `--help` command.

Set `DEEPSEEK_API_KEY` through your shell or credential manager, and set `MOUNTAINS_BUDGET` to a positive spending cap in USD. Only environment variable names belong in configuration files. A live `run` sends task and selected workspace content to the configured model service and can incur charges.

Start with a disposable workspace:

```sh
npm run mountains -- run \
  --workspace ./examples/sample-workspace \
  --config ./examples/read-only.json \
  --task "Read the README and explain what this workspace contains. Do not change files."
```

The example denies write and network commands through the static approval policy. Command classification is a heuristic, and subprocesses are not sandboxed. Use an isolated environment for untrusted projects.

Run output is stored under `~/.mountains/runs/` by default. It includes the final summary, resolved configuration, events, model recording, and request accounting. These files may contain source code and task text; review them before sharing.

See [installation](docs/installation.md), [configuration](docs/configuration.md), [models](docs/models.md), [approvals](docs/approvals.md), [budgets and costs](docs/budgets-and-costs.md), and [architecture](docs/architecture.md).

## Test method and results

The planned evaluation uses real repair tasks selected from SWE-bench Verified, SWE-bench Multilingual, and SWE-bench Live. Task selection, versions, hidden checks, exclusions, and analysis rules must be fixed before formal runs. Using these task sets does not make this an official SWE-bench ranking or an endorsement by their authors.

Planned competitors are Mountains, OpenCode, Pi, and DeepSeek Harness. Comparisons will keep the same model service, task starting state, output allowance, and root-task budget within each comparison. Each agent retains its own tools, prompts, retrieval, context reduction, and native scheduling. Versions, reasoning settings, non-default configuration, platform, hardware, and execution route will be disclosed. Native and compatibility routes, Windows-native and WSL runs, and different context-window conditions will be reported separately.

Correctness comes first. Cost per solved task includes failed attempts, retries, context processing, child-agent calls, and recovery calls. End-to-end time includes agent startup, model waits, tools, retries, and context processing; installation and external grading are reported separately. Repeated attempts will not be reduced to each agent's best run. Uncertainty intervals will keep repeated attempts grouped by task.

| Evaluation | Task source | Correctness | Cost per solved task | End-to-end time | Status |
| --- | --- | --- | --- | --- | --- |
| Formal comparative evaluation | Selected Verified, Multilingual, and Live repair tasks | Pending | Pending | Pending | Not run |
| Approval, installation, and long-task usability | Fixed scenarios, to be registered before runs | Pending | Pending | Pending | Not run |

**Author self-test; not independently reviewed.** No formal comparative results have been produced under the planned method. Development checks do not establish performance on new tasks, other providers, or all operating systems. The formal task runner and its result files are not shipped with this code snapshot.

Provider model aliases, cache behavior, load, and usage reporting can change. Online reruns need not produce identical patches, token counts, or times. GLM and Kimi have implemented adapter paths, but live-provider checks and calibrated exact input counting have not been established by this open-source preparation. See the [evaluation method](docs/evaluation.md) for reporting requirements and limitations.

## Repository layout

```text
packages/       Engine, context, tools, providers, protocol, accounting, checkpoints
apps/cli/       Single-task CLI
apps/tui/       Planned terminal interface; documentation placeholder
apps/desktop/   Planned desktop application; documentation placeholder
docs/           User documentation
examples/       Small configuration examples and a disposable sample workspace
```

## Roadmap

- Build an interactive TUI, including human approval and task clarification.
- Build a desktop application on the same engine.
- Complete and publish the formal evaluation method, supported public reproduction materials, and clearly scoped results.
- Validate provider integration and installation on each claimed platform.

These are plans, not available application features or delivery dates.

## Contributing and license

Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

Copyright Mountains contributors. Licensed under [Apache-2.0](LICENSE); see [NOTICE](NOTICE). Dependencies retain their own licenses.
