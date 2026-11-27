# Methodology

## Data

Claude Code writes one JSONL transcript per session under `~/.claude/projects/` (subagents get their own files). From about v2.1.306, each tool-result record carries an undocumented `permissionDecision` object: `decision` (accept / reject / cancelled), `source` (config, user_temporary, user_reject, user_abort, …) and a reason (`reasonType` or `reasonCode`: rule, subcommandResults, classifier, mode, safetyCheck, …). vetobench reads only those fields, the tool name of the matching tool call, the timestamp and the version.

Each tool call is counted once. A resumed or forked session can copy earlier records into a new transcript, so the same `tool_use_id` can appear in several files; only the first one read counts, and `repeats` (in `--json`, and a line on the card) reports how many copies were skipped. On the author's 30-day corpus, 864 of 237,951 tool results were such copies (0.36%; CLAIMS #12).

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

## Interactive and headless runs (`vetobench headless`)

Every user and assistant record carries an `entrypoint` field, the value of `CLAUDE_CODE_ENTRYPOINT` (bookkeeping records carry none). `vetobench headless` counts a decision as headless when its own record says `sdk-cli` (`claude -p`), `sdk-ts` or `sdk-py` (the Agent SDKs) or `claude-code-github-action`, and as interactive for `cli`, `claude-vscode` or `claude-desktop`. Any other value, or none, is unknown, never guessed. Only `sdk-cli` was tested; the other values come from Claude Code's own code.

