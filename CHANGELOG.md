# Changelog

Notable changes to vetobench, newest first. Versions follow [Semantic Versioning](https://semver.org/).

Corrections to published numbers go here as **retractions**: the claim as published, the corrected number, why it was wrong, and the [CLAIMS.md](CLAIMS.md) line it affects. That line stays in CLAIMS.md, marked retracted, so the record stays complete.

## Unreleased

### Added

- `vetobench headless [dir] [--since] [--until] [--json | --md]`: how much of your agent's work ran headless (`claude -p`, the Agent SDK, the GitHub Action), who approved it there, and how often it was refused because a prompt would have been shown and no one could answer it. Sessions are split by the `entrypoint` marker on each user and assistant record (interactive, headless, unknown; an unknown value is never guessed). For headless runs: decisions by gate (static rules, permission mode, classifier, hook, a prompt answered through the SDK, every kind of block), and refusals for want of an approver by cause (a hook asked, an ask rule matched, a safety check asked, the classifier gave no verdict, no rule allowed it), including how many were inside subagents. A short "what this means" footer of fixed text. The refusal shape was tested with Claude Code 2.1.332 in `claude -p` for a hook's ask and for a call no rule allowed; the other causes come from reading Claude Code's code (see docs/headless.md). Fixed labels and counts only; CI runs it with networking off.
- Owners in the `replay` and `hook` policy: an optional `owners` list, like a CODEOWNERS file for actions. Each entry names an `owner` (1 to 40 letters, digits, spaces and `. _ @ # / & + -`; known key and token shapes are refused) and selects asks by `hosts` and `branches` (the `*` patterns the policy already uses, at most two `*` each), `categories`, or `contains` (plain text found anywhere in the command, case ignored). The first entry that selects an ask wins. Owners never add an ask: they only label one the policy already makes, and the label is not an authorisation. The hook's reason then names the owner (`vetobench policy: SQL write to a non-local database (owner: data team)`); `replay` counts asks per owner and asks without one (text and `--json`: `asksByOwner`, `asksWithoutOwner`); `hook install` and `hook test` count the owner entries. Owner matching uses no regular expression (substring search and `*` patterns matched part by part), so there is nothing for a crafted command to make backtrack: a `match`, `flags` or `anywhere` in an owners entry is an error that says to use `contains`. Inputs are bounded as well: owners are looked up only for commands up to 4,096 characters, at most 32 distinct hosts and 32 distinct branches of a command are compared, and a policy holds at most 64 entries, each with at most 16 host and branch patterns of at most 64 characters and 8 `contains` strings. An error only in `owners` makes `hook run` drop the owners and still ask, unlabelled (`hook test` warns), where any other policy error still fails open. Without owners, the output is unchanged (three `--help` lines now mention owners). Owners need this release: 0.3.0 and older reject a policy with `owners` as an unknown field, so a hook installed from one fails open; `vetobench hook test` warns when the installed hook runs an older vetobench than the one testing it. Format in METHODOLOGY.md ("Owners").

### Fixed

- `hook run` let a crafted command through without an ask. A chain of assignments that each double a variable (`A=x; A=$A$A; …`, thirty times) made `$NAME` expansion build a string longer than the JavaScript engine allows; the parser threw, the hook printed nothing (it fails open), and a `git push origin main` at the end of the same command ran without a prompt. `replay` counted that command's whole transcript as unreadable. Expansion is now bounded: a word grows by at most 4,096 characters and a command line by at most 65,536 in all, and at most 256 variables are tracked; a reference past these stays as written and the rest of the command is checked, so the push behind the chain is asked about again. Since the value left out could itself be the command, a branch or a verb (`eval "$C"`, `git push origin $B`), a command with a value left out is always asked about: in the categories that matched, or as `unchecked` when none did.
- Other shapes that grew or looped with the size of the command are bounded by counts too: nesting (12 levels, as before, but a command nested deeper is no longer passed over in silence), simple commands (10,000), heredocs (1,024, with delimiters of up to 64 characters) and text read (16 MiB, nested commands and the heredoc bodies handed to commands included). Before, a heredoc body that names itself, a script that runs itself through `bash -c "$X"`, many heredocs that never close, many variables copied into each of many commands, or a host or URL of many slashes ending in a line break could run past the hook's timeout or out of memory. Heredocs are now cut, and hosts and paths trimmed, in linear time, with the same results as before, but for one intended change: the `<<` that ends a here-string's `<<<` no longer opens a heredoc (`cat <<<EOF` followed by a line `EOF` used to cut the lines between them out as a heredoc body).
- A command that goes past one of those limits, or whose check throws (a `rules` or `ignore` pattern of your policy included), is no longer let through: the hook asks with the fixed reason `vetobench policy: Command vetobench could not check`, without an owner, and `replay` counts it in the new category `unchecked` instead of marking its transcript unreadable. Errors about the setup (bad input, an unknown option, a policy file that cannot be used, input over 8 MB or too slow to arrive) still make the hook fail open, as documented. No command in the test fixtures reaches the new category, and every output on them is unchanged. Format in METHODOLOGY.md ("Bounds").
- A policy rule that begins with something that matches whitespace (`\s*zzz`, `[\s\S]*zzz`, `.*zzz` with `s`) could run past the hook's timeout on a long run of line breaks, after which Claude Code runs the command unchecked. The anchor that makes a rule start at a command start had blanks (`\s`) that also match line breaks, though a line break is itself a command start, so the anchor and the rule shared each run of line breaks in very many ways. The anchor's blanks are now `[^\S\n]`: a rule matches exactly the commands it matched before. That removes one slow shape, not every one: a rule can still take long on other long runs (blanks, or `NAME=value;` repeated), and a regular expression cannot be stopped once it runs. So your `rules` and `ignore` patterns now run only on text of up to 64 KiB (rules on the command with heredoc bodies cut out). On longer text the rules are left out, and the command is asked about in the built-in categories that match, or as `unchecked` when none do; ignore patterns skip no command that long. METHODOLOGY.md ("Policy file") now shows the anchor and why rules and ignore patterns should stay few and simple.

## 0.3.0 (2026-11-27)

### Added

- `vetobench hook test [--project]`: checks an installed hook end to end without starting Claude Code, and only reads. The settings file, the vetobench handler, its matcher and its fields, the command's shape, that its node and vetobench paths still exist, which version it runs (one without `hook` fails), that its policy file loads, that the policy asks before a made-up push to main and stays silent on a harmless command, and settings that stop hooks (`disableAllHooks` by precedence, managed `allowManagedHooksOnly`, `CLAUDE_CONFIG_DIR`), plus a note for a `bypassPermissions` or `dontAsk` default mode. When the managed settings' vetobench hook is the one that runs, it tests that one. Fixed labels only; exits 1 when a check fails or could not run. CI runs it with networking off, after the install and after the uninstall.

### Docs

- `docs/hook.md`: tested how the hook's "ask" meets Claude Code's permissions (Claude Code 2.1.332, headless). A matching allow-rule did not override it, nor did `bypassPermissions`; `dontAsk` turns it into a denial. The interactive dialog itself was not observed. Replaces the "the documentation does not say" caveats.
- `docs/hook.md`: also tested inside subagents (foreground and background): the hook runs for their shell commands and its ask holds them, as in the main session.
- README: links to vetobench.com, the methodology page and the claims ledger.

### Changed

- The npm package's homepage is now https://vetobench.com.

## 0.2.0 (2026-11-25)

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
