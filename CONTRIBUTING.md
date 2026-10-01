# Contributing

Mountains is in early development. Small, reviewable changes are the easiest to accept. Before a large feature or architectural change, describe the problem, expected behavior, and proposed scope in an issue or discussion.

## Local development

For the complete check suite, use Node.js 22.19.0 or newer, npm, Git, ripgrep (`rg`), Python 3 (`python3`), and Bash on `PATH`. From the repository root:

```sh
npm ci
npm run check
```

The check command runs TypeScript checking, package-boundary checks, and product tests. Tests should work without provider credentials or paid API calls. Do not add live model calls to the default test suite.

Run the CLI with `npm run mountains -- run ...`. See [installation](docs/installation.md) for arguments and exit codes.

## Pull requests

Explain the concrete problem and the resulting behavior. Include the checks you ran and any remaining limitations. Add focused regression tests when a bug could silently return. Documentation-only changes need accurate commands, working links, and examples that still load.

Keep credentials, source from private projects, local run records, and personal machine information out of commits. Use disposable workspaces and environment variable names in examples. Review the staged diff and stage explicit paths rather than adding an entire working directory blindly.

Engine behavior belongs in `packages/`; CLI argument handling belongs in `apps/cli/`. The TUI and desktop directories currently contain documentation placeholders. User documentation belongs in `docs/`.

## Provider and cost changes

Provider behavior and pricing can change independently of this project. Document the source, retrieval date, currency, and assumptions when changing capability or price metadata. Preserve explicit reporting of missing usage. Do not turn an estimate into an invoice claim or treat an unverified model identifier as a tested integration.

Budget and approval changes must keep failed, retried, cancelled, and uncertain requests visible in accounting. Never put API keys in configuration or recorded request bodies.

## Evaluation claims

Do not add cost-saving, speed, or accuracy claims without an authorized result package and its method. Describe task origin, agent and model versions, platform, failures, measurement scope, and independent review status. See [evaluation](docs/evaluation.md).

## License and conduct

By submitting a contribution, you agree to license it under Apache-2.0. Identify any third-party material and its license. Follow the [code of conduct](CODE_OF_CONDUCT.md), and report vulnerabilities using [SECURITY.md](SECURITY.md).
