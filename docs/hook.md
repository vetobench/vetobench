# `vetobench hook`

## What it does

`vetobench replay` counts how often an "ask before production writes, CI triggers and pushes to main" policy would have asked. `vetobench hook` puts the same policy in front of your agent. It installs a Claude Code `PreToolUse` hook for the `Bash` tool. Before each shell command, the hook checks the command against the policy. When the policy would ask, Claude Code holds the command for your confirmation, even when an allow-rule such as `git:*` would have let it through (tested, see [What was tested](#what-was-tested-in-claude-code)). Every other command goes through your normal permissions, as before.

The categories, the parser and the policy file are the ones `replay` uses (see [METHODOLOGY.md](../METHODOLOGY.md#replay-vetobench-replay)), so a replay tells you how often the hook would have asked you over your own history.

## Usage

```sh
npm install -g vetobench          # the hook needs a lasting install (see below)

vetobench hook install            # a dry run: shows what would change
vetobench hook install --write    # adds the hook to ~/.claude/settings.json, after a backup
vetobench hook uninstall --write  # removes it again, after a backup
```

| Option | Meaning |
|---|---|
| `--write` | Apply the change. Without it, install and uninstall only show what would change |
| `--project` | Use this folder's `.claude/settings.local.json` (personal settings for this project, usually not committed) instead of `~/.claude/settings.json` |
| `--policy FILE` | Your hosts, branches and extra rules, in the `replay` format. `install` checks that the file loads and stores its full path in the hook |

To check a policy before you install it, replay it first: `vetobench replay --policy FILE`. To check the hook itself, pipe it a made-up tool call:

```sh
echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git push origin main"}}' | vetobench hook run
```

It prints the "ask" answer. If it prints nothing for a command you expected it to ask about, the command does not match the policy or the policy file did not load.

The output of `install` and `uninstall` holds fixed labels and counts only: how many other settings and hooks the file holds, how many vetobench hooks would be added or removed, and how many rules and hosts your policy has. It never shows a command, a path or a rule.

Exit codes: `install` and `uninstall` exit with 1 when they refuse (also in a dry run), or when `--write` leaves the file unchanged. `hook run` always exits with 0.

## How it works

### The hook (`vetobench hook run`)

Claude Code runs the hook before each `Bash` tool call and passes the call as JSON on stdin. The hook reads `tool_input.command`, skips commands that match the policy's `ignore` patterns, and runs the `replay` matcher on the rest. It reads no transcripts and no settings, and it does not touch the network.

- **When the policy asks**, it prints one JSON object and exits with 0:

  ```json
  {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"vetobench policy: Push to a main branch"}}
  ```

  The reason holds only the fixed category labels (for example `Push to a main branch; Package publish`), never the command. Claude Code shows it to you in the permission prompt.
- **Otherwise** it prints nothing and exits with 0, and the call goes through your normal permission flow. The hook never allows or denies anything by itself.
- **It fails open.** On anything unexpected (input that is not JSON, a policy file that cannot be read or has an error, an unknown option, input over 8 MB, or input that has not ended after 5 seconds) it prints nothing and exits with 0. A broken hook then acts as no hook: it never blocks your agent, and never makes you approve every command. The cost is that a broken policy file turns the guard off without telling you, so `install` checks the policy before it writes, and the `echo … | vetobench hook run` check above shows that the hook works.

### What was checked in Claude Code's documentation

Checked on 2026-11-25 in the official hooks reference, <https://code.claude.com/docs/en/hooks>, with the permissions guide, <https://code.claude.com/docs/en/permissions> (section "Extend permissions with hooks"), and <https://code.claude.com/docs/en/permission-modes>:

- **Input.** A `PreToolUse` hook receives the common fields (`session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`) plus `tool_name`, `tool_input` and `tool_use_id`. For `Bash`, `tool_input` holds `command`, an optional `description`, an optional `timeout` in milliseconds, and `run_in_background`.
- **Output.** A `PreToolUse` hook returns its decision in `hookSpecificOutput`: `hookEventName` `"PreToolUse"`, `permissionDecision` one of `"allow"`, `"deny"`, `"ask"` or `"defer"`, and `permissionDecisionReason`. `"ask"` prompts the user to confirm, and for `"ask"` the reason is shown to the user in the permission prompt. The older top-level `decision` and `reason` fields are deprecated for this event. Stdout counts as JSON only when it is a single JSON object.
- **Exit codes.** With exit code 0, Claude Code applies the JSON the hook printed. With no output and exit code 0, the call continues through the normal permission flow ("staying silent doesn't approve it"). Exit code 2 blocks the call. Any other exit code is a non-blocking error, and the call goes ahead. A hook that times out does not block the call either.
- **Registration.** Hooks live under `hooks.PreToolUse` as matcher groups, `{"matcher": "Bash", "hooks": [{"type": "command", "command": "…", "timeout": 10}]}`, in `~/.claude/settings.json`, a project's `.claude/settings.json` or its `.claude/settings.local.json`. `timeout` is in seconds (the default for command hooks is 600). Project hooks are read from the `.claude/` folder of the folder Claude Code started in, not from parent folders. Hooks that match the same call run in parallel. An identical handler in several files runs once. When hooks disagree, `deny` beats `defer`, which beats `ask`, which beats `allow`. Claude Code's file watcher normally picks up edits to hooks in settings files. `/hooks` lists the hooks in effect.
- **Precedence over rules.** Deny and ask rules are still evaluated whatever a hook returns. `PreToolUse` hooks run before every tool call, whether or not it needs permission.

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

### Why a global install, and why not npx

The hook runs before every shell command your agent runs, so each run should start fast and keep working.

- `npx vetobench` runs from npm's temporary cache (`_npx`). npm can clear that cache at any time, and a hook pointing into it would then fail on every command. Starting npx also starts npm itself first: it resolves the package and may contact the registry. A hook would pay that before every shell command, and could need the network.
- So `install` writes the absolute path of `node` and the real path of the running `vetobench.js`, and does so only when that file is a global install: it lies in npm's global folder (`<prefix>/lib/node_modules`, on Windows `<prefix>\node_modules`), or a `vetobench` command on your `PATH` (outside any `node_modules/.bin`) leads to it. That covers npm global installs (with nvm, Homebrew or a custom prefix) and `npm link` for a checkout. Another package manager's global install works when its `vetobench` command is a symlink to the file; that is not tested. Run from npx or a project's `node_modules`, it refuses and asks you to run `npm install -g vetobench` first.
- For `node`, it prefers a `node` on your `PATH` that is the same program as the running one. With Homebrew that is `/opt/homebrew/bin/node`, which survives `brew upgrade`, rather than the versioned folder it points to. Calling `node` with a path, rather than `vetobench` through its `#!/usr/bin/env node` line, does not depend on the `PATH` Claude Code gives hooks.
- Each run starts Node once and loads only vetobench's own files, with no transcript scan. To see what that costs on your machine, time the check command above.

## Limits

- **Where Claude Code reads its settings.** `install` edits `~/.claude/settings.json` (or the project's `settings.local.json` with `--project`). If you run Claude Code with `CLAUDE_CONFIG_DIR` pointing elsewhere, it never reads that file, so the hook will not run. Managed settings with `disableAllHooks` or `allowManagedHooksOnly` also stop it from running; `install` still says it installed the hook, because it does not read managed settings.
- **Headless runs.** In `claude -p` and other non-interactive runs there is nobody to answer the prompt, so an "ask" denies the command, and the agent sees the reason (tested, see above). In a CI job, that means the hook blocks the commands its policy covers.
- **Uninstall tidies up.** Removing the hook also removes a `PreToolUse` list, and a `hooks` object, that end up empty, even if they were empty before you installed it.
- **A failed write keeps its backup.** If `--write` backs a file up and then cannot write it (a read-only folder, for example), the file is unchanged and the backup folder stays in `~/.claude/vetobench-backups/`; delete it if you like.
- **A heuristic, not a security boundary.** The hook reads command text. It does not run the command, follow aliases, functions or the scripts a command calls, or see what a program does once it runs. The [replay limits](../METHODOLOGY.md#replay-limits) apply as they are: a bare `git push` pushes the current branch, which the command does not show, so it is not asked. A determined or confused agent can write a command it does not recognise.
- **Bash only.** File edits and MCP tools are not checked.
- **It fails open.** A policy file that breaks after install (moved, deleted or edited into invalid JSON) switches the guard off silently. Re-run the `echo … | vetobench hook run` check after you change the policy.
- **It can only add prompts.** The hook never answers `allow` or `deny`. Whether a prompt appears also depends on Claude Code. In our test (one version, headless), neither a matching allow-rule nor `bypassPermissions` overrode its ask, and `dontAsk` turned it into a denial; the interactive dialog itself was not observed. Claude Code can change this in any release, so try one known command in your own setup.
- **A moved install.** If you uninstall the global package, switch Node versions with nvm, or move the policy file, the stored paths stop working. The hook then fails with an error before each shell command, which Claude Code treats as non-blocking: the command runs, unchecked. Run `vetobench hook uninstall --write` and install again.
- **Prompts you see too often stop being read.** Run `vetobench replay` with your policy first. Its asks-per-day line shows how often the hook would have asked you.
- **Windows is untested.** The command is quoted for a POSIX shell.
