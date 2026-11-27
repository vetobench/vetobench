# `vetobench hook`

## What it does

`vetobench replay` counts how often an "ask before production writes, CI triggers and pushes to main" policy would have asked. `vetobench hook` puts the same policy in front of your agent. It installs a Claude Code `PreToolUse` hook for the `Bash` tool. Before each shell command, the hook checks the command against the policy. When the policy would ask, Claude Code holds the command for your confirmation, even when an allow-rule such as `git:*` would have let it through (tested, see [What was tested](#what-was-tested-in-claude-code)). Every other command goes through your normal permissions, as before.

The categories, the parser and the policy file are the ones `replay` uses (see [METHODOLOGY.md](../METHODOLOGY.md#replay-vetobench-replay)), so a replay tells you how often the hook would have asked you over your own history.

## Usage

```sh
npm install -g vetobench          # the hook needs a lasting install (see below)

vetobench hook install            # a dry run: shows what would change
vetobench hook install --write    # adds the hook to ~/.claude/settings.json, after a backup
vetobench hook test               # checks the installed hook end to end; only reads
vetobench hook uninstall --write  # removes it again, after a backup
```

| Option | Meaning |
|---|---|
| `--write` | Apply the change. Without it, install and uninstall only show what would change. `test` does not take it: it never writes |
| `--project` | Use this folder's `.claude/settings.local.json` (personal settings for this project, usually not committed) instead of `~/.claude/settings.json` |
| `--policy FILE` | Your hosts, branches, extra rules and owners, in the `replay` format. `install` checks that the file loads and stores its full path in the hook |

To check a policy before you install it, replay it first: `vetobench replay --policy FILE`. To check the installed hook, run `vetobench hook test` (see [Checking the hook](#checking-the-hook-vetobench-hook-test)). To try the hook command by hand, pipe it a made-up tool call:

```sh
echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git push origin main"}}' | vetobench hook run
```

It prints the "ask" answer. If it prints nothing for a command you expected it to ask about, the command does not match the policy or the policy file did not load.

The output of `install`, `uninstall` and `test` holds fixed labels and counts only: how many other settings and hooks the file holds, how many vetobench hooks would be added or removed, how many rules, hosts and owner entries your policy has, and for `test` a version string. It never shows a command, a path, a rule or an owner label.

Exit codes: `install` and `uninstall` exit with 1 when they refuse (also in a dry run), or when `--write` leaves the file unchanged. `test` exits with 1 when any check fails or could not run. `hook run` always exits with 0.

## How it works

### The hook (`vetobench hook run`)

Claude Code runs the hook before each `Bash` tool call and passes the call as JSON on stdin. The hook reads `tool_input.command`, skips commands that match the policy's `ignore` patterns, and runs the `replay` matcher on the rest. It reads no transcripts and no settings, and it does not touch the network.

- **When the policy asks**, it prints one JSON object and exits with 0:

  ```json
  {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"vetobench policy: Push to a main branch"}}
  ```

  The reason holds the fixed category labels (for example `Push to a main branch; Package publish`) and, when your policy names an owner for the ask, that owner's label (see [Owners](#owners-who-to-ask)). Never the command, a host or a rule. Claude Code shows it to you in the permission prompt.
- **Otherwise** it prints nothing and exits with 0, and the call goes through your normal permission flow. The hook never allows or denies anything by itself.
- **It fails open on a broken setup.** On anything unexpected about the setup (input that is not JSON, a policy file that cannot be read or has an error, an unknown option, input over 8 MB, or input that has not ended after 5 seconds) it prints nothing and exits with 0. A broken hook then acts as no hook: it never blocks your agent, and never makes you approve every command. The cost is that a broken policy file turns the guard off without telling you, so `install` checks the policy before it writes, and `vetobench hook test` checks it again whenever you run it. One exception: an error only in the policy's `owners` does not turn the guard off. The hook drops the owners and still asks, without owner labels (see [Owners](#owners-who-to-ask)).
- **It asks about a command it could not check.** When the setup is fine but checking one command fails, the hook does not stay silent: it asks, with the reason `vetobench policy: Command vetobench could not check` and no owner. That happens when the command goes past one of the parser's limits that could hide a command from it (more than 12 levels of nesting, more than 10,000 simple commands, more than 1,024 heredocs or a heredoc delimiter longer than 64 characters, or more than 16 MiB of text read, nested commands and heredoc bodies included; see [Replay](../METHODOLOGY.md#replay-vetobench-replay)), when one of your `rules` or `ignore` patterns throws on it, or when vetobench has a bug. It also happens when part of the check had to be left out and nothing else asked: a `$NAME` reference past the expansion bounds or a variable past the 256th (the value could be the whole command, a branch or a verb), or your `rules` on a command longer than 64 KiB (heredoc bodies cut out). When something else did match, the hook asks with that category instead. Your `ignore` patterns skip nothing longer than 64 KiB. The limits are meant to sit far above what a coding agent writes, so a command that reaches one deserves a look.

### Owners: who to ask

Approving every action one by one does not scale. What helps is knowing who owns what, so that a prompt says whose system the agent is about to change. The policy file's `owners` list does that, like a CODEOWNERS file for actions. The format is in [METHODOLOGY.md](../METHODOLOGY.md#owners-owners). For example:

```json
{
  "branches": ["main", "release/*"],
  "owners": [
    { "owner": "data team", "categories": ["remote-sql-write"], "hosts": ["db.*.prod.example.internal"] },
    { "owner": "platform on-call", "categories": ["infra-apply", "k8s-write", "prod-host-write"] },
    { "owner": "release manager", "branches": ["main", "release/*"] }
  ]
}
```

With this file, an SQL write to `db.eu.prod.example.internal` is asked about with the reason:

```text
vetobench policy: SQL write to a non-local database (owner: data team)
```

- **Owners only label.** They never add an ask: the command must already be one the policy asks about. An ask no entry selects keeps the reason it has without owners (`vetobench policy: CI trigger or release`), byte for byte.
- **One owner per ask.** The first entry, in file order, that selects the ask wins. When a command falls in several categories (`cd infra && terraform apply && git push origin HEAD:main`), the prompt lists every category and one owner: `vetobench policy: Push to a main branch; Infrastructure apply or destroy (owner: platform on-call)` with the file above, because the `platform on-call` entry comes before the `release manager` one.
- **What a label may hold.** 1 to 40 ASCII letters, digits, spaces and `. _ @ # / & + -`, and no known key or token shape (a pattern check on the `SECRET_PATTERNS` list, so a secret of another shape gets through: use team or role names). The label is printed in the prompt, and Claude Code may keep the reason in its transcript, so the rule keeps commands and known secret shapes out of both.
- **A label, not an authorisation.** Owners never allow anything. The owner is chosen from the command text, which the agent writes, so a command can steer which owner is shown (a decoy write to another host earlier in the same command, or a comment that holds a `contains` string). Put entries that pair `categories` with `hosts` first, and do not read the label as anyone's approval.
- **No regular expressions in owners.** The hook has 10 seconds before Claude Code gives up on it and runs the command unchecked, and a careless regular expression on a crafted command can take longer than that. So owners select by category, by `*` patterns on hosts and branches, and by `contains`: plain text found anywhere in the command, case ignored (for example `"contains": ["migrate.sh"]`). None of these is a regular expression. A `match` in an owners entry is an error that says to use `contains`. The inputs are bounded too: owners are looked up only for commands up to 4,096 characters, at most 32 distinct hosts and 32 distinct branches of a command are compared, and a policy holds at most 64 entries with a few short patterns each. The full rules are in [METHODOLOGY.md](../METHODOLOGY.md#owners-owners).
- **A broken owners list costs the labels, not the ask.** `replay` and `install` refuse a policy whose owners break a rule, naming the field. If the file is edited into that state after install, `hook run` drops the owners and still asks, without labels, and `vetobench hook test` shows a warning on its `policy` line. Any other policy error still makes the hook fail open.
- **Versions.** Owners need the release that adds them (see the changelog). vetobench 0.3.0 and older reject `owners` as an unknown field, so a hook that runs one of those fails open. `vetobench hook test` warns when the installed hook runs an older vetobench than the copy testing it.
- **Before you install,** `vetobench replay --policy FILE` shows how many asks each owner would have had over your own history, and how many had no owner.

### What was checked in Claude Code's documentation

Checked on 2026-11-25 in the official hooks reference, <https://code.claude.com/docs/en/hooks>, with the permissions guide, <https://code.claude.com/docs/en/permissions> (section "Extend permissions with hooks"), and <https://code.claude.com/docs/en/permission-modes>:

- **Input.** A `PreToolUse` hook receives the common fields (`session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`) plus `tool_name`, `tool_input` and `tool_use_id`. For `Bash`, `tool_input` holds `command`, an optional `description`, an optional `timeout` in milliseconds, and `run_in_background`.
- **Output.** A `PreToolUse` hook returns its decision in `hookSpecificOutput`: `hookEventName` `"PreToolUse"`, `permissionDecision` one of `"allow"`, `"deny"`, `"ask"` or `"defer"`, and `permissionDecisionReason`. `"ask"` prompts the user to confirm, and for `"ask"` the reason is shown to the user in the permission prompt. The older top-level `decision` and `reason` fields are deprecated for this event. Stdout counts as JSON only when it is a single JSON object.
- **Exit codes.** With exit code 0, Claude Code applies the JSON the hook printed. With no output and exit code 0, the call continues through the normal permission flow ("staying silent doesn't approve it"). Exit code 2 blocks the call. Any other exit code is a non-blocking error, and the call goes ahead. A hook that times out does not block the call either.
- **Registration.** Hooks live under `hooks.PreToolUse` as matcher groups, `{"matcher": "Bash", "hooks": [{"type": "command", "command": "…", "timeout": 10}]}`, in `~/.claude/settings.json`, a project's `.claude/settings.json` or its `.claude/settings.local.json`. `timeout` is in seconds (the default for command hooks is 600). Project hooks are read from the `.claude/` folder of the folder Claude Code started in, not from parent folders. Hooks that match the same call run in parallel. An identical handler in several files runs once. When hooks disagree, `deny` beats `defer`, which beats `ask`, which beats `allow`. Claude Code's file watcher normally picks up edits to hooks in settings files. `/hooks` lists the hooks in effect.
- **Precedence over rules.** Deny and ask rules are still evaluated whatever a hook returns. `PreToolUse` hooks run before every tool call, whether or not it needs permission.

Checked on 2026-11-26 for `vetobench hook test`, in the hooks reference and the settings page, <https://code.claude.com/docs/en/settings>:

- **Settings precedence.** Highest first: "managed settings, command line, project local, shared project, user". Lists merge across files; a single value comes from the highest level that sets it.
- **`disableAllHooks`.** "Claude Code reads the value left after settings precedence applies, so a `"disableAllHooks": false` in a project's `.claude/settings.json` overrides a `true` in your user settings." And: "`disableAllHooks` set in user, project, or local settings can't disable those managed hooks. Only `disableAllHooks` set at the managed settings level can disable managed hooks."
- **`allowManagedHooksOnly`.** Set in managed settings: "Your user, project, local, and plugin hooks are blocked."
- **`CLAUDE_CONFIG_DIR`.** "To keep the home-directory files somewhere else, set `CLAUDE_CONFIG_DIR`; Claude Code then stores your settings, session history, and plugins there instead."
- **Strict JSON.** "Settings files are strict JSON: a `//` comment or a trailing comma is a syntax error." Claude Code then reports a Settings Error, and the file's settings, its hooks included, do not apply. **Not in the documentation: a BOM.** `hook test` assumes, as `doctor` does, that Claude Code reads a file that starts with a BOM; that was not tested.
- **Matchers.** `"*"`, `""` or no matcher match every tool. A matcher of only letters, digits, `_`, `-`, spaces, `,` and `|` is an exact name or a list of them. Any other matcher is a "JavaScript regular expression, unanchored".
- **Handler fields.** `type` is one of `"command"`, `"http"`, `"mcp_tool"`, `"prompt"` or `"agent"`. With `args`, "`command` is resolved as an executable and spawned directly with `args` as the argument vector, with no shell involved." `async: true` "runs in the background without blocking". `if` holds a permission rule: "The hook command only runs if the tool call matches the pattern." `timeout` is in seconds. `onFailure: "block"` (Claude Code 2.1.295 or later) blocks the call when the hook fails or cannot start; without it, "a hook that can't start is a non-blocking error too", and the call goes ahead.
- **Default mode.** "`permissions.defaultMode` values `auto` and `bypassPermissions` don't take effect from project or local settings."

The pages do not say, in so many words, that a hook's `"ask"` wins over an allow-rule that matches the same command, or how hooks behave in `bypassPermissions` or `dontAsk` mode. So we tested it.

### What was tested in Claude Code

Tested on 2026-11-26 with Claude Code 2.1.332. Headless `claude -p` runs, with the settings passed through `--settings` and `--setting-sources local` so that no other settings applied. The hook was a stub that prints the same JSON as `vetobench hook run`. Each run asked the agent to `touch` a file in an empty folder; whether the file existed afterwards showed whether the command ran.

| Settings | Result |
|---|---|
| No rule, no hook (control) | Held |
| Allow-rule `Bash(touch:*)` | Ran |
| The same allow-rule, plus the hook answering `"ask"` | **Held**: the hook's ask won over the allow-rule |
| No rule, plus the hook answering `"ask"` | Held |
| No rule, plus a hook answering `"allow"` | Ran (why `vetobench hook` never answers `"allow"`) |
| Allow-rule plus `"ask"` hook, in `bypassPermissions` mode | **Held**; the control without the hook ran in that mode |
| Allow-rule plus `"ask"` hook, in `dontAsk` mode | Held |
| Allow-rule plus `"ask"` hook, the command run inside a subagent (the `Agent` tool), in the foreground or in the background | **Held**: the hook runs for subagents' tool calls too; the control without the ask ran inside the subagent |

- **Headless, "held" means denied.** Nobody can answer a prompt in `claude -p`, so the call is denied, and the agent sees the hook's reason (the category labels).
- **Not seen in this test: the dialog itself.** A headless run cannot show one. Claude Code documents `"ask"` as prompting you to confirm. To see it on your machine: in an empty folder, put an allow-rule for `Bash(touch:*)` and a `PreToolUse` hook that prints the JSON above into `.claude/settings.json`, start `claude`, trust the folder, and ask it to run `touch marker`. A permission prompt should appear although the allow-rule matches.
- **Untrusted folders.** In `claude -p`, allow-rules in a project's `.claude/settings.json` are ignored until the folder is trusted, while hooks in the same file still run.

### Install and uninstall

- **The file.** `~/.claude/settings.json`, or with `--project`, `.claude/settings.local.json` in the folder you run it in (Claude Code reads project hooks only from the folder it starts in). A missing file is created. A new `settings.local.json` inside a git repository gets a note: make sure git ignores it, because the hook holds full paths.
- **What is added.** One new matcher group at the end of `hooks.PreToolUse`: `{"matcher": "Bash", "hooks": [{"type": "command", "command": "<node> <vetobench> hook run [--policy <file>]", "timeout": 10}]}`. Both paths are absolute and quoted for the shell. A timeout of 10 seconds caps how long a stuck hook can hold up a command; a cancelled hook does not block it.
- **What is removed.** Every `PreToolUse` handler whose command runs `vetobench hook run`, however it was written (a full path, the global command or `npx`). A group that held only such handlers goes whole; a group shared with other hooks keeps them. If that leaves `PreToolUse` or `hooks` empty, they go too, so an install followed by an uninstall gives back the original file byte for byte. One consequence: an empty `"PreToolUse": []` you had before installing is gone after uninstalling.
- **Every other byte stays.** The file is not rewritten from parsed JSON. vetobench finds the spot in the text and inserts or cuts only the hook's own entry, in the file's own indentation. Numbers, key order, duplicate keys and formatting elsewhere stay exactly as they were. Before writing, it parses the result and checks that it equals the old settings plus or minus that one entry. If not, it leaves the file alone.
- **Refusals** (exit code 1, nothing changed, also in a dry run): the file is not plain JSON (comments, a BOM, a trailing comma, invalid UTF-8, or not a JSON object); `hooks` or `hooks.PreToolUse` is not laid out as documented; a vetobench hook is already installed (`install`) or none is (`uninstall`); the policy file cannot be loaded; or vetobench is not installed globally (`install`).
- **Writing (`--write`), as in `fix`.** The file is read again and left alone if it changed since the plan. Its bytes are copied into `~/.claude/vetobench-backups/<UTC time>/` (folder mode 700, file 600), and `MANIFEST.json` there names the original before the original changes. The new text goes to a temporary file in the same folder with the original's mode, and is renamed over it. A symlinked file is written through to its target, and the link stays. A hard-linked file is rewritten in place. Backups never land inside a project.

### Checking the hook (`vetobench hook test`)

`vetobench hook test` checks the hook that `install` wrote, end to end, without starting Claude Code. It reads `~/.claude/settings.json`, or with `--project` this folder's `.claude/settings.local.json`, and never writes anything. Each check prints a level (`ok`, `note`, `warn`, `fail`, or `skip` for a check that could not run), a fixed name and a fixed text, never a path or a command. It exits with 1 when any check fails or could not run.

It tests the vetobench hook that runs: the one in that file, or the one in the managed settings when they allow only their own hooks (`allowManagedHooksOnly`) or when the file holds none. When the file holds none, it says where else `hook test` would find one (`--project` or not), and never advises installing a second hook.

| Check | What it looks at | When it fails (or warns) |
|---|---|---|
| `settings file` | The file `install` writes, read as `install` reads it | It is missing, cannot be read or is not plain JSON. A BOM before valid JSON is a warning: Claude Code reads such a file (an assumption, see above), but `install` and `uninstall` leave it alone. When the managed hook is the one tested, problems here are notes |
| `installed` | vetobench handlers under `hooks.PreToolUse`, and the matcher of their group | There is none, or no matcher covers `Bash` (by the matcher rules quoted above; a pattern that is not a valid regular expression covers nothing). More than one handler is a warning: identical ones run once, different ones each run. The checks below test the first whose matcher covers `Bash` |
| `managed hook` | A vetobench handler in the managed settings, when it is the one tested | A note, or a warning when `allowManagedHooksOnly` stops the file's own hook. When it fails a check below, the advice is to tell whoever deploys the managed settings |
| `handler` | The handler's fields | Its `type` is not `"command"`, or it has an `args` list, which makes Claude Code start the command as one program with no shell (a fail). A `shell` setting, `async`, an `if` condition, or a timeout under 1 second or not a number (Claude Code cancels a hook that runs out of time, and a cancelled hook does not block the command) are warnings, and `onFailure: "block"` is a note. `install` writes none of these. A timeout is printed only as a whole number of seconds from 1 to 3600; others show as "an unusual timeout" |
| `command shape` | The stored command, split into words as a shell splits it | `hook run` gets options it does not take (the hook then stays silent on every command). A command that goes through `npx` or a similar runner is a warning. A command with shell syntax the check does not follow (a redirect, `$VAR`, `~` and the like) was probably edited by hand: the check reports "could not check" (`skip`) and the checks of its paths and policy do not run |
| `node` | The node the command names | The path is gone or not executable: the hook then errors before each command, and Claude Code runs the command unchecked (or, with `onFailure: "block"`, blocks every shell command). A bare `node`, or none (vetobench started by its `#!` line), is a warning when it is on your `PATH`: the hook then depends on the `PATH` Claude Code gives hooks |
| `vetobench` | The vetobench script the command names | It is gone, or not executable when the command runs it without node |
| `version` | The `version` in the `package.json` of that script's package | Older than 0.2.0, which has no `hook` command: a fail, and the advice is to update the global install first (`npm install -g vetobench`), since that copy cannot install the hook again. Older than the copy running the check: a warning, because the `asks` and `stays silent` checks use the running copy's matcher, not the installed one. Newer, or unreadable, or a running copy whose own version is not a plain one (so the two cannot be compared): a note. Only a plain version (`1.2.3`, up to four digits per part, optionally `-alpha`, `-beta` or `-rc` with a number) is printed; anything else shows as "an unrecognised version" |
| `policy` | The `--policy` file, loaded as `hook run` loads it. The line counts its categories, rules, host patterns and owner entries, never the labels | It does not load: the hook fails open, so the guard is off. Only the error's fixed text is printed (for example `rules[0].match is not a valid regular expression`). An error only in its `owners` is a warning: the hook drops the owners and still asks |
| `asks` | The policy on a made-up `git push origin main` | The policy does not ask (a warning) |
| `stays silent` | The policy on a made-up `ls -la` | The policy asks |
| `hooks enabled` | Your user settings, this folder's `.claude/settings.json` and `.claude/settings.local.json`, and the managed settings files | `disableAllHooks` is true in the file that wins by precedence (managed, local, project, user; the output names only the scope; for a managed hook only managed settings count), or managed settings set `allowManagedHooksOnly` without holding a vetobench hook themselves. Managed files that cannot be read are a note |
| `config dir` | `CLAUDE_CONFIG_DIR` | It points to another folder (a warning, without `--project`): Claude Code then reads its user settings there, not from `~/.claude/settings.json`. The line says whether the settings there hold a vetobench hook; that one is not tested. The `hooks enabled` check reads the user settings there too |
| `permission mode` | `permissions.defaultMode`, by the same precedence (`bypassPermissions` counts only from user or managed settings) | `bypassPermissions` or `dontAsk` is a note, with what the [test](#what-was-tested-in-claude-code) found |

What it cannot see:

- **The prompt itself.** It does not start Claude Code (vetobench never starts a program). To see the prompt, ask your agent to run a command the policy covers, and decline it at the prompt.
- **The installed copy's matcher.** The `asks` and `stays silent` checks run the matcher of the vetobench that runs the check, in its own process, with the policy the hook names. When the hook runs another version, the `version` line says so.
- **The `PATH` Claude Code gives hooks.** A bare `node` or `vetobench` is looked up on the `PATH` of your shell, which can differ from it. `install` writes absolute paths for that reason.
- **Settings it does not read.** Managed settings delivered through MDM, the Windows registry or the server, and command-line flags such as `--settings` or `--setting-sources`. Project files are read from the folder you run it in, as Claude Code reads project hooks only from the folder it starts in.

### Why a global install, and why not npx

The hook runs before every shell command your agent runs, so each run should start fast and keep working.

- `npx vetobench` runs from npm's temporary cache (`_npx`). npm can clear that cache at any time, and a hook pointing into it would then fail on every command. Starting npx also starts npm itself first: it resolves the package and may contact the registry. A hook would pay that before every shell command, and could need the network.
- So `install` writes the absolute path of `node` and the real path of the running `vetobench.js`, and does so only when that file is a global install: it lies in npm's global folder (`<prefix>/lib/node_modules`, on Windows `<prefix>\node_modules`), or a `vetobench` command on your `PATH` (outside any `node_modules/.bin`) leads to it. That covers npm global installs (with nvm, Homebrew or a custom prefix) and `npm link` for a checkout. Another package manager's global install works when its `vetobench` command is a symlink to the file; that is not tested. Run from npx or a project's `node_modules`, it refuses and asks you to run `npm install -g vetobench` first.
- For `node`, it prefers a `node` on your `PATH` that is the same program as the running one. With Homebrew that is `/opt/homebrew/bin/node`, which survives `brew upgrade`, rather than the versioned folder it points to. Calling `node` with a path, rather than `vetobench` through its `#!/usr/bin/env node` line, does not depend on the `PATH` Claude Code gives hooks.
- Each run starts Node once and loads only vetobench's own files, with no transcript scan. To see what that costs on your machine, time the check command above.

## Limits

- **Where Claude Code reads its settings.** `install` edits `~/.claude/settings.json` (or the project's `settings.local.json` with `--project`). If you run Claude Code with `CLAUDE_CONFIG_DIR` pointing elsewhere, it never reads that file, so the hook will not run. Managed settings with `disableAllHooks` or `allowManagedHooksOnly` also stop it from running; `install` still says it installed the hook, because it does not read managed settings. `vetobench hook test` reads them (the managed settings files, not MDM or registry settings) and `CLAUDE_CONFIG_DIR`, and says when either stops the hook.
- **Headless runs.** In `claude -p` and other non-interactive runs there is nobody to answer the prompt, so an "ask" denies the command, and the agent sees the reason (tested, see above). In a CI job, that means the hook blocks the commands its policy covers.
- **Uninstall tidies up.** Removing the hook also removes a `PreToolUse` list, and a `hooks` object, that end up empty, even if they were empty before you installed it.
- **A failed write keeps its backup.** If `--write` backs a file up and then cannot write it (a read-only folder, for example), the file is unchanged and the backup folder stays in `~/.claude/vetobench-backups/`; delete it if you like.
- **A heuristic, not a security boundary.** The hook reads command text. It does not run the command, follow aliases, functions or the scripts a command calls, or see what a program does once it runs. The [replay limits](../METHODOLOGY.md#replay-limits) apply as they are: a bare `git push` pushes the current branch, which the command does not show, so it is not asked. A determined or confused agent can write a command it does not recognise.
- **Bash only.** File edits and MCP tools are not checked.
- **It fails open.** A policy file that breaks after install (moved, deleted or edited into invalid JSON) switches the guard off silently. Run `vetobench hook test` after you change the policy: it loads the file the hook names, as the hook does. A command the hook could not check is the other way round: it is asked about (see [How it works](#the-hook-vetobench-hook-run)).
- **A slow hook is a skipped hook.** If the hook runs past its 10 seconds, Claude Code cancels it and runs the command unchecked. vetobench's own parsing is bounded, but your `rules` and `ignore` patterns are regular expressions on text the agent writes, and one cannot be stopped once it runs. They run only on text of up to 64 KiB; below that, keep them few and simple (see the [policy file](../METHODOLOGY.md#policy-file---policy-file) section).
- **It can only add prompts.** The hook never answers `allow` or `deny`. Whether a prompt appears also depends on Claude Code. In our test (one version, headless), neither a matching allow-rule nor `bypassPermissions` overrode its ask, and `dontAsk` turned it into a denial; the interactive dialog itself was not observed. Claude Code can change this in any release. `vetobench hook test` checks your setup, but it does not start Claude Code, so the prompt itself still needs one real try: ask your agent to run a command the policy covers, and decline it at the prompt.
- **A moved install.** If you uninstall the global package, switch Node versions with nvm, or move the policy file, the stored paths stop working. The hook then fails with an error before each shell command, which Claude Code treats as non-blocking: the command runs, unchecked. `vetobench hook test` finds this (its `node`, `vetobench` and `policy` checks fail). Run `vetobench hook uninstall --write` and install again.
- **Prompts you see too often stop being read.** Run `vetobench replay` with your policy first. Its asks-per-day line shows how often the hook would have asked you.
- **Windows is untested.** The command is quoted for a POSIX shell.
