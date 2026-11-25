# Changelog

Notable changes to vetobench, newest first. Versions follow [Semantic Versioning](https://semver.org/).

Corrections to published numbers go here as **retractions**: the claim as published, the corrected number, why it was wrong, and the [CLAIMS.md](CLAIMS.md) line it affects. That line stays in CLAIMS.md, marked retracted, so the record stays complete.

## Unreleased

### Corrected

- **CLAIMS #15: "88%" of the author's pre-cleanup shell allow-rules never fired is now "about 85%"** (981 of 1,159, was 1,025). Building `fix`, an adversarial review showed that rule use was under-counted when a rule-approved command was one the matcher could not read (wrappers such as `timeout 30`, quoted `FOO="a b"` prefixes, subshells, multi-line commands). The matcher now cleans such parts up and, failing that, counts every rule for the part's own command word as used. The strict count (1,025, 88%) is the upper end of the range. Published in a LinkedIn reply and the README on 2026-11-25.

### Added

- The card: `npx vetobench` reads the Claude Code transcripts on your machine and prints who approved each tool call (static allow-rules, the AI classifier, or you through a permission prompt), as counts and shares only. Options: `[dir]`, `--since`, `--until`, `--json`.
- Where the agent was running: each decision is also counted for main sessions, loops (`/loop`, `/goal`) and subagents.
- Wildcard attribution (`--rules`): how many static-approved shell actions relied on a wildcard interpreter or remote rule such as `python3:*`.
- The rules audit reads the settings of every project your sessions ran in, not only the current folder's. Each session is matched to the folder it was launched from, so worktrees count under their project.
- Unused rules: how many of your shell allow-rules never approved a command in the window, counted per project. Counts only.
- `--secrets`: counts of passwords, keys and tokens left in plain text in your transcripts, by category.
- Share formats: `--md`, `--share` (a link to a prefilled card issue that you open yourself) and `--svg`, plus a "Submit your card" issue form.
- `vetobench replay`: how often an "ask before production writes, CI triggers and pushes to main" policy would have asked, with your own hosts via `--policy`.
- `vetobench fix`: removes allow-rules that hold a secret, broad wildcards and shell rules that never fired, from your own settings files. A dry run unless `--write`; every file is first copied into `~/.claude/vetobench-backups/` (readable only by you), only elements of `permissions.allow` are removed and every other byte stays. Never-used rules need 14 days of history in their project, and rule shapes the matcher cannot judge are kept. Shared project settings only with `--include-shared`. Counts only.
- Asks per day in `vetobench replay`: the average, the busiest day and the days without an ask, plus the count per day in `--json`.
- Each tool call is counted once, even when a resumed or forked session copied it into another transcript. Tool names in `--json` are limited to Claude Code's built-in tools; MCP tools show as `mcp`.
- Supply-chain hardening for the repository: every GitHub Action pinned to a full commit SHA and kept current by Dependabot, a read-only default token, and no persisted git credentials in any workflow.
- An OpenSSF Scorecard workflow.
- A release workflow: a `v*` tag runs the same tests as CI, then publishes to npm through trusted publishing (no long-lived token) with provenance.
- CONTRIBUTING.md and this changelog.

### Retractions

None.
