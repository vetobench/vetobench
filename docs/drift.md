# vetobench drift

## What it does

`vetobench drift` shows who approved your coding agent's actions, week by week, and how each share moved against the week before. For each week (Monday to Sunday, UTC) it prints:

- **Decisions:** tool calls with a recorded permission decision.
- **Who approved:** the share approved by static allow-rules (single command, compound command and other static, grouped as on the card), the share approved by the AI classifier, and how many actions you approved through a permission prompt.
- **Blocks:** how many actions the AI classifier blocked, a safety check blocked, and you rejected or cancelled.
- **Where the agent ran:** the share of decisions made inside subagents and inside loops (`/loop`, `/goal`).
- **Change:** for each share, the difference from the week before in percentage points, marked ▲ (up), ▼ (down) or = (unchanged).

Below the tables, a summary compares the last week shown with the week before: how many actions you approved in each, and whether the static-rule share went up or down. It also gives the static-rule share of the earliest week with decisions. All of these are computed from the counts in the table. They show what moved, not why.

With `--asks`, it also counts how often the built-in policy of `vetobench replay` would have asked, per week.

## Usage

```
npx vetobench drift [transcripts-dir] [--weeks N] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--asks] [--json | --md]
```

| Option | Effect |
|---|---|
| `transcripts-dir` | Default: `~/.claude/projects` |
| `--weeks N` | How many weeks to show, ending with the current one. Default 8, at most 520 |
| `--since YYYY-MM-DD` | Start the window on this UTC day. Without `--weeks`, every week from that day on is shown |
| `--until YYYY-MM-DD` | End the window before this UTC day (exclusive). The window never runs past today |
| `--asks` | Also count the built-in replay policy's asks per week. This is a second pass over the transcripts, so it is slower |
| `--json` | Counts, shares and changes as JSON |
| `--md` | The table as markdown, to paste into an issue |

Example, from synthetic transcripts:

```
vetobench 0.2.0 drift: who approved your agent's actions, week by week
6 weeks · 2026-10-19 to 2026-11-25 (UTC, weeks start on Monday) · 4,413 recorded decisions · 3 transcripts

Who approved the agent's actions:
  Week of        Decisions   Static rules   AI classifier   You
  2026-10-19             0   -              -                 0   no recorded decisions
  2026-10-26           986    73.0%          26.4%            3
  2026-11-02         1,029    76.8% ▲3.8     22.4% ▼4.0       5
  2026-11-09         1,017    66.9% ▼9.9     32.4% ▲10.0      2
  2026-11-16         1,039    61.6% ▼5.3     37.5% ▲5.1       1
  2026-11-23 *         342    58.5% ▼3.1     40.9% ▲3.4       1

Blocks, and where the agent ran:
  Week of        Blocked: classifier   safety   you   In subagents   In loops
  2026-10-19                       0        0     0   -              -
  2026-10-26                       2        0     1    52.7%           6.1%
  2026-11-02                       3        1     0    46.6% ▼6.1      3.9% ▼2.2
  2026-11-09                       4        0     1    60.0% ▲13.4     2.0% ▼1.9
  2026-11-16                       6        2     0    67.4% ▲7.4      0.0% ▼2.0
  2026-11-23 *                     1        0     0    67.3% ▼0.1      0.0% =

* partial week: 2026-11-23 to 2026-11-25, 3 of 7 days so far.
▲/▼: change in percentage points against the week before.
No recorded decisions before 2026-10-26 in this window. A week can be empty because its transcripts were deleted (cleanupPeriodDays, 30 days by default), because Claude Code did not record decisions yet (before about v2.1.306), or because the agent did not run.

Human approvals: 1 this week (3 of 7 days so far), 1 last week.
Static-rule share: 58.5% this week, down 3.1 points on last week (61.6%); 73.0% in the week of 2026-10-26, the earliest shown with decisions.

Counts and shares only: they show what moved, not why. Approvals given in chat are not counted. Nothing left this machine.
```

