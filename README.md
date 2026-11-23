<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo/lockup-dark.svg">
    <img alt="vetobench" src="assets/logo/lockup-light.svg" width="360">
  </picture>
</h1>

**Who approved your coding agent's actions?**

Coding agents now run hundreds of tool calls an hour. Almost none of them are approved by a person. They are approved by allow-rules you clicked months ago, or by an AI classifier. vetobench shows you the split for your own agent, from transcripts already on your machine. It is also building an open benchmark of how often agent permission guards are wrong on real traffic.

> Status: pre-release. The CLI below works locally; the npm package and the benchmark are not published yet.

```
npx vetobench
```

```
vetobench 0.0.1: who approved your agent's actions
1,744 transcripts · 2026-10-22 to 2026-11-20 · 236,734 of 237,087 tool calls carry a recorded decision

  Static allow-rules (compound command)                 116,860    49.4%
  AI classifier                                          63,308    26.7%
  Static allow-rule (single command)                     52,412    22.1%
  ...
  You, through a permission prompt                           12   0.005%

Static rules approved 72.7%, the AI classifier 26.7%, you 12 action(s).

Where the agent was running:
  Main sessions (interactive)     67,118    28.4%   rules 70.6% · classifier 28.1% · you 12
  Loops (/loop, /goal)             5,880     2.5%   rules 73.4% · classifier 26.1% · you 0
  Inside subagents               163,736    69.2%   rules 73.5% · classifier 26.2% · you 0
```

## Principles

- **Nothing leaves your machine.** No network code ships, and CI enforces it: a test rejects any network-capable module or API, and the CLI runs in a sandbox with networking off.
- **Counts only.** The output never contains commands, file paths, prompts, rule bodies or secrets, so a card is safe to paste publicly.
- **Zero dependencies, no install scripts.** Read the source in `bin/` and `src/` in a few minutes.
- **Every number is reproducible.** See [METHODOLOGY.md](METHODOLOGY.md) and [CLAIMS.md](CLAIMS.md).

## Options

```
npx vetobench [transcripts-dir] [options]

  --since / --until YYYY-MM-DD   window by UTC day (until is exclusive)
  --rules FILE                   match approvals against this settings file's allow-rules instead of your
                                 current ones (repeatable: use the settings that were in effect for the window)
  --secrets                      also count passwords, keys and tokens left in your transcripts (slower)
  --json                         aggregates as JSON (counts only)
  --md / --share / --svg FILE    share formats, see below

npx vetobench replay [transcripts-dir] [--since] [--until] [--policy FILE] [--json]
```

The default directory is `~/.claude/projects`. Each tool call is counted once, even when a resumed session copied it into another transcript. Claude Code records a permission decision for each tool call from about v2.1.306 onward.

## Share your card

```
npx vetobench --md               # the card as markdown
npx vetobench --svg card.svg     # also write a 1200×630 image for posts (--force replaces the file)
npx vetobench --share            # the markdown, then a link to a prefilled "Submit your card" issue
```

Every format holds counts, shares, dates and version strings only. vetobench never opens the link and sends nothing: read the card, then open the link yourself. Most social sites want PNG, so open the SVG in a browser and screenshot it, or convert it with any SVG tool.

## Replay a guard policy

```
npx vetobench replay [transcripts-dir] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--policy file] [--labels file] [--json]
```

Replays an "ask before production writes, CI triggers and pushes to main" policy against the shell commands your agent actually ran. It prints how often the policy would have asked, per category: pushes to main, CI triggers, remote writes over ssh, SQL writes to non-local databases, Kubernetes, Terraform, cloud changes and more. Put your own hosts, protected branches and extra rules in a JSON file and pass it with `--policy`. Pass your own verdicts with `--labels` to count right and wrong asks. The format is in [METHODOLOGY.md](METHODOLOGY.md#replay-vetobench-replay). Like the card, it prints counts only, never a command.

## License

Apache-2.0
