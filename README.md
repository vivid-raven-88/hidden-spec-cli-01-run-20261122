# mend

[![hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/vivid-raven-88/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/vivid-raven-88/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format: it reads a unified diff
(often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, or JSON
text-editor tool calls, finds each edit's lines with fuzzy matching on drifted
whitespace and indentation, and writes every change or none.

Run it as `node main.ts [options] [PATCH]` with the working directory as the
root of a tree of text files. See SPEC.md in the kit for the full contract.
