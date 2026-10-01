# Load a small configuration before a live run

`read-only.json` uses static rules and denies unhandled writes and network actions. `model-approval.json` uses a separate billed model to review handled actions, so it can authorize writes when it judges them permitted. Neither configuration is a system sandbox.

Supply credential values only through the environment. Configuration contains environment variable names, never keys. Set `MOUNTAINS_BUDGET` deliberately before a live run. Use `sample-workspace/` or another disposable checkout.

See [installation](../docs/installation.md), [configuration](../docs/configuration.md), [approvals](../docs/approvals.md), and [budgets](../docs/budgets-and-costs.md). These examples were loaded locally without contacting a model.
