# Configure behavior through a JSON file

Pass `--config path/to/config.json` to `run`. The CLI recursively merges the JSON with its built-in defaults. Arrays replace the default array. Resolved configuration and a hash are written to the run directory. A `systemPrompt.file` path is resolved relative to the configuration file; other path arguments are described in [installation](installation.md).

Configuration must not contain `apiKey`. Use `apiKeyEnv`, which names an environment variable. `baseUrl` and `apiKeyEnv` can be omitted for a registered provider. Unknown providers require explicit values. Do not assume that any unknown model will have known prices or compatible behavior.

The smallest starting configuration is [read-only.json](../examples/read-only.json). It selects DeepSeek, bounds the output, enables request reservations, and uses static rules. [model-approval.json](../examples/model-approval.json) also selects an independent approval model; read the approval guide before using it.

## Defaults that affect a run

- The model is `deepseek-flash`, with thinking enabled and effort `high`. Maximum output per request is 32,000 tokens.
- Task limits are 80 turns, 20,000,000 aggregate input tokens, 1,000,000 aggregate output tokens, and cost 1 in the model's currency. `limits.maxRequests` and `limits.maxDurationMs` are optional.
- Retries allow at most 6 attempts with backoff. Limits apply to repeated attempts too.
- `requestGuard` is false by default. Enabling `modelApproval` makes it true, even if the JSON explicitly sets it false.
- `checkpoints` is true. Context masking, recovery expansion, project memory, and advanced search features are mostly off.
- `spendLedger` defaults to `~/.mountains/spend.jsonl`. The CLI expands this home-directory form.

`limits.maxCostUsd` remains accepted as a legacy spelling of `maxCost`; use `maxCost` with the model's actual currency. Read [budgets and costs](budgets-and-costs.md) before choosing limits.

## Optional context and tools

`masking.enabled` allows older tool results to leave active context. `masking.policy` can select threshold or price-aware planning. It reduces carried context; it is not a guarantee of lower provider cost.

`tools.expand` registers recovery of retained output. `tools.archiveSearch` requires expansion. `contextGuard` also requires expansion, because removed evidence must remain retrievable. `masking.rebase` can replace older complete interaction groups with a program-generated execution record when masking cannot free enough room. Keep a recoverable copy of important evidence.

`tools.read` controls bounds, line numbers, deduplication, and optional Python symbol lookup. Other opt-ins include outlines, scoped searches, code lookup, batched edits, query plans, and lean output. `memory.enabled` supplies project notes that are checked against current files; `memory.verifiedFacts` requests stricter fact validation. Memory and query recipes live outside the task workspace.

`userIdMode` defaults to `none`. `per-run` generates an isolated ID; `fixed` uses `userIdFixed` across runs and can change cache isolation. Do not change this between benchmark competitors without disclosing the difference.

The exact configuration types and defaults are in `apps/cli/src/config.ts`. See [approvals](approvals.md) for static and model policies.
