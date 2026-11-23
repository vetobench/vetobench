# vetobench: project rules

vetobench answers "who approved my coding agent's actions, and how often are permission guards wrong?"
1. **The card:** a local CLI. `npx vetobench` reads `~/.claude/projects` and prints aggregates.
2. **The bench:** an open benchmark of permission guards on real traffic, launching after the card.

Open source (Apache-2.0), no paid product. Built in public on X and LinkedIn.

## Hard rules

- **Zero network.** Nothing in `bin/` or `src/` may import `http`, `https`, `net`, `tls`, `dgram`, `dns` or `child_process`, or call `fetch`, `WebSocket` or `XMLHttpRequest`. `test/no-egress.test.js` enforces this, and CI also runs the CLI inside a network namespace with no network. Never weaken either check.
- **Zero runtime dependencies and no install scripts** (`preinstall`, `install`, `postinstall`). Dev tooling must not change that.
- **Aggregates only.** Output contains counts, shares and version strings. It never contains commands, file paths, rule bodies, prompts or secret values. A submitted card must be safe to paste publicly.
- **Never commit real transcripts, labels or commands.** Fixtures in `test/fixtures/` are synthetic and hand-written. The private corpus lives in `~/agent-corpus-snapshots/` and the labels in `~/agent-corpus-snapshots/labels/`, both outside this repo.
- **Fully abstracted publishing.** Docs, posts and examples never name the author's clients, their products, colleagues, hosts or tickets. Run `python3 -I ~/Projects/agentguard-research/scripts/publish_guard.py <file>` on every doc and post before it goes public.
- **Every public number is reproducible.** Each one gets a line in `CLAIMS.md`: the claim, measured or estimated, the corpus window, and the exact command. Never ship a number that cannot be replayed. Corrections go in the changelog as retractions.
- **Credibility over reach.** No vote rings, no star trading, no "security" claims for heuristics. Guard authors get their numbers 14 days before publication, with a right of reply.

## Layout

- `bin/vetobench.js`: CLI entry point (argument parsing, output).
- `src/analyze.js`: pure scanning and aggregation; everything testable lives here.
- `test/`: `node --test`; synthetic fixtures; the no-egress check.
- `METHODOLOGY.md`: definitions (gates, what "human" means, windows, caveats).
- `CLAIMS.md`: the claims ledger.

## Commands

- `node --test`: all tests.
- `node bin/vetobench.js [dir] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--json]`: run the card.

## Context

- Research, decisions, plan and drafts: `~/Projects/agentguard-research/` (README "Execution plan v3", DECISIONS.md, content/drafts/).
- Launch: Sunday 2026-12-13 at about 16:00 CET. Cross-guard numbers: Tuesday 2027-01-05, after the 14-day notice.
- Before launch: pin GitHub Actions to commit SHAs, turn on the OpenSSF Scorecard action, and publish to npm with provenance (`npm publish --provenance`). Remove `"private": true` from `package.json` only on launch day.
