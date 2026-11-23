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

## Known limits

- **Approvals given in chat** ("go ahead", "post it") are invisible to this field and not counted.
- The field is undocumented and may change without notice. One open issue reports `user_temporary` logged without a visible prompt; check it on your own corpus before quoting the human count.
- Rule attribution (which allow-rule approved a command) is reconstructed, not recorded. vetobench reports wildcard rules in your *current* settings; historical attribution needs your old settings.
- This is one harness. Other agents record approvals differently or not at all.
