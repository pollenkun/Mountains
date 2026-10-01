# Formal comparisons are planned; this snapshot has no result claims

The planned repair-task sources are SWE-bench Verified, SWE-bench Multilingual, and SWE-bench Live. Freeze the dataset revision, eligibility rules, sampling seed, difficulty strata, reference checks, task starting commits, agent versions, model settings, platform, hardware, and budgets before inspecting formal results. Development tasks and unseen evaluation tasks must be separated.

Planned competitors are OpenCode, Pi, and DeepSeek Harness. Record their exact versions and routes at execution time; do not imply that a remembered version is current. All agents retain their native tools, prompts, retrieval, context processing, and scheduling. Necessary compatibility changes must be minimal, recorded, and chosen before evaluation answers are observed.

A controlled resource line and a native-window line answer different questions. Record the input/output allowance and context policy used for each result. A smaller shared input window can change another agent's compression frequency. Do not generalize that result to all defaults. DeepSeek Harness native and compatibility routes require separate labels. Token-count calibration is a separate prerequisite; engine support does not make the CLI an exact-count benchmark runner.

## Count failures in costs and time

Correctness uses frozen hidden acceptance and regression checks in an independent environment. Report hidden test pass, complete requested output, and final delivery separately. A reference patch is not the only acceptable implementation.

Cost per solved task is all valid-attempt cost divided by the number solved. Include failures, retries, summaries, child calls, and recovery. If none are solved, do not manufacture a finite successful-task cost. Infrastructure-invalid attempts require a predeclared rule and a visible reason; expensive failures must not be removed selectively.

Agent time includes startup, model waits, tools, indexing, visible checks, retrying, and context processing. Installation and external grading are separate. Report completion rate and a failure-penalized time measure so quick failures do not look like efficient repairs. Balance competitor order and do not select the best repeated attempt. Pair results by task and retain task grouping when estimating uncertainty.

Measure approval decisions, needed clarification, long-task recovery, and clean installation separately. A headless run with no interruptions does not establish usability. Report Windows-native versus WSL/backend execution separately; Windows-specific behavior needs Windows checks.

## Results remain pending

| Comparison | Frozen task list | Correctness | Cost per solved task | Time | Review |
| --- | --- | --- | --- | --- | --- |
| Mountains / OpenCode / Pi / DeepSeek Harness | Pending | Pending | Pending | Pending | Not performed |

**Author self-test; not independently reviewed.** This repository's unit tests are development checks. No formal model comparison under this method has run or established cost, speed, or accuracy advantages.

Historical public tasks may be in model training data. Hidden tests are not shown to an agent during execution, but that does not prove absence from training. Online models, aliases, caches, latency, and prices can change. Small samples and repeated tasks limit conclusions.

The private experiment environment and raw research are not distributed. A future public runner, frozen configurations, authorized task-acquisition scripts, and minimal result records require a separate release. If evidence is available only to authorized reviewers, label that portion as not fully public-reproducible. Dataset licenses do not automatically replace upstream repository, patch, or test licenses.
