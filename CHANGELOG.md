# Changelog

Notable changes to vetobench, newest first. Versions follow [Semantic Versioning](https://semver.org/).

Corrections to published numbers go here as **retractions**: the claim as published, the corrected number, why it was wrong, and the [CLAIMS.md](CLAIMS.md) line it affects. That line stays in CLAIMS.md, marked retracted, so the record stays complete.

## Unreleased

### Added

- `vetobench doctor`: a checkup of your permission settings in eleven fixed checks, each with a level and a count; `--ci` exits 1 on a high finding.
- `vetobench drift`: who approved your agent's actions, week by week, with the change against the week before; `--asks` adds the replay policy's asks per week.
- `vetobench graph --html FILE`: a self-contained HTML report of the card over time.
- `vetobench mcp`: the MCP permission surface (servers by scope and transport, MCP allow-rules, MCP calls by gate), counts only.
- `vetobench hook`: installs the replay policy as a Claude Code `PreToolUse` hook that asks before production writes, CI triggers and pushes to main. A dry run unless `--write`; backups first.
- `vetobench scrub`: redacts secret values left in plain text in your transcripts, value by value. A dry run unless `--write`; backups first; open sessions are left alone.
- `vetobench check-settings` and a GitHub Action (`action/`) that fails CI on committed allow-rules with a secret, a broad wildcard or a bare `Bash` allow.
- Issue forms (wrong verdict, bug, feature idea), a pull request template, `docs/releasing.md`, and a research note on Codex CLI approvals (`docs/codex.md`).
- CI runs each new command with networking switched off: `doctor --json`, `drift` (text, `--md`, `--asks --json`, in fixed windows around the fixtures' dates), `graph --html`, `mcp --json`, `hook run`, `hook install` (the refusal from a copy that is not a global install, then a dry run, `--write` and `uninstall --write` from one that is), `scrub` (a dry run, and `--write` on a throwaway copy of the fixtures) and `check-settings`.

### Changed

- The static no-network test (`test/no-egress.test.js`) also rejects submodules of the forbidden modules (`dns/promises`), the `module` and `vm` modules, `createRequire`, a dynamic `import()` or `require()` of anything but one plain string, code run from a string, `globalThis`, and any mention of `fetch`, called or not. It checks itself against those evasions.

## 0.1.0 (2026-11-25)

First release on npm: `npx vetobench`.

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
