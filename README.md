# vetobench

**Who approved your coding agent's actions?**

Coding agents now run hundreds of tool calls an hour. Almost none of them are approved by a person. They are approved by allow-rules you clicked months ago, or by an AI classifier. vetobench shows you the split for your own agent, from transcripts already on your machine. It is also building an open benchmark of how often agent permission guards are wrong on real traffic.

> Status: pre-release. The CLI below works locally; the npm package and the benchmark are not published yet.

```
npx vetobench
```

```
vetobench 0.0.1: who approved your agent's actions
1,744 transcripts · 2026-10-22 to 2026-11-20 · 237,578 of 237,951 tool calls carry a recorded decision

  Static allow-rules (compound command)               117,297    49.4%
  AI classifier                                        63,623    26.8%
  Static allow-rule (single command)                   52,496    22.1%
  ...
  You, through a permission prompt                         12   0.005%

Static rules approved 72.7%, the AI classifier 26.8%, you 12 action(s).
```

## Principles

- **Nothing leaves your machine.** No network code ships, and CI enforces it: a test rejects any network-capable module or API, and the CLI runs in a sandbox with networking off.
- **Counts only.** The output never contains commands, file paths, prompts, rule bodies or secrets, so a card is safe to paste publicly.
- **Zero dependencies, no install scripts.** Read the source in `bin/` and `src/` in a few minutes.
- **Every number is reproducible.** See [METHODOLOGY.md](METHODOLOGY.md) and [CLAIMS.md](CLAIMS.md).

## Options

```
npx vetobench [transcripts-dir] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--json]
```

The default directory is `~/.claude/projects`. Claude Code records a permission decision for each tool call from about v2.1.306 onward.

## License

Apache-2.0
