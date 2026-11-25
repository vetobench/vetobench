# `vetobench graph`: who approved your agent's actions, day by day

## What it does

`vetobench graph` writes one HTML page that shows the card over time. Open it in any browser, on a laptop or a phone.

- **Header:** the card's three numbers (the share approved by static allow-rules, the share approved by the AI classifier, and the number of actions you approved through a permission prompt), the number of recorded decisions, the date range and the Claude Code versions.
- **Who approved each action, over time:** a stacked bar per UTC day of the recorded decisions (per bucket of whole weeks when the window is longer than 92 days), by gate: static rules, AI classifier, blocked, you, and "other" (permission mode, and your answers to the agent's own questions) when there are any. Approvals by you and blocks are usually far too few to see in a bar, so a row of dots under the bars marks each day that had one.
- **Where the agent was running:** the same decisions per day (or bucket), split into main sessions, loops (`/loop`, `/goal`) and subagents.
- **Totals by where the agent ran:** each shape's decisions, its share of all decisions, its number of transcripts, and its split between static rules, the classifier and you, as on the text card.

Hover over or tap a day to see its numbers. Under each chart, "The numbers" opens the same data as a table, with a total row.

The page holds counts, shares and dates only: no commands, paths, project names, prompts, rule bodies or secrets. Look it over before you share it.

## Usage

```
npx vetobench graph --html FILE [transcripts-dir] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--force]
```

| Option | Meaning |
|---|---|
| `--html FILE` | write the page to FILE (required) |
| `--force` | replace FILE if it exists; without it, vetobench refuses and changes nothing |
| `transcripts-dir` | default: `~/.claude/projects` |
| `--since` / `--until` | window by UTC day (until is exclusive), as for the card |

For example:

```sh
npx vetobench graph --html vetobench-report.html
npx vetobench graph --html november.html --since 2026-11-01 --until 2026-12-01
```

The terminal gets two lines: the number of days (or bars) and decisions, with how many decisions were not drawn and how many transcripts could not be read when there are any, and then a reminder to look the page over before you share it. It never prints the file's path.

## How it works

`graph` runs the same scan as the card (`scanAll` in `src/analyze.js`), so each tool call is counted once and every gate and shape means what [METHODOLOGY.md](../METHODOLOGY.md) says. The scanner also keeps a count per UTC day (`byDay`: decisions, gates and shapes), and `src/graph.js` draws the page from those counts.

- **The window** runs from the first to the last day with a tool call. Days without a recorded decision are drawn empty, not skipped.
- **Only plausible days are drawn.** The charts draw days from 2025-01-01 (Claude Code was first released in 2025) to the day the page is made, in UTC. A decision dated outside that range, such as a forged or corrupted timestamp in 1970 or 2099, is not drawn, so it cannot stretch the chart into years of empty bars; the window then ends at the last day inside the range. The page says how many decisions were left out this way, and how many carry no valid timestamp at all. Both still count in the numbers at the top, as on the card, and the date range in the header is the card's (first to last tool call), so it can show such a date.
- **The bars add up.** Static rules are the card's three static gates together (single command, compound command, other static). Blocked is every rejection: by the classifier, a safety check, you, or anything else. Each bar is its day's recorded decisions, and each table's total row equals the totals on the card, less the decisions that are not drawn.
- **Nothing to draw.** When none of the recorded decisions has a day the chart can draw, the page says how many there are and why, in place of the charts, and still shows the totals by where the agent ran.
- **Unreadable transcripts** (for example, deleted by retention while the scan ran) are skipped; the footer gives their number.
- **Long windows** (more than 92 days) are drawn in buckets of whole weeks, so a bar never gets too thin to see on a phone. The tables then have one row per bucket.
- **One self-contained file.** The charts are inline SVG made in Node. The page has no external scripts, fonts, images or links. A short inline script shows the hover labels, and its text comes only from the page itself. The page's Content-Security-Policy (`default-src 'none'`, with hashes for its one style block and its one script) makes the browser refuse any request the page might try.
- **Light and dark** follow the system setting (`prefers-color-scheme`), in the vetobench colours. The layout fits a 375 px wide screen without scrolling sideways.
- **The file is written once,** with an exclusive create, so an existing file is never replaced unless you pass `--force`. Error messages name the error code only, never the path.

## Limits

- **Days are UTC.** A late-evening session in a timezone west of UTC lands on the next day.
- **Approvals given in chat do not appear,** just as on the card: only permission decisions recorded in the transcripts are counted.
- **A decision with no valid timestamp, or dated before 2025 or after today (UTC),** counts in the header but is not drawn; the page says how many there were. A transcript copied from a machine whose clock runs ahead can land after today.
- **Loops are labelled per session.** A session that ran `/loop` or `/goal` counts as a loop from its first turn, so its earlier days show as loop days too.
- **Week buckets start on the window's first day,** not on a Monday, and the last bucket can be shorter than seven days (its hover label says how long).
- **Hover labels need JavaScript.** Without it, the tables under the charts hold the same numbers.
- **On a narrow screen** an opened table with many columns scrolls sideways inside its box; the page itself does not.
