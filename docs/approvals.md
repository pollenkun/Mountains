# Choose a policy before allowing tools to change files

The CLI has no interactive approval interface. Its built-in static policy denies commands classified as dangerous and allows read-only commands, workspace writes, and network actions. This classification is heuristic. A command that is misclassified can still act with your operating-system permissions.

[read-only.json](../examples/read-only.json) allows the read-only risk category and falls back to denial. It is a stricter starting policy, not an operating-system sandbox. Approved subprocesses can read available files and credentials despite sensitive environment-name filtering.

Static rules are checked in order. A rule can select `risks` and optionally a command regex `pattern`. The first match returns `allow` or `deny`. `fallback: "ask"` only works when an embedding application supplies a human callback. The current CLI does not supply one, so unhandled static requests are denied.

## An independent model can review bound actions

[model-approval.json](../examples/model-approval.json) enables a separate model for handled commands, edits, and writes. It uses `MOUNTAINS_APPROVAL_API_KEY` by default. It is billed and counted with the root task, and has a smaller separate cost cap. A configured model decision can authorize an action; do not treat a static deny rule as a guaranteed additional veto in this mode.

At minimum set `modelApproval.model` and a positive `modelApproval.maxCost` no larger than `limits.maxCost`. Unknown approval models also require explicit `profile`, `baseUrl`, and `pricing`. Profiles are protocol descriptions, not model certifications.

Approval defaults are 512 output tokens, 20,000 input characters, 6 recent messages, a 15-second timeout, 12 requests, and 2 denials before pausing. Cross-currency approval requires an explicit `conversion.rate` and dated `conversion.asOf`; no exchange rate is fetched automatically. The same key variable cannot be reused across different endpoint origins.

Approval snapshots bind target files and arguments. A changed target, cancellation, incomplete material, invalid decision, timeout, or uncertain usage does not turn into automatic authorization. Exact `allowRules` are explicit user-authored preauthorizations; they are not broad risk regexes. `manualTools` sends selected operations to the user-decision path.

A model decision of `ask` pauses the run. This snapshot has no TUI or CLI resume-approval interaction. Inspect the saved run, adjust the task or authorization deliberately, and begin a new run. Do not assume that a stalled request will resume by itself.

A judge can still be wrong or be misled by project content. Use disposable workspaces, review the final diff, and read [SECURITY.md](../SECURITY.md). For financial limits, see [budgets](budgets-and-costs.md).
