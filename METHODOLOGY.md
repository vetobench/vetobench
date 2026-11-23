# Methodology

## Data

Claude Code writes one JSONL transcript per session under `~/.claude/projects/` (subagents get their own files). From about v2.1.306, each tool-result record carries an undocumented `permissionDecision` object: `decision` (accept / reject / cancelled), `source` (config, user_temporary, user_reject, user_abort, …) and a reason (`reasonType` or `reasonCode`: rule, subcommandResults, classifier, mode, safetyCheck, …). vetobench reads only those fields, the tool name of the matching tool call, the timestamp and the version.

Transcripts are deleted after `cleanupPeriodDays` (default 30). Fix the window with `--since` / `--until` so a run can be repeated.

## Gates

| Gate | Rule |
|---|---|
| Static allow-rule (single command) | accept, reason `rule` |
| Static allow-rules (compound command) | accept, reason `subcommandResults`: each part of a compound shell command matched |
| Other static | accept with no reason recorded (mostly read-only tools) |
| Permission mode | accept, reason `mode` |
| AI classifier | accept, reason `classifier` (auto mode) |
| You, through a permission prompt | accept with a `user_*` source, for any tool except `AskUserQuestion` |
| Answer to the agent's question | a `user_*` decision on `AskUserQuestion`. **This is not counted as an approval** |
| Blocked | reject by the classifier, a safety check, or you |

## Where the agent was running

Each decision is also counted by where the agent was running when it was made.

| Where | Rule |
|---|---|
| Main sessions (interactive) | a main-session transcript that never started a loop |
| Loops | a main session that ran `/loop` or `/goal`, or called `ScheduleWakeup` or `CronCreate`. This labels the whole session, so turns before the loop started count as loop too |
| Inside subagents | a subagent's own transcript (`…/subagents/*.jsonl`), or a record marked `isSidechain` |

Tool definitions inside API-request records are ignored: they list every tool, so matching on them would mark every session as a loop. `/schedule` is not counted as a loop: it creates a cloud routine that runs elsewhere and leaves no local transcript. Subagents started from a loop count as subagents.

## Wildcard attribution

Which allow-rule approved a shell command is not recorded, so vetobench reconstructs it. The method is a port of the analysis behind CLAIMS #4, kept exact so that number can be replayed.

- **Examined:** Bash calls whose gate is a static allow-rule (single or compound). The command is read from the matching tool call, matched in memory and dropped. Only counts and the fixed family names are kept.
- **Rules:** `Bash(...)` entries in `permissions.allow`. By default these come from the same files as the rules line: `~/.claude/settings.json`, plus `.claude/settings.json` and `.claude/settings.local.json` in the current directory. `--rules FILE` (repeatable) uses the given files instead, so you can pass the settings that were in effect. Rules from all files are pooled and applied to every transcript.
- **Splitting:** heredoc bodies are removed, then the command is split on `&&`, `||`, `;`, `|` and newlines. The split ignores quotes. Leading `VAR=value` assignments are stripped, and empty or comment parts are skipped.
- **Matching:** `x:*`, `x *` and `x*` are prefix rules, compared as plain string prefixes. Other rules must match exactly. A prefix rule is a **wildcard interpreter/remote rule** when its prefix is one of the fixed names in `BROAD` (`src/analyze.js`: `python3`, `bash`, `node`, `ssh`, `curl`, `git`, …).
- **Relied on a wildcard:** at least one part matched a wildcard rule and no other rule. The family is that rule's prefix, or the longest one if several match. An action that relied on two families counts under both, so the family counts can add up to more than the total.

Choices that can only lower the count:
- A part that also matches a non-wildcard rule counts as specific, because that rule alone would have approved it.
- Decisions with a `user_*` source are left out even when they name a rule. The original analysis counted them.
- A part that no rule matches (Claude Code's built-in read-only commands, or a parser difference) never counts as a wildcard.

A known source of over-counting: plain prefixes are wider than Claude Code's `:*` and ` *` rules, which match at a word boundary (`sh:*` does not approve `shasum`). `--json` also reports `wildcard.wordBoundary`, the same count with the word boundary applied. The two can differ in either direction (`npm run test:*` covers `npm run test:unit` only as a plain prefix), and the gap shows how much the number depends on this choice.

## Known limits

- **Approvals given in chat** ("go ahead", "post it") are invisible to this field and not counted.
- The field is undocumented and may change without notice. One open issue reports `user_temporary` logged without a visible prompt; check it on your own corpus before quoting the human count.
- Rule attribution (which allow-rule approved a command) is reconstructed, not recorded (see Wildcard attribution). By default it uses your *current* settings. For an older window, pass the settings that were in effect with `--rules`.
- This is one harness. Other agents record approvals differently or not at all.