In the tested runs, a call that would have shown a permission prompt in a run that could not show one was recorded as `reject` from `config` with no `reasonType`, and a `reasonCode` that gives the cause (Claude Code 2.1.332 in `claude -p`: `hook:PreToolUse` for a hook's ask, `unknown` when no rule allowed the call; five records from two setups). Claude Code's code also records such a refusal with `reasonType` `asyncAgent` where it has no way to ask. These count as "refused because no one could approve", by cause, with those inside subagents counted as in [Where the agent was running](#where-the-agent-was-running). The other causes come from reading Claude Code's code, and a refusal recorded with a `reasonType` counts as that block instead, so these refusals may be undercounted. Method, the tested shapes and the limits are in [docs/headless.md](https://github.com/vetobench/vetobench/blob/main/docs/headless.md).

## Wildcard attribution

Which allow-rule approved a shell command is not recorded, so vetobench reconstructs it. The method is a port of the analysis behind CLAIMS #4, kept exact so that number can be replayed.

- **Examined:** Bash calls whose gate is a static allow-rule (single or compound). The command is read from the matching tool call, matched in memory and dropped. Only counts and the fixed family names are kept.
- **Rules:** `Bash(...)` entries in `permissions.allow`. By default each command is matched against the rules in effect for its session: `~/.claude/settings.json`, plus `.claude/settings.json` and `.claude/settings.local.json` of the session's project (see [Settings files](#settings-files)). `--rules FILE` (repeatable) uses the given files instead, so you can pass the settings that were in effect. Those are pooled and applied to every transcript.
- **Splitting:** heredoc bodies are removed, then the command is split on `&&`, `||`, `;`, `|` and newlines. The split ignores quotes. Leading `VAR=value` assignments are stripped, and empty or comment parts are skipped.
- **Matching:** `x:*`, `x *` and `x*` are prefix rules, compared as plain string prefixes. Other rules must match exactly. A prefix rule is a **wildcard interpreter/remote rule** when its prefix is one of the fixed names in `BROAD` (`src/analyze.js`: `python3`, `bash`, `node`, `ssh`, `curl`, `git`, …).
- **Relied on a wildcard:** at least one part matched a wildcard rule and no other rule. The family is that rule's prefix, or the longest one if several match. An action that relied on two families counts under both, so the family counts can add up to more than the total.

Choices that can only lower the count:
- A part that also matches a non-wildcard rule counts as specific, because that rule alone would have approved it.
- Decisions with a `user_*` source are left out even when they name a rule. The original analysis counted them.
- A part that no rule matches (Claude Code's built-in read-only commands, or a parser difference) never counts as a wildcard.

A known source of over-counting: plain prefixes are wider than Claude Code's `:*` and ` *` rules, which match at a word boundary (`sh:*` does not approve `shasum`). `--json` also reports `wildcard.wordBoundary`, the same count with the word boundary applied. The two can differ in either direction (`npm run test:*` covers `npm run test:unit` only as a plain prefix), and the gap shows how much the number depends on this choice.

## Secrets left in transcripts (`--secrets`)

With `--secrets`, vetobench also counts secret-shaped strings in every transcript line: prompts, messages, tool inputs and tool results. API-request records are skipped. The scan is off by default: it runs every pattern over every line, which takes longer than the rest of the card combined.

- **Categories** are fixed in code (`SECRET_PATTERNS` in `src/analyze.js`): Postgres URL with a password, other database URL with a password (MySQL, Redis, MongoDB, AMQP), `PGPASSWORD=` values, private-key blocks, provider keys by prefix (Anthropic, OpenAI-style `sk-`, GitHub, AWS, Slack, Stripe), JWTs, and other `*_SECRET` / `*_TOKEN` / `*_PASSWORD` / `*_API_KEY` assignments. The settings audit uses the same table for its "with a secret inline" count.
- **One string counts once.** Where shapes overlap, the earlier category wins, so the key in `OPENAI_API_KEY=sk-…` counts as an OpenAI-style key and not also as an assignment.
- **Unit: occurrences**, as in the research scan behind the claims ledger: every match in the raw JSONL line counts. The same value counts each time it is written, and Claude Code often stores a tool's output twice in one record, so occurrences overstate how many secrets there are. The card therefore also reports **distinct values**: distinct matched strings, counted through SHA-256 digests that stay in memory during the run and are then dropped. Values and digests are never printed or written.
- **Window:** `--since` / `--until` apply to each record's timestamp. Records without one (session summaries) drop out once `--since` is set.
- **Shapes, not verified secrets.** Placeholders and documented example keys count. Secrets in other formats (lowercase names, `password:` in YAML) are missed. This is a heuristic, not a security scan.

## Settings files

The rules line ("Your allow-rules now") and wildcard attribution read your current settings files:

- **Global:** `~/.claude/settings.json`.
- **Projects:** `.claude/settings.json` and `.claude/settings.local.json` of every project a counted session ran in, and of the folder you run vetobench from.
- **Which project a session belongs to:** Claude Code names each folder under `~/.claude/projects` after the folder the session was launched from, with every character other than a letter or digit replaced by `-`. Each record carries its working folder (`cwd`). vetobench takes the nearest folder at or above the record's `cwd` whose encoding matches the transcript folder, so a subagent working in a worktree counts under the project it was launched from. If none matches, it uses the record's own `cwd`. From there it takes the nearest folder with project settings, stopping below your home folder. A record without a `cwd` gets the rules of the folder vetobench runs in.
- Each file is read once and counted once. Folder names and paths stay in memory and are never printed; the card shows only how many files were read.

### Unused rules

"N of M shell allow-rules never approved a command in this window": M counts the `Bash(...)` allow-rules in those files, and N the ones that matched no part of any static-approved shell command in the window.

- A rule only counts as used by sessions it applied to: global rules by every session, project rules by their own project's sessions.
- "Matched" uses Claude Code's semantics: `x:*` and `x *` at a word boundary, `x*` as a plain prefix, anything else exactly. When several rules match a part, all of them count as used.
- Other rules (`Read`, `WebFetch(domain:…)`, MCP tools) are not checked, so they are not in M.
- The count is for your *current* rules against past commands, so a rule added recently has had less time to match. With `--rules`, the count covers the given files, pooled.

## Fix (`vetobench fix`)

`fix` removes allow-rules from your current settings. Without `--write` it only counts.

- **Files:** the settings files of [Settings files](#settings-files), except a project's `.claude/settings.json`, which is usually committed and shared with a team. Those change only with `--include-shared`.
- **What it removes**, in this order of precedence (a rule is counted once):
  1. **A secret inside the rule:** any shape in `SECRET_PATTERNS`, in any kind of rule. A `$VARIABLE` or `${VARIABLE}` in place of the value is a reference, not a secret.
  2. **A broad wildcard:** a `Bash(...)` prefix rule on one bare command from `BROAD` (`python3:*`, `ssh *`, `git*`). Skip with `--keep-wildcards`.
  3. **Never fired:** a `Bash(...)` rule that approved no command in the window (see [Unused rules](#unused-rules)). Skip with `--keep-unused`. It is judged only when all of these hold:
     - the transcripts span at least 14 days, and at least 90% of tool calls carry a recorded decision (older Claude Code versions did not record them);
     - for a project's file, that project's own sessions span at least 14 days (the global file uses the whole window);
     - the rule is a plain command or ends in its only wildcard. Rules with a wildcard elsewhere, `&&`, `||`, `;`, `|`, a newline, a heredoc, a substitution or a leading `NAME=value` can approve commands this matcher never pairs with them, so they are never called unused;
     - the file still holds the rules the scan matched against (it did not change during the run).
- **Approvals the matcher cannot read:** when part of a rule-approved command matches no rule, the part is cleaned up and matched again: brackets of a subshell, quoted `FOO="a b"` prefixes and wrappers such as `timeout 30`, `nohup` or `env` are removed, and each `$(...)` substitution is matched on its own. If still nothing matches, every rule for the part's own command word counts as used. Lines of a multi-line script (`const x = 1`) never mark a rule. A record whose working folder does not lead to its session's launch folder (or that has none) is placed in the launch folder that the transcript folder's name encodes (found on disk, so the order transcripts are read in does not matter), and a rule approval recorded before its tool call (in another transcript) is matched when the tool call appears.
- **Writing (`--write`):** each file is re-read and left alone if it changed since the plan, if it cannot be written (read-only), or if it is not valid UTF-8. Otherwise its bytes are copied into `~/.claude/vetobench-backups/<UTC time>/` (folder mode 700, files 600), and `MANIFEST.json` there names each original before that original changes. Backups never land inside a project; if `~/.claude` itself lives in a git repository (a dotfiles repo), `fix` says so. Only the elements of the `permissions.allow` array are removed: every byte outside that array stays, including formatting, comments, a BOM, line endings and number spelling. Inside the array, kept elements are joined with the array's own separator, so a comment between elements can be lost. The result goes to a temporary file in the same folder with the original's mode and is renamed over it. A symlinked file is written through to its target and the link stays; a hard-linked file is rewritten in place so the link stays. The command exits with status 1 when a planned file was left unchanged.
- **Output:** counts only, like the card. No rule, path or secret is printed. Compare a backup with its file to see what was removed, then delete the backup: it still holds any removed secret.
- **Limits:** "never fired" uses reconstructed rule matching (see Wildcard attribution), so it is an estimate. A rule removed by mistake costs one prompt: approve it again and it comes back.

## Other commands

Each of these follows the same rules as the card: it reads local files, sends nothing, and prints counts only. Their methods, sources and limits are in their own documents, in the repository (they are not part of the npm package).

- **`doctor`** ([docs/doctor.md](https://github.com/vetobench/vetobench/blob/main/docs/doctor.md)): twelve fixed checks on the settings files of [Settings files](#settings-files); every settings key it reads is checked against Claude Code's documentation, cited there. The checks are heuristics: they say where to look, not whether a setup is safe.
- **`drift`** ([docs/drift.md](https://github.com/vetobench/vetobench/blob/main/docs/drift.md)): the card's gates and shapes per ISO week (Monday start, UTC), from one scan; shares are rounded as on the card, and changes are the difference between the two shares as printed.
- **`graph`** ([docs/graph.md](https://github.com/vetobench/vetobench/blob/main/docs/graph.md)): the card's totals per UTC day (per bucket of whole weeks past 92 days), as one self-contained HTML file. Decisions with no valid timestamp, or dated before 2025 or after the day the page is made, are counted at the top but not drawn, and the page says how many.
- **`mcp`** ([docs/mcp.md](https://github.com/vetobench/vetobench/blob/main/docs/mcp.md)): MCP servers from the configuration files Claude Code documents, MCP allow, deny and ask rules, and MCP tool calls by gate.
- **`hook`** ([docs/hook.md](https://github.com/vetobench/vetobench/blob/main/docs/hook.md)): the `replay` policy run live as a `PreToolUse` hook; it fails open on a broken setup (an error never blocks the agent), and asks about a command it could not check (see [Replay](#replay-vetobench-replay), "Bounds").
- **`headless`** ([docs/headless.md](https://github.com/vetobench/vetobench/blob/main/docs/headless.md)): the card's decisions split by run kind (see [Interactive and headless runs](#interactive-and-headless-runs-vetobench-headless)); its gates refine the card's. Approvals match the card's gate for gate (hook approvals split out of static), and blocks add up to the card's blocks; one record shape can move between block gates (a reject from `config` with no `reasonType` and a `reasonCode` of exactly `safetyCheck` or `classifier`).
- **`scrub`** ([docs/scrub.md](https://github.com/vetobench/vetobench/blob/main/docs/scrub.md)): the `SECRET_PATTERNS` of [Secrets left in transcripts](#secrets-left-in-transcripts---secrets), minus `$VARIABLE` references; only the value is replaced, each changed line is parsed again, and files written in the last 10 minutes are left alone. A session whose earlier messages were redacted may not resume on newer models.
- **`check-settings`** ([action/README.md](https://github.com/vetobench/vetobench/blob/main/action/README.md)): the secret and broad-wildcard checks of `fix`, plus a bare `Bash` allow (`Bash`, `Bash()`, `Bash(*)` or `Bash(:*)`, which approves every shell command), for committed settings in CI.
- **Codex CLI** ([docs/codex.md](https://github.com/vetobench/vetobench/blob/main/docs/codex.md)): not supported; its transcripts do not record who approved each tool call.

## Known limits

- **Approvals given in chat** ("go ahead", "post it") are invisible to this field and not counted.
- The field is undocumented and may change without notice. One open issue reports `user_temporary` logged without a visible prompt; check it on your own corpus before quoting the human count.
- Rule attribution (which allow-rule approved a command) is reconstructed, not recorded (see Wildcard attribution). By default it uses your *current* settings. For an older window, pass the settings that were in effect with `--rules`.
- This is one harness. Other agents record approvals differently or not at all.

## Replay (`vetobench replay`)

`vetobench replay` asks: how often would a policy that asks before production writes, CI triggers and pushes to main have stopped your agent? Unlike the card, it reads the command text of each `Bash` tool call. It matches the text in memory and prints counts per category; it never prints or stores a command, a host or a rule. With [owners](#owners-owners) in your policy, it also prints your owner labels, so they go wherever you paste its output.

- **Input.** Every `Bash` tool call (`tool_use` block) in the transcripts. A tool call id that appears in more than one file (resumed sessions copy their history) is counted once; `--json` reports the repeats under `repeated`. API-request records are skipped. `--since` / `--until` select by the UTC day of the tool call.
- **Parsing.** The command is split into simple commands, quote-aware: `;`, `&&`, `||`, `|` and newlines end one; `$( )`, backticks, `bash -c`, `eval`, ssh remote commands, and heredocs fed to ssh, a shell or a SQL client are parsed too. Quoted text, comments, and heredoc bodies written to files are data, not commands. `VAR=value`, `export` and wrappers such as `sudo`, `env`, `timeout` and `xargs` are followed.
- **Bounds.** The parser reads text the agent writes, and the hook has seconds before Claude Code gives up on it, so every string the parser builds and every loop it runs is bounded by a count:
  - Past a limit that could hide a command, the command is not checked. It counts as an ask in the category `unchecked`, "Command vetobench could not check", with no other category and no owner. These limits are: more than 12 levels of nesting (`$( )`, `<( )`, backticks, `bash -c`, `eval`, an ssh remote command, a heredoc fed to a shell or ssh); more than 10,000 simple commands in one command line, assignments and nested ones included; more than 1,024 heredocs, or a heredoc delimiter longer than 64 characters; more than 16 MiB of text read, counting the command line, each part of it parsed again as a command of its own, and each heredoc body handed to a command. Any other error while checking one command counts the same way: one of your `rules` or `ignore` patterns throwing on it, or a bug in vetobench.
  - Past a bound that leaves part of the check out, the rest is still checked, and the command is marked incomplete. A `$NAME` reference is expanded only while its word grows by at most 4,096 characters and the command line by at most 65,536 in all; at most 256 variables are tracked (per command line, and per ssh remote command), and an assignment to a further name is not recorded. A reference past these bounds stays `$NAME`. Your `rules` run only on text of up to 64 KiB (the command with heredoc bodies cut out); on longer text they are left out. The part left out could be the whole command (`eval "$C"`), a branch or a verb, so an incomplete command is always asked about: in the categories that did match, or as `unchecked` when none did. A host or context left as a reference counts as production unless `unknownIsProd` is false, as one set outside the command does.
  - Your `ignore` patterns run only on commands of up to 64 KiB. A longer command is checked as if no pattern matched it: it can still be asked about, never skipped.

  The limits are meant to sit far above what a coding agent writes. An `unchecked` ask is one command; it never makes `replay` count a transcript as unreadable.
- **Counting.** A command that matches several categories is one ask. The share is asks over shell commands scanned.
- **Per day.** Asks are also counted per UTC day of the tool call. The card shows the average over the calendar days from the first to the last shell command in the window (both included), the busiest day, and the days without an ask; `--json` adds `asksPerDay.byDay`, the count for each day that had an ask. The rate is the number to watch: a prompt that comes rarely still gets read, and one that comes many times a day turns into a reflex.

| Category | Asks for |
|---|---|
| `push-to-main` | `git push` whose refspec targets a protected branch (`main`, `master`; set `branches`), including deletes |
| `pr-merge` | `gh pr merge`, or the pull-request merge API |
| `ci-trigger` | `gh workflow run`, `gh run rerun`, `gh release create`, `glab ci run/retry/trigger`, and workflow-dispatch, repository-dispatch or rerun API calls (`gh api`, curl) |
| `repo-secret` | `gh secret set/delete`, `gh variable set/delete`, `glab variable set/update/delete` |
| `package-publish` | `publish` with npm, pnpm, yarn, bun, cargo, poetry or uv; `twine upload`; `gem push`. Not with `--dry-run` |
| `prod-host-write` | Over ssh (or `gcloud compute ssh`), on a production host: sudo file changes (tee, mv, cp, install, rm, dd, truncate, chmod, chown, ln, `sed -i`), `rm` with flags, service changes (systemctl, service, pm2), container changes (docker or podman run, restart, rm, stop, `compose up`, …), writes into `.env` or `/etc/`, reboots, and anything run with `--apply`. Reads, `mkdir` and unpacking are left to your other gates |
| `copy-to-remote` | scp or rsync whose destination is `host:path` on a production host. Downloads are not asked |
| `remote-sql-write` | psql, mysql or mariadb with a write (UPDATE … SET, DELETE FROM, INSERT INTO, TRUNCATE, ALTER/DROP/CREATE TABLE and similar, GRANT, REVOKE) in its arguments or heredoc, and `pg_restore` or `dropdb`, against a production host. The host comes from `-h`/`--host`, a connection URL, `host=` or `PGHOST`/`MYSQL_HOST`. Over ssh, localhost means the remote host |
| `k8s-write` | kubectl or oc apply, create, delete, patch, replace, edit, scale, set, label, annotate, drain, cordon, `rollout restart/undo`, …; helm install, upgrade, uninstall, rollback; against a non-local `--context` (`--kube-context` for helm). Not with `--dry-run` |
| `infra-apply` | terraform, tofu or terragrunt apply, destroy, import, taint, `state rm/mv/push`; pulumi up, destroy, import; cdk deploy, destroy |
| `cloud-mutation` | gcloud create, update, delete, deploy, IAM changes and similar; aws mutating operations (`create-*`, `delete-*`, `put-*`, `terminate-*`, …) and bucket writes; gsutil bucket writes; az create, delete, update, set, deploy and similar |
| `prod-api-write` | curl, wget, httpie or xh with POST, PUT, PATCH or DELETE, or a request body, to a host in `prodHosts`. Off unless your policy lists production hosts |
| `custom` | Your policy's own `rules` that name no other category |
| `unchecked` | A command vetobench could not check (see "Bounds" above). It is not a detector: a policy cannot switch it off, put rules in it or name it in `owners` |

**Which hosts are production.** A host or Kubernetes context matching `prodHosts` is production. Otherwise loopback names and addresses, `host.docker.internal`, unix sockets, local cluster contexts (`kind-*`, `k3d-*`, `minikube`, `docker-desktop`, `rancher-desktop`, `orbstack`, `colima`, `microk8s`) and `localHosts` are local. Every other host is production unless `remoteIsProd` is false. When the transcript does not show the target (no `-h`, no `--context`, or a variable set outside the command), it counts as production unless `unknownIsProd` is false.

### Policy file (`--policy file`)

A JSON object; every field is optional.

```json
{
  "localHosts": ["*.dev.example.internal", "db"],
  "prodHosts": ["*.prod.example.internal", "api.example.internal"],
  "remoteIsProd": true,
  "unknownIsProd": true,
  "branches": ["main", "master", "release/*"],
  "disable": ["pr-merge"],
  "rules": [
    { "category": "prod-host-write", "match": "(?:\\S*/)?deploy\\.sh\\s+prod\\b" },
    { "match": "make\\s+release", "anywhere": true, "flags": "i" }
  ],
  "ignore": ["my-guard-selftest"],
  "owners": [
    { "owner": "data team", "categories": ["remote-sql-write"], "hosts": ["db.*.prod.example.internal"] },
    { "owner": "platform on-call", "categories": ["infra-apply", "k8s-write", "prod-host-write"] },
    { "owner": "release manager", "branches": ["main", "release/*"] }
  ]
}
```

| Field | Default | Meaning |
|---|---|---|
| `localHosts` | `[]` | Host or context patterns that are never production. `*` is a wildcard; case is ignored |
| `prodHosts` | `[]` | Patterns that are always production. They also switch on `prod-api-write` |
| `remoteIsProd` | `true` | `false`: only `prodHosts` count as production |
| `unknownIsProd` | `true` | `false`: a command whose host or context is not visible is not asked |
| `branches` | `["main", "master"]` | Protected branch patterns for `push-to-main` |
| `disable` | `[]` | Built-in category names to switch off |
| `rules` | `[]` | Extra rules. `match` is a JavaScript regular expression tested on the command with heredoc bodies cut out. It must match where a command starts (start of a line, or after `;`, `&`, `\|`, `(` or `$(`, behind `VAR=value`, `sudo`, `timeout N` or `command`) unless `"anywhere": true`; allow a path prefix with `(?:\S*/)?`. `category` is one of the names above (default `custom`). `flags` may use `i`, `m`, `s` and `u`. Rules run on text of up to 64 KiB (see "Bounds") |
| `ignore` | `[]` | Regular expressions. A command matching one is skipped and not counted, for example your own guard's test commands. Commands over 64 KiB are not tested against them (see "Bounds") |
| `owners` | `[]` | Who owns what. Each ask gets the label of the first entry that selects it; see [Owners](#owners-owners) |

Unknown fields are an error, so a typo cannot quietly change a replay. Error messages name the field, never its value. The output reports how many hosts and rules the policy holds, never which. The one text from the policy file that vetobench prints is an owner label.

**Keep your rules simple.** A rule without `anywhere` is tested as one regular expression, an anchor followed by your `match`:

```
(?:^|\n|[;&|(]|\$\()[^\S\n]*(?:(?:do|then|else)[^\S\n]+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S*[^\S\n]+)*(?:(?:sudo|timeout\s+\d+[smh]?|command)[^\S\n]+)?(?:<match>)
```

The engine tries it from every place a command can start, and backtracks through the anchor and your pattern from each. The anchor's blanks (`[^\S\n]`) leave out the line break, because a line break is itself a place where a command starts; otherwise a pattern that begins with `\s*`, `.*` or `[\s\S]*` would share every run of line breaks with the anchor in very many ways. Other long runs still cost time: blanks before such a pattern, and `NAME=value;` repeated, which the anchor's `NAME=value` part retries from every `;` whatever your pattern is. `ignore` patterns have no anchor; each is tested as written, on the whole command. Rules and ignore patterns run on text the agent writes, and the hook has 10 seconds before Claude Code cancels it and runs the command unchecked, so a pattern that backtracks a lot can cost you the ask. vetobench cannot stop a regular expression once it runs; what it does is run them only on text of up to 64 KiB (see "Bounds"), and ask about a longer command rather than pass it. Below that, the time is yours to keep down: prefer few, plain rules over many clever ones, avoid nested quantifiers such as `(a+)+` and alternatives that overlap inside a repeat, and try a new rule with `vetobench replay --policy` on your own transcripts before you install it. The same goes, to a smaller degree, for `localHosts`, `prodHosts` and `branches`: each `*` in a pattern becomes `.*`, so a pattern with one `*` is cheap, and one with several costs more on a long host or branch name.

### Owners (`owners`)

Approving every action one by one does not scale; knowing who owns what does. `owners` works like a CODEOWNERS file for actions: each entry names an `owner` and says which asks are theirs. When the policy asks, the hook names that owner in the prompt, and `replay` counts the asks per owner. **An owner never makes an ask.** It only labels an ask that the rest of the policy already makes; a command the policy lets run stays silent whatever the owners say.

| Field | Meaning |
|---|---|
| `owner` | Required. The label printed in the prompt and by `replay`: 1 to 40 ASCII letters, digits, spaces and `.` `_` `@` `#` `/` `&` `+` `-`, with no space at either end. So it cannot hold a quote, `=`, `:` or `$`. A label that matches a known key or token shape (the `SECRET_PATTERNS` of [Secrets left in transcripts](#secrets-left-in-transcripts---secrets), such as a token prefix) is an error too. That is a pattern check: a secret of another shape is not recognised, so use team or role names |
| `hosts` | Host or context patterns, as for `localHosts` and `prodHosts`: `*` is a wildcard, case is ignored; at most two `*` in one pattern. Case is compared in lowercase, so for a few Unicode letter variants (`µ` and `μ`, `ς` and `σ` and the like) a pattern is stricter here than in `prodHosts`, and the owner can be missing where `prodHosts` matches. They are compared with the hosts an ask is about: the host a command runs on over ssh (in any category), the scp or rsync destination, the database host of a SQL write (over ssh, with a local host or none: the remote host), the `--context` of a Kubernetes change (`--kube-context` for helm), and the API host of a `prod-api-write`. A host the command does not show (none given, or a variable) is no host, so no pattern selects it, not even `*`. An ask that only your `rules` make has no hosts: select it with `categories` or `contains` |
| `branches` | Branch patterns, as for `branches`; at most two `*` in one pattern. They are compared with the branches a `git push` targets that the policy protects, so they select `push-to-main` asks only. A pull-request merge does not name the branch it merges into, and an ask that only your `rules` make has no branches: select those with `categories` or `contains` |
| `categories` | Category names from the table above, `custom` included |
| `contains` | Plain text, not a regular expression: up to 8 strings of 1 to 64 characters. The entry matches when the command holds one of them anywhere, case ignored, heredoc bodies cut out (the text a rule's `match` sees). For example `["migrate.sh"]` |

- **No regular expressions in owners.** Owners are matched on text the agent writes, and a careless regular expression on a crafted command can run past the hook's timeout, after which Claude Code runs the command unchecked. So owner matching uses none: category names, plain text found with a substring search, and `*` patterns matched part by part. A `match`, `flags` or `anywhere` in an owners entry is an error that says to use `contains`; `rules` keep their regular expressions.
- **At least one selector.** An entry needs `hosts`, `branches`, `categories` or `contains`, and a list must not be empty.
- **All of an entry's selectors must match, on one category.** `categories`, `hosts` and `branches` are checked together against each category of the ask, with the hosts and branches of that category's own commands; `contains` is checked against the whole command. So `{"owner": "data team", "categories": ["remote-sql-write"], "hosts": ["db.*"]}` selects SQL writes to those hosts and nothing else, even in a command that also runs `terraform apply`. Within one selector, any one pattern is enough. For "this or that", write two entries with the same owner.
- **The first entry that selects an ask wins**, in the order of the file. Put narrow entries before broad ones. One ask has one owner, also when it falls in several categories: `npm publish && git push origin main` is one ask, labelled `Push to a main branch; Package publish`, with the owner of the first entry that selects either category.
- **No owner.** An ask that no entry selects keeps exactly the reason it has without owners.
- **A label, not an authorisation.** Owners never allow anything; they only name whose system an ask touches. The owner is chosen from the command text, which the agent writes, so a command can steer which owner is shown: a decoy write to another host earlier in the same command, or a comment that holds a `contains` string. Put entries that pair `categories` with `hosts` first, and do not treat the label as anyone's approval.
- **Limits.** Every input and list is bounded, so the work to find an owner is bounded too, and a replay gives the same owners on every machine:
  - owners are looked up only for commands of at most 4,096 characters (heredoc bodies included); a longer command's ask has no owner;
  - a host or branch longer than 255 characters, or on more than one line, is not compared;
  - at most 32 distinct hosts and 32 distinct branches of one command are compared: the first ones its asked parts name, category by category in the order of the table above, and within a category in the order of the command. Further ones are not compared, so a command that names more can get no owner, or the owner of an earlier one;
  - at most 64 entries; per entry, at most 16 host and branch patterns together, each of at most 64 characters with at most two `*`, and at most 8 `contains` strings.

  Owners that break a rule of this section are a policy error for `replay` and `hook install`. `hook run` drops the owners instead and still asks, without labels, and `hook test` reports that as a warning. Any other policy error still makes the hook fail open.
- **Output.** The hook's reason becomes `vetobench policy: <category labels> (owner: <owner>)`. `replay` adds "Asks by owner": one line per owner label, in the order the file first names it, with its asks and their share of all asks (a label with no ask shows 0), then "Asks without an owner". `--json` adds `asksByOwner` (a list of `{"owner", "asks"}`), `asksWithoutOwner`, and `policy.owners`, the number of entries. `hook install` and `hook test` print the number of entries, not the labels. Without owners, the output is unchanged.
- **Versions.** Owners need the release that adds them (see the changelog). vetobench 0.3.0 and older reject `owners` as an unknown field, so a hook that runs one of those fails open. `vetobench hook test` warns when the installed hook runs an older vetobench than the copy testing it.

### Labels (`--labels file`)

Your own verdicts, keyed by tool call id (the `tool_use` id in the transcript): a JSON object `{"<id>": "ask", "<another id>": "allow"}`, or JSON Lines `{"id": "<id>", "label": "ask"}`. `ask` means the command should have been asked about; `allow` means it should not. The replay then reports asks that were right (labelled `ask`), wrong (labelled `allow`) and unlabelled, and misses (labelled `ask` but not asked). Labels do not depend on the policy, so one set scores every policy. vetobench ships no labels.

### Replay limits

- It replays a policy against what the agent tried. It does not know what happened after an ask: the agent might have stopped or changed course.
- A bare `git push` pushes the current branch, which the transcript does not record, so it is not asked. Context switches (`kubectl config use-context`) earlier in a session are not followed either.
- SQL read from a file (`-f`, `< file`) or a pipe is not inspected.
- Shell parsing is approximate. Aliases, functions and the scripts a command calls are not followed.
- A replay is reproducible only with the same version, window and policy file. The policy file is part of the claim.