## How it works

- **One scan.** drift uses the card's scanner (`scanAll` in `src/analyze.js`) once. The scanner counts each tool call once, even when a resumed session copied it into another transcript, and keeps per-day totals of decisions, gates and shapes, by the UTC day of the tool result. drift adds those days up into weeks. It reads no settings files and does no rule attribution.
- **Gates and shapes** are the card's (see METHODOLOGY.md, "Gates" and "Where the agent was running"). Static rules are the single-command, compound-command and other static gates together. The denominator of every share is all recorded decisions that week, blocks and answers to the agent's own questions included, as on the card. Answers are never counted as your approvals.
- **Weeks** are ISO 8601 weeks: they start on Monday at 00:00 UTC. `--json` also gives each week's ISO label (`2026-W48`).
- **The window** ends today (UTC), or on the day before `--until`. The last week shown is the week that holds that day, and `--weeks` counts back from it. `--since` moves the start later; given alone, it sets the start.
- **Partial weeks** are weeks the window covers for fewer than 7 days: usually the current week, and a first week that `--since` cuts. The text marks them with `*` and a line that gives their days, the markdown says "partial: n of 7 days", and `--json` sets `partial: true` with `days`.
- **Empty weeks** have no recorded decisions. Their shares are `-`, and no change is computed against them, so the week after an empty week shows no change either. When empty weeks come before the first recorded decision, a note gives that day, and how many days of its week the data covers.
- **Changes** are computed from the shares as shown: each share is rounded to 0.1% first, and the change is the difference of the two rounded shares. So every change can be checked against the two numbers it compares.
- **`--asks`** runs `scanReplay` from `src/replay.js` with the built-in policy (the policy of `vetobench replay` without `--policy`) over the same window, and adds up its asks per UTC day of the shell command into the same weeks. It reads the command text in memory, as replay does, and prints only counts.
- **`--json`** gives, for each week: `week`, `start`, `end`, `from`, `to`, `days`, `partial`, `empty`, `decisions`, the counts `static`, `classifier` and `human`, `blocked` (`classifier`, `safety`, `human`, `other`), `shapes` (`interactive`, `loop`, `graph`), `gates` (the count per gate), `share` and `change` (percent and percentage points, one decimal, `null` when there is nothing to compute), and `asks` with `--asks`. `summary` holds the numbers behind the summary lines, and `window` the dates used, today's UTC date included, so a run can be repeated with `--since` and `--until`.

## Limits

- **Weeks are in UTC.** Late-evening work west of UTC (or early-morning work east of it) can fall on the next or previous UTC day, and so in another week than on your calendar.
- **Few decisions, large swings.** A week with a few dozen decisions can move a share by many points. Read the Decisions column before reading a change.
- **A partial week** compares a few days with a full week. The shares can be compared; the counts (decisions, your approvals, blocks, asks) cannot.
- **History is short by default.** Claude Code deletes transcripts after `cleanupPeriodDays` (30 days by default), so with the default only about four full weeks have data. Claude Code records decisions from about v2.1.306 onward. Weeks before that are empty.
- **The first week with data** can be cut by retention: transcripts deleted midway through a week leave only its later days. The note on empty weeks says how many days that week covers.
- **Loops label a whole session.** A session that ran `/loop` or `/goal` counts as a loop in every week it has decisions, including the turns before the loop started.
- **Two kinds of day.** Decisions are counted by the day of the tool result, asks by the day of the tool call. A call made just before midnight UTC whose result came after it falls on different days in the two counts.
- **The card's limits apply:** approvals given in chat are invisible; one open issue reports `user_temporary` logged without a visible prompt, which would inflate your approvals; the `permissionDecision` field is undocumented and may change.
- **No causes.** drift says what changed and by how much. Whether a new rule, a new project, a switch to auto mode or something else moved a share is for you to judge.
