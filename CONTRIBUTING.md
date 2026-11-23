# Contributing

vetobench runs on people's private agent transcripts, so a few rules are firm. A change that breaks one is not merged, however useful it is.

## Rules

- **Zero runtime dependencies, no install scripts.** `package.json` has no `dependencies` and no `preinstall`, `install`, `postinstall` or `prepare` script. Dev tooling must not change that.
- **Zero network.** Nothing in `bin/` or `src/` may import a network-capable module (`http`, `https`, `net`, `tls`, `dgram`, `dns`, `child_process` and a few more) or call `fetch`, `WebSocket` or `XMLHttpRequest`. `test/no-egress.test.js` enforces this, and CI also runs the CLI with networking switched off. Never weaken either check.
- **Aggregates only.** Output is counts, shares and version strings. It never contains commands, file paths, prompts, rule bodies or secret values, so a card is safe to paste publicly.
- **Synthetic fixtures only.** Fixtures in `test/fixtures/` are hand-written. Never commit, attach or paste real transcripts, settings, labels or commands, not even redacted ones. Reproduce a bug with a small synthetic transcript instead.

## Run the tests

Node 18 or later, nothing to install:

```
node --test
node bin/vetobench.js test/fixtures/projects
```

CI runs the tests on Node 18, 20 and 22, then runs the CLI under `unshare --user --net` (Linux), where any network call fails. Scanning and aggregation belong in `src/analyze.js`, with tests in `test/`.

## Public numbers

Every number published about vetobench or from it (README, methodology, a post, a talk) has a line in [CLAIMS.md](CLAIMS.md) with:

- the claim, worded as published;
- its status: **measured**, or **estimated** with how it was estimated;
- the corpus and its window;
- the exact command that reproduces it, for example `node bin/vetobench.js <dir> --since 2026-10-22 --until 2026-11-21`.

A change that adds or changes a public number adds or updates its CLAIMS.md line in the same pull request. A number that no command can replay is not published.

If a published number turns out to be wrong, do not edit it away. Mark its CLAIMS.md line **retracted** and add a retraction to [CHANGELOG.md](CHANGELOG.md): what was claimed, the corrected number, and why it was wrong.

## Security

Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).
