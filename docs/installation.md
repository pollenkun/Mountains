# Install the source checkout and run one task

Use Node.js 22.19.0 or newer, npm, Git, ripgrep (`rg`), Bash, and Python 3. The full test suite needs all these tools on `PATH`. Search and checkpoints use `rg`; Python code lookup uses Python 3. Set `MOUNTAINS_RG` or `MOUNTAINS_PYTHON` to select an executable for those features.

From the repository root:

```sh
npm ci
npm run check
npm run mountains
```

The last command displays usage and exits with code 2. There is no separate `--help` command. This is a source workspace, not a published global npm package. TUI and desktop applications are not implemented.

Set only environment variable names in configuration: `DEEPSEEK_API_KEY`, `ZHIPU_API_KEY`, or `MOONSHOT_API_KEY`, depending on the provider. An independent approval model uses `MOUNTAINS_APPROVAL_API_KEY` by default. Set `MOUNTAINS_BUDGET` to a positive cap in the task model's currency. Credentials are supplied through your environment; do not put their values in JSON or commit them.

Start in a disposable workspace:

```sh
npm run mountains -- run --task "Explain the files without changing them." \
  --workspace ./examples/sample-workspace --config ./examples/read-only.json
```

A live run uploads task text and selected workspace content to the configured model and incurs provider charges. The read-only policy limits approved actions; it is not a system sandbox.

## CLI arguments and exits

`run` accepts exactly one of `--task` or `--task-file`, plus required `--workspace`. Optional arguments are `--config`, `--json`, `--out`, `--run-id`, `--base-url`, and `--spend-ledger`. Paths can be relative to the current directory. `--base-url` overrides the configuration endpoint.

`replay` requires `--recording` and `--workspace`, and accepts `--out` and `--json`. It uses recorded model responses and makes no model request. **It can execute the recorded tools again**, so use a disposable workspace. Replay is not proof of live success, token counts, or cache behavior.

Exit codes are 0: completed; 1: failed; 2: usage error; 3: limit reached; 130: cancelled. The first interrupt requests cancellation; a second can force exit.

## Platform status

The preparation checks ran on macOS with Node 24. CI is configured for macOS, Linux, and Windows, but Linux and Windows runner results are not established by this snapshot. Node 22.19 remains configured in CI; its separate local runtime download did not complete.

Windows requires Bash for shell-script commands. Some tests and process cleanup depend on Unix permissions, process groups, executable scripts, and links. Git Bash provides commands but does not make Node's Windows behavior identical. Native Windows support must be checked on a real runner. WSL results should be identified as a Linux backend.

For configuration and model-specific settings, see [configuration](configuration.md) and [models](models.md).
