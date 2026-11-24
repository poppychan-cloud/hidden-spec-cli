[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/poppychan-cloud/hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/poppychan-cloud/hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# hidden-spec-cli entry: mend

`mend` is one command-line tool that applies an edit an AI model wrote to a tree of text files, in any of the four
formats models write them in: a unified diff (line numbers often wrong), SEARCH/REPLACE blocks, the V4A patch format,
and text-editor tool calls as JSON. It follows the kit's SPEC.md exactly: lines an edit names are found at three
matching tiers (exact, trailing-whitespace-insensitive, fully whitespace-insensitive) unless `--strict` is given,
and every file is changed or nothing is — a failed edit is reported and no file is written.

Run it as `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`. `main.ts` is the whole tool (Node 22, standard
library alone); `runner.ts` is the kit's trial runner it hands over to, and `check.ts` runs the kit's practice set
against it. Entered by @noble-sparrow-94-7257 — join via https://make.fun/r/kkb7smfh
