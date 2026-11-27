# `vetobench headless`: who approved your agent's actions when no one could answer a prompt

## What it does

More and more coding agents run headless: `claude -p` in a script or a cron job, an app built on the Agent SDK, a CI job. Nobody is there to answer a permission prompt. When Claude Code would ask, the call is refused instead, and the agent reads the reason and carries on without it. The card (`npx vetobench`) counts who approved your agent's actions overall, but it does not separate those runs from the ones you watched.

`vetobench headless` does:

- **How your sessions ran.** Sessions with a recorded decision, split into interactive, headless and unknown by the run marker Claude Code writes on every transcript record (see [The run marker](#the-run-marker)), with their decisions and a one-line comparison: the static-rule share, the classifier share, the prompts you answered, and the refusals for want of an approver.
- **Who decided in headless sessions.** Static allow-rules, the permission mode, the AI classifier, a hook, a prompt answered by the program running the agent, and every kind of refusal.
- **Refused because no one could approve.** The calls that would have shown a permission prompt, by cause: a hook asked, an ask rule matched, a safety check asked, the classifier gave no verdict, no rule allowed it. Also how many of them were inside subagents.
- **What this means.** A few lines of fixed text, chosen by which counts are not zero: what a refusal costs a headless job, and what to do about it.

Everything printed is a count, a share, a date, a checked Claude Code version or a label defined in code. No command, path, prompt, session id, recorded reason or marker value is ever printed.

## Usage

```
npx vetobench headless [transcripts-dir] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--json | --md]
```

| Option | Effect |
|---|---|
| `transcripts-dir` | Default: `~/.claude/projects` |
| `--since` / `--until` | Window by UTC day (until is exclusive), as for the card |
| `--json` | The counts as JSON. The shape is stable: every run kind, gate and cause is present, zeros included |
| `--md` | The tables as markdown, to paste into an issue |

Example, from the synthetic transcripts in `test/fixtures/headless/` (made-up numbers). From a clone of the repository:

```sh
node bin/vetobench.js headless test/fixtures/headless
```

```
vetobench 0.3.0 headless: who approved your agent's actions when no one could answer a prompt
7 transcripts · 2026-11-12 to 2026-11-20 · 24 of 24 tool calls carry a recorded decision

How your sessions ran (sessions with a recorded decision):
  Interactive  1 session    6 decisions    25.0%   rules 16.7% · classifier 16.7% · you 1 · no one could approve 1
  Headless     2 sessions  15 decisions    62.5%   rules 26.7% · classifier 6.7% · no one could approve 5
  Unknown      2 sessions   3 decisions    12.5%   rules 66.7% · classifier 0.0% · prompts answered 0 · no one could approve 1

In headless sessions (Claude Code 2.1.331 to 2.1.332), who decided:
  Static allow-rules                                 4    26.7%
  Permission mode                                    1     6.7%
  AI classifier                                      1     6.7%
  A hook allowed it                                  1     6.7%
  Answered through the SDK or a prompt tool          1     6.7%
  Refused: no one could approve                      5    33.3%
  Blocked by the AI classifier                       1     6.7%
  Refused by the permission mode                     1     6.7%

Refused because no one could approve: 5 (1 inside subagents)
  A hook asked                  2
  An ask rule matched           1
  A safety check asked          1
  No rule allowed it            1

What this means:
  A headless job silently loses these 5 actions: no one sees a prompt, and the agent reads the refusal and carries
    on without them.
  If the job needs them, allow them for that job only (an allow-rule in the settings it runs with, --allowedTools,
    or a file passed with --settings), or run that task interactively.
  2 of them came from a hook that asked: in a headless run its ask is a refusal. Keep it where the job should
    never run those commands unattended.
  1 of them happened inside subagents, where the main session sees only the subagent's report.
  1 headless action ran on the permission mode alone (such as bypassPermissions or acceptEdits), not on a rule or
    the classifier.
  In interactive sessions, 1 action was refused because no prompt could be shown for it (as in a background
    subagent).
  2 sessions with 3 decisions carry no run marker vetobench knows, so they are counted as unknown, not guessed.

Counts only: no command, path, prompt or marker value is printed. Nothing left this machine.
```

## How it works

`headless` runs the same scan as the card (`scanAll` in `src/analyze.js`), so each tool call is counted once, the window means the same, and a resumed session's copies are skipped. For each counted decision, the scanner hands `src/headless.js` the recorded `permissionDecision`, the record's run marker, its session id, its Claude Code version and whether it ran inside a subagent. These stay in memory; only counts are kept.

### The run marker

Every transcript record Claude Code writes carries an `entrypoint` field. It holds `CLAUDE_CODE_ENTRYPOINT`, which Claude Code sets when it starts, unless the program that started it already did: `cli` for the terminal app, `sdk-cli` in print mode (`claude -p`; in print mode a preset `cli` becomes `sdk-cli` too), `claude-code-github-action` when `CLAUDE_CODE_ACTION` is set, and `mcp` for `claude mcp serve`. Its code names `sdk-ts` and `sdk-py` for the TypeScript and Python Agent SDKs, and it treats `sdk-cli`, `sdk-ts` and `sdk-py` as SDK sessions: it leaves them out of the `/resume` list. All of this was read in Claude Code 2.1.332's own code; the `claude -p` runs below recorded `sdk-cli` on every record.

| `entrypoint` | Counted as | Seen in a transcript |
|---|---|---|
| `cli` | Interactive | yes |
| `claude-vscode`, `claude-desktop` (the VS Code extension and the desktop app, which show prompts) | Interactive | no |
| `sdk-cli` (`claude -p`) | Headless | yes |
| `sdk-ts`, `sdk-py` (the Agent SDKs) | Headless | no |
| `claude-code-github-action` (set when `CLAUDE_CODE_ACTION` is) | Headless | no |
| any other value (`mcp`, the `remote` family, `local-agent`, ...) or no field | Unknown | |

- **Per record.** Each decision is classified by the marker on its own record, never by a neighbour's. A record without a known marker is counted as unknown, not guessed. `--json` splits unknown into `noMarker` and `otherMarker`.
- **Sessions.** A session is a session id; a subagent's records carry the id of the session that started it, so a subagent belongs to its main session. A record with no session id counts its transcript as the session. A session is counted once, under the run kind of its first counted decision; `mixedSessions` in `--json` counts sessions whose later decisions carry another kind (none on the author's machine).
- **Versions.** The run marker is on every record of every Claude Code version left on the author's machine (2.1.306 to 2.1.332; older transcripts were deleted by retention), and only `cli` and `sdk-cli` occur there. Permission decisions are recorded from about 2.1.306, so a decision without a marker is not expected from Claude Code: it most likely comes from a transcript written or edited by another tool.

### Refused because no one could approve

When Claude Code would show a permission prompt and the run cannot show one, it records the call as `"decision": "reject"`, `"source": "config"`, **no** `reasonType`, and a `reasonCode` that says why it would have asked. This is what vetobench counts as "Refused: no one could approve". Blocks that carry a `reasonType` (the classifier, a safety check, a hook's deny, the permission mode) are not prompts, and they are counted as their own gates.

Tested on 2026-11-26 and 2026-11-27 with Claude Code 2.1.332: headless `claude -p` runs with the settings passed through `--settings` and `--setting-sources local`, each asking the agent to create a file in an empty folder, with the transcript kept. The ask hook was the same stub as in [docs/hook.md](hook.md#what-was-tested-in-claude-code).

| Setup | Outcome | Recorded `permissionDecision` |
|---|---|---|
| No rule, no hook, a `touch` through Bash | Refused | `reject`, `config`, `reasonCode: "unknown"` |
| No rule, no hook, the Write tool | Refused | `reject`, `config`, `reasonCode: "unknown"` |
| Allow-rule, plus a hook that answers `"ask"` | Refused | `reject`, `config`, `reasonCode: "hook:PreToolUse"` |
| The same, the command run by a subagent, in the foreground or in the background | Refused | the same, in the subagent's own transcript |
| The same subagent setup with a hook that only logs (control) | Ran | `accept`, `config`, `reasonType: "subcommandResults"` |

The tool result is an error that holds the hook's reason or Claude Code's "needs approval" message; vetobench never reads it.

From Claude Code 2.1.332's own code, not yet seen in a transcript:

- **Where Claude Code avoids prompts by design** (a background agent, or "no approval surface in this session"), it denies an ask with `reasonType: "asyncAgent"` (and the ask's `reasonCode`). vetobench counts it as refused because no one could approve, in whatever run it happens. In an interactive session, the footer reports these on a line of their own.
- **A hook that answers `"deny"`** is recorded with `source` and `reasonType` `"hook"`: "Blocked by a hook". A hook that answers `"allow"` is "A hook allowed it". The card counts both under its other static and other blocked gates.
- **`dontAsk` mode** refuses what would ask with `reasonType: "mode"`: "Refused by the permission mode". It is listed apart, because you chose that mode, but the job loses the action just the same.
- **An answer from the program running the agent** (the Agent SDK's `canUseTool` callback, or `--permission-prompt-tool`) is recorded with a `user_*` source, like your own answer at a prompt. In a headless session it is labelled "Answered through the SDK or a prompt tool", because it is not you at a terminal (it may be a person in that program's own interface).

### Causes

The `reasonCode` of a refusal for want of an approver gives its cause. A compound shell command records `subcommands:` and the codes of its parts joined by `+`; the most specific part wins, in the order of this table. The code itself is never printed.

| Cause | `reasonCode` |
|---|---|
| A hook asked | `hook:…` (`hook:PreToolUse`) |
| An ask rule matched | `rule:…` (an ask rule in `permissions.ask`, by the settings file it came from) |
| A safety check asked | `safetyCheck`, `workingDir`, `outsideReadsBlocked`, `outsideWritesBlocked`, `noConfigHome`, `sandboxOverride`, or a `circuitBreaker` field (a sensitive file, a path outside the working folders) |
| The AI classifier gave no verdict | `classifier:…` (auto mode could not decide, so it would have asked) |
| No rule allowed it | `unknown`, `mode:…`, `bashMiss:…`, `subcommandResults` |
| Other | anything else |

### Who decided

The gates refine the card's (see [METHODOLOGY.md](../METHODOLOGY.md#gates)). Static allow-rules are the card's three static gates without hook approvals; the refusals for want of an approver, hook blocks and permission-mode refusals come out of the card's "Blocked, other". Over the same window the gates add up to the card's totals; a test checks it.

### Inside subagents

As on the card, a decision is inside a subagent when it is in a subagent's own transcript (`…/subagents/*.jsonl`) or its record is marked `isSidechain`. A subagent's refusal reaches the main session only through the subagent's final report.

## Limits

- **Only runs that keep a transcript.** `claude -p --no-session-persistence` (and an SDK app that turns persistence off) writes none, so those runs are invisible. A CI runner's transcripts live on the runner and are gone with it: run `npx vetobench headless --json` as a step in the job to see them.
- **Not every marker value was seen.** On the author's machine only `cli` and `sdk-cli` occur. The other values in the table come from Claude Code's own list and were not tested, and Claude Code can add or rename values in any release. An unknown value is counted, never guessed.
- **The fields are undocumented.** `permissionDecision` and its `reasonCode` can change without notice. The shapes above were tested on one version (2.1.332).
- **A refusal is not a failed job.** The agent may find another way, or the task may not have needed the action. vetobench counts refusals, not lost work.
- **Headless is not the same as unattended.** An app built on the Agent SDK can show its own prompts through `canUseTool`; those answers count as "Answered through the SDK or a prompt tool".
- **Approvals given in chat do not appear,** just as on the card.
