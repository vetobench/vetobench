# vetobench scrub

## What it does

`vetobench scrub` finds passwords, keys and tokens left in plain text in your Claude Code transcripts (`~/.claude/projects`) and replaces each value with a fixed marker such as `[redacted:github-token]`. Only the value changes. The command, file or message around it stays as it was, so you can still read what happened. It looks for the same shapes as `vetobench --secrets` (see [METHODOLOGY.md](../METHODOLOGY.md#secrets-left-in-transcripts---secrets)). One of them, `*_SECRET` / `*_TOKEN` / `*_PASSWORD = value`, is counted but not redacted unless you pass `--include-assignments` (see [NAME=value assignments](#namevalue-assignments---include-assignments)).

Without `--write` it is a dry run: it counts what it would redact, by category, and changes nothing. Like the rest of vetobench, it prints counts only (never a value, a line or a path) and sends nothing anywhere.

**Redacting is not rotating.** A secret that sat in a transcript was in plain text on your disk, and it was part of the conversation your agent sent to the model. Rotate it whether or not you scrub.

## Usage

```sh
npx vetobench scrub                        # dry run: counts what --write would redact
npx vetobench scrub --write                # redact, after backing up each transcript it changes
npx vetobench scrub --include-assignments  # also redact *_TOKEN= / *_SECRET= values that look random
npx vetobench scrub --since 2026-11-01     # only records from this UTC day on (--until: before this day)
npx vetobench scrub --json                 # counts as JSON
```

Full form: `npx vetobench scrub [transcripts-dir] [--write] [--include-assignments] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--json]`.

Close your Claude Code sessions before `--write`. Afterwards:

1. Look over a few transcripts, or resume a session, and compare with the backup.
2. Delete the backup folder that the output names (`~/.claude/vetobench-backups/<time>/`). **The backups hold every value that was redacted**, in plain text, until you delete them.
3. Rotate the secrets.

The exit status is 1 when `--write` left a transcript it meant to change alone, because the transcript changed during the run or could not be written. Run it again.

## How it works

- **Which part is replaced.** For a database URL, the password (scheme, user, host and database stay). For `PGPASSWORD=` and, with `--include-assignments`, `*_SECRET` / `*_TOKEN` / `*_PASSWORD` / `*_API_KEY` assignments, the value (the name stays). For provider keys, tokens and JWTs, the whole key. For a private key, the whole block from its BEGIN line to its END line, or, when the key was cut short, the base64 after the BEGIN line.
- **What is not a value.** A `$VARIABLE` or `${VARIABLE}` in place of the value is a reference, not a secret (a database URL whose password is `$DB_PASSWORD`), so it stays, as in `vetobench fix`. Markers from an earlier run are not values either, so a second run finds nothing new.
- **Same shapes and priority as `--secrets`.** Where two shapes overlap (`OPENAI_API_KEY=sk-...`), the earlier category wins and the string is redacted once.
- **Raw lines, valid JSON.** scrub works on the raw JSONL text, where values sit inside JSON strings, often escaped (`\"`, `\n`, or JSON inside a JSON string). The marker holds no quote or backslash, so it can never end a string early. Every changed line is parsed again. If it would no longer parse, the whole line stays exactly as it was and is counted. In practice this is a carriage return written right before a Stripe-shaped `k_live_` string.
- **Thinking blocks stay as they are.** The model's recorded thinking carries a signature over its content, and the API can refuse a thinking block that was edited, which would stop the session from resuming. Values inside one are left and counted separately.
- **Window.** `--since` and `--until` apply to each record's own timestamp. Records without one (session summaries) drop out once `--since` is set.
- **One file, one pass.** A transcript reached through two paths (a symlinked folder, a symlink to another transcript, a second hard link) is read once, by device and inode, and a symlink cycle in the folder is walked once.
- **Writing (`--write`).** Each transcript with something to redact is left alone if it was written to in the last 10 minutes (an open session may still be appending), if its size, modification time or inode changed since scrub read it, if it cannot be written (read-only), or if it is not valid UTF-8. Otherwise `MANIFEST.json` in `~/.claude/vetobench-backups/<UTC time>/` (folder mode 700, files 600) names the original, the original's bytes are copied there, and the redacted text goes to a temporary file in the same folder with the original's mode and modification time. A last check confirms the original has not changed, then the temporary file is renamed over it. A symlinked transcript is written through to its target and the link stays. Keeping the modification time means a transcript still looks as old as it is, both in session lists and to cleanup by age (`cleanupPeriodDays`).
- **Counts.** The unit is the occurrence, as with `--secrets`: the same value written twice in one record (Claude Code often stores a tool's output twice) counts twice. The totals still differ from `--secrets` in two ways: references are not counted, and API-request records, which `--secrets` skips so the research counts replay, are scrubbed too, because they hold copies of the conversation. `--json` reports `transcripts` (read, with a secret, to change, active, changed during the run, with another hard link), `values` (found, to redact, in active or changed transcripts, inside thinking, in lines that would break), `lines`, `byCategory` (found), `assignments` (whether `--include-assignments` was given, the NAME=value matches found, how many look random, and how many this run leaves) and, with `--write`, `written`: counts, plus `backup`, the name of the backup folder (its UTC time, never a full path; `null` when nothing was written), and `backupInGit`.

## NAME=value assignments (`--include-assignments`)

The `assignment` shape is a name containing `SECRET`, `PASSWORD`, `PASSWD`, `TOKEN`, `API_KEY`, `PRIVATE_KEY`, `_PK` or `MNEMONIC`, then `=`, then a value of 12 or more characters. In shell and `.env` text that is often a secret. In code it is often not: `MAX_TOKENS = DEFAULT_MAX_TOKENS_VALUE` has the same shape. On the author's transcripts, many of these matches had a value that looked like a code identifier. Replacing those would change code in the transcript, and the session, if you resume it, would read the marker in its place.

So by default scrub counts these matches and leaves them: the dry run reports them on their own line, as possible secrets that were not redacted. With `--include-assignments` it redacts the value only when it looks random:

- it is 16 characters or longer,
- it contains at least one letter and at least one digit, and
- it is not a plain identifier.

A plain identifier is two or more words joined by `_`, `-` or `/` (`DEFAULT_MAX_TOKENS_V2`, `claude-sonnet-4-5-20250929`, `src/tokens/resetFlowV2`) or run together in camelCase (`maxTokenLifetime2024`, `HTTPResponseCode404`). A word is letters of one case, or a capital followed by lowercase letters, with digits only at its end (`V2`, `gpt4`), or digits with an optional lowercase suffix (`2024`, `4o`). Random mixed-case strings also split into such words now and then, but into short ones, so camelCase words must average three letters or more. Values without a digit, shorter values and identifier-shaped values stay, and are counted.

This is a heuristic in both directions. A weak password made of words (`correct-horse-battery-2`) looks like an identifier and stays. A short random value (under 16 characters) stays. A value made of one word and digits (`supersecret2024x`) counts as random and is redacted. A random mixed-case value now and then splits into identifier-like words by chance, more often the shorter it is, and then stays.

## Limits

- **Resuming.** Every line stays valid JSON with the same structure, so Claude Code still reads a redacted transcript and you can resume it. The model then sees the marker where the value was. One caveat: newer models bind each recorded thinking block to the conversation before it, and where the API checks that binding, a session whose earlier messages changed can fail to resume with an "Invalid signature in thinking block" error. If that happens, start a new session. The transcript stays readable either way.
- **Shapes, not verified secrets.** It is the same heuristic as `--secrets`, not a security scan. Placeholders and documented example keys are redacted too, which does no harm. Secrets in other formats (lowercase names, `password:` in YAML, a database password that contains `@`) are missed. An assignment's value ends at the first character other than a letter, a digit, `+`, `/`, `_` or `-`, so the rest of an unusual value stays. An assignment whose name has more than 64 characters before or after its keyword is not matched (the bound keeps matching fast on hostile input).
- **Escapes and nesting.** A secret right after an ANSI colour escape or another control escape (coloured terminal output such as `\u001b[0m`, or a `\f` escape) is not found: most shapes must start at a word, and in the raw line the escape ends in a letter. Only Postgres URLs, private keys and Anthropic keys are found there. A double-quoted value two or more JSON levels deep, such as `PGPASSWORD="x"` inside JSON inside a JSON string, is not found either: its quote is escaped more than once.
- **One value can hold back its line.** If redacting one value would leave the line's JSON unparseable, every value on that line stays unredacted, not only that one, and the line is counted under lines that would break.
- **Memory.** The dry run reads transcripts line by line, but `--write` reads each transcript it rewrites into memory whole. A very large transcript (hundreds of MB) can then fail, with an error or by running out of memory, before anything is written for it: that transcript stays unchanged, and the ones already done stay done.
- **Only transcripts.** scrub reads the `*.jsonl` transcripts under the folder you give it, and skips claude-mem observer sessions, like the rest of vetobench. Other copies stay where they are: other files Claude Code keeps beside transcripts (saved tool output as `.txt` or `.json`), files elsewhere in `~/.claude` such as `history.jsonl`, `file-history/` and `shell-snapshots/`, your shell history, and the files the secrets came from.
- **Open sessions.** A session that has been idle for more than 10 minutes is not detected as open. It still holds the original text in memory and can write it into new records. And if Claude Code keeps a transcript open while scrub replaces it, its later appends can go to the old file, which is no longer in the folder, so those records are lost from the transcript. This is why scrub skips transcripts written to in the last 10 minutes. Close your sessions before `--write`.
- **Hard links.** A transcript with another hard link is replaced by a new file. The other link keeps the original text. The output counts such transcripts.
- **Backups.** They hold every redacted value until you delete them. If `~/.claude` lives in a git repository (a dotfiles repo), scrub says so: do not commit the backup folder.
