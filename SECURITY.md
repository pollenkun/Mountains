# Security

Mountains is an early development project. Its approval checks are not an operating-system sandbox.

## Using the agent

- Use a disposable checkout or isolated machine for untrusted tasks. Approved subprocesses run with the permissions of the current user.
- Keep API keys in environment variables or a credential manager. Configuration stores only the variable names. Sensitive-name environment variables are removed from tool subprocesses, but this does not prevent subprocesses from reading files or other available credentials.
- Read the approval configuration. The built-in default allows ordinary writes and network operations; the [read-only example](examples/read-only.json) is more restrictive.
- Treat task text, repository files, and model output as untrusted. A model approval decision can be wrong, including after malicious instructions in project content.
- Run recordings, output archives, memories, checkpoints, and configuration can contain source code, paths, and task content. Redaction does not make these safe to publish automatically.
- Review changes before running, merging, or distributing generated code.

See [approvals](docs/approvals.md) and [budgets](docs/budgets-and-costs.md) for limits and failure behavior.

## Reporting a vulnerability

Do not publish credentials or exploitation details in a public issue. When this project has a hosted repository, use its enabled private vulnerability-reporting channel or the private contact listed by its maintainers.

This local preparation snapshot has no configured private reporting address. Maintainers must provide a working private channel before public publication. There is no promised response-time policy yet.

Include the affected commit or release, the smallest reproduction, expected and actual behavior, and potential impact. Remove API keys and private source from the report. You do not need to make paid API calls to demonstrate a bug.

## Supported versions

There is no stable release or security support window yet. Fixes target the current development version. Dependency vulnerabilities should include the affected dependency version and an explanation of how Mountains uses it.
