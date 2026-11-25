# vetobench doctor

## What it does

`vetobench doctor` is a checkup of your Claude Code permission setup. It reads your settings files, runs twelve fixed checks and prints one count per check, each with a level: **high**, **medium** or **info**. It changes nothing. To remove risky allow-rules, use `vetobench fix`.

Like the card, it prints counts only. No rule, command, path, folder name, MCP server name or secret value ever appears in the output, so you can paste it in public.

The checks are heuristics on your settings files. They tell you where to look. They don't prove a setup is safe or unsafe.

## Usage

```
npx vetobench doctor [transcripts-dir] [--json] [--ci]
```

- `transcripts-dir`: default `~/.claude/projects`. The transcripts tell doctor which projects your sessions ran in, so it can read their settings. They also feed the never-fired estimate.
- `--json`: the same counts as JSON. Each check has `id`, `level`, `title`, `unit` and `count`, plus `estimate` and `note` where they apply. `settings` counts the files read (`user`, `project`, `managed`, `unreadable`) and the `scopes`; `history` counts the transcripts, including `unreadable`, the ones that could not be opened and were skipped.
- `--ci`: exit with status 1 when any **high** check is non-zero. Medium and info checks never fail a run.

If the default transcripts folder is missing, as on a CI runner, doctor still checks `~/.claude/settings.json` and the `.claude` settings of the folder you run it from. A transcripts folder you name on the command line must exist.

The Counts column is the JSON `unit` of each check:

| Level | id | Check | Counts |
| :- | :- | :- | :- |
| high | `secret-in-rule` | Allow-rules with a secret inside | `rules` |
| high | `bash-allowed-wholesale` | `Bash`, `Bash(*)` or another allow-rule on every shell command | `rules` |
| high | `bypass-default-mode` | `permissions.defaultMode` is `bypassPermissions` in your user settings, and no file in the scope turns bypass mode off | `scopes` |
| medium | `bypass-prompt-skipped` | `skipDangerousModePermissionPrompt: true` | `files` |
| medium | `broad-wildcard` | A prefix allow-rule on one bare interpreter or remote command (`python3:*`, `ssh *`, `git*`) | `rules` |
| medium | `mcp-server-wholesale` | An allow-rule on every tool of an MCP server (`mcp__<server>`, `mcp__<server>__*`) | `rules` |
| medium | `rules-too-long` | Allow-rules over 4,096 characters, which the other rule checks skip | `rules` |
| medium | `project-mcp-auto` | `enableAllProjectMcpServers: true` | `files` |
| medium | `no-deny-rules` | Scopes with no deny rule at all | `scopes` |
| info | `no-bash-hook` | Scopes where no PreToolUse hook runs for Bash | `scopes` |
| info | `additional-dirs` | Entries in `permissions.additionalDirectories` | `dirs` |
| info | `unused-shell-rules` | Shell allow-rules that never approved a command (an estimate) | `rules` |

## How it works

**Files.** Doctor reads the same settings files as the card (see METHODOLOGY.md, "Settings files"): `~/.claude/settings.json`, the `.claude/settings.json` and `.claude/settings.local.json` of every project a session in the transcripts ran in, and those of the folder you run it from. Each file is read once. A file that isn't valid JSON is counted as unreadable and adds nothing. Claude Code's settings are strict JSON too: comments and trailing commas are errors.

**Managed settings files.** Doctor also reads the managed settings files your organization may deploy, but only for `permissions.disableBypassPermissionsMode` (see the mode checks). It reads `managed-settings.json` and every `*.json` file in `managed-settings.d/` (hidden files left out), in the folder Claude Code reads them from: `/Library/Application Support/ClaudeCode/` on macOS, `/etc/claude-code/` on Linux and WSL, `C:\Program Files\ClaudeCode\` on Windows. Every other key in them is ignored.

**Scopes.** A scope is a set of settings files that sessions run under. One scope is your user settings alone, which covers sessions outside any project with settings. Each project folder adds one more scope: user settings plus that project's files. A scope counts only when it has at least one settings file, so a home with no settings file at all has no scope and nothing to flag. Because each project folder with settings is its own scope, the scope counts (`no-deny-rules`, `no-bash-hook`, `bypass-default-mode`) grow with the number of project folders: ten projects without a deny rule count ten. Claude Code merges list keys such as `permissions.deny` across files, and it merges hook entries too. So a scope has a deny rule, or a Bash hook, if any of its files has one.

**Rule checks.** These go through every `permissions.allow` entry in every file:

- **Too long to check:** a rule over 4,096 characters is counted here and skipped by every other rule check. Some secret patterns take quadratic time on a crafted rule, and a project's shared settings file can come from anyone who can open a pull request.
- **A secret inside:** the `SECRET_PATTERNS` shapes, tested the way `vetobench fix` tests them. A `$VARIABLE` written where the value would go is a reference, not a secret.
- **Broad wildcards:** the same test as the card and `fix` use (`isBroadWildcard`).
- **Bash on every command:** `Bash`, or `Bash(...)` whose parentheses hold only `*` and whitespace, with or without the `:*` suffix: `Bash()`, `Bash(*)`, `Bash(:*)`, `Bash(**)`, `Bash(* *)`, `Bash( * )`. A `*` matches any text, spaces included, so `Bash(* *)` leaves out only one-word commands. The rule is read as written: `Bash ` with a trailing space is another tool name. `vetobench check-settings` uses the same test (`src/rules.js`).
- **MCP wholesale:** `mcp__<server>` with no tool, or `mcp__<server>__*` (any run of `*` after the last `__`). For a server whose name contains `__` or ends in `_`, the documented rule is the wildcard form with the whole name: `mcp__reports__v2__*` counts. The bare `mcp__reports__v2` is tool `v2` of a server named `reports`, as Claude Code reads it, so it doesn't. A rule for one tool (`mcp__<server>__<tool>`) or a glob inside a tool name (`mcp__<server>__get_*`) doesn't count either. Nor do the rules Claude Code skips in allow lists: a glob in the server part (`mcp__*`), a rule with parentheses (`mcp__<server>(x)`), and a bare name ending in `_`. `vetobench mcp` sorts rules with the same function (`parseMcpRule` in `src/rules.js`).

Ask and deny rules are never counted by these checks.

**Mode checks.**

- `bypass-default-mode` counts scopes. A scope counts when its user file sets `permissions.defaultMode` to `bypassPermissions` and no file that applies to it sets `permissions.disableBypassPermissionsMode` to `"disable"`: not the user file, not the project's shared or local file, and not a managed settings file (a managed one applies to every scope). The docs say `bypassPermissions` as a default doesn't take effect from project or local settings, so only the user file can turn it on. `disableBypassPermissionsMode` works from any file. A project that turns bypass off removes its own scope from the count, and sessions elsewhere still start in bypass mode.
- `bypass-prompt-skipped` counts user and local files only, because the key isn't honored in a project's shared file. Claude Code writes this key to your user settings the first time you accept the bypass confirmation.
- `auto`, `acceptEdits`, `plan`, `dontAsk` and `default` are not flagged.

**Hooks.** A PreToolUse matcher group counts for Bash when it holds at least one hook and its matcher matches `Bash`, by the documented rules:

- a missing matcher, `""` or `"*"` matches every tool;
- a matcher of only letters, digits, `_`, `-`, spaces, `,` and `|` is an exact name, or a list of names split on `|` or `,`;
- any other matcher is a JavaScript regular expression and is not anchored, so `^Ba` matches.

`disableAllHooks` takes the value left after settings precedence (local, then shared project, then user). A `true` turns the scope's hooks off.

**Never-fired rules.** Doctor plans `vetobench fix --include-shared` and never applies the plan. Its never-fired count is this estimate, with the same conditions: at least 14 days of history, at least 90% of tool calls carrying a recorded decision, 14 days of each project's own history for that project's files, and only rule shapes the matcher can judge. When fix can't judge, the count is `-` (`null` in JSON) with a note. Rules that `fix` counts as secrets or broad wildcards are left out here, so the same rule is never counted twice. See METHODOLOGY.md, "Fix" and "Unused rules".

**Unreadable transcripts.** A transcript that can't be opened is skipped by the scan. Doctor counts how many, by trying to open each one, and prints the count next to the history line (`history.unreadable` in JSON), as `vetobench drift` does. It never names them.

### What was checked against Claude Code's documentation

Each settings key and its meaning was checked on 2026-11-25 against Claude Code's official documentation at code.claude.com/docs:

| Key or behavior | Page, section | What the docs say |
| :- | :- | :- |
| `permissions.allow` / `ask` / `deny`; deny first | permissions, "Manage permissions" | Rules are evaluated deny, then ask, then allow |
| Lists merge across files | settings, "Lists merge instead of overriding" | `permissions.allow` and other list keys are combined, not overridden |
| Settings files and precedence | settings, "Settings files and who they affect", "Settings precedence" | User, shared project, project local, managed; precedence is managed, command line, local, shared, user |
| Strict JSON | settings, "Edit a settings file" | A `//` comment or a trailing comma is a syntax error |
| `Bash` and `Bash(*)` | [permissions, "Match all uses of a tool"](https://code.claude.com/docs/en/permissions#match-all-uses-of-a-tool) | A bare tool name matches every use; "`Bash(*)` is equivalent to `Bash` and matches all Bash commands" |
| `*`, `:*` and ` *` in Bash rules | [permissions, "Wildcard patterns"](https://code.claude.com/docs/en/permissions#wildcard-patterns) | "A `*` in a Bash rule matches any text, including spaces"; `Bash(ls:*)` matches the same commands as `Bash(ls *)`; `:*` is recognized only at the end. The docs don't mention `Bash()`; doctor counts it with `Bash(*)` |
| `mcp__<server>`, `mcp__<server>__*` | [permissions, "MCP"](https://code.claude.com/docs/en/permissions#mcp) | Both match every tool of the server. For a server whose name contains `__` or ends in `_`, write `mcp__<server>__*` with the whole name (`mcp__reports__v2__*`); the bare `mcp__reports__v2` and `mcp__reports` are read as rules for a server named `reports` |
| Allow globs and skipped MCP rules | [permissions, "Tool name wildcards"](https://code.claude.com/docs/en/permissions#tool-name-wildcards) and ["Match by input parameter"](https://code.claude.com/docs/en/permissions#match-by-input-parameter) | Allow globs need a literal `mcp__<server>__` prefix: "an unanchored allow glob such as `"*"`, `"B*"`, or `"mcp__*"` is skipped". Claude Code "skips any `mcp__` rule that has parentheses" |
| `permissions.defaultMode` | settings-reference, `permissions.defaultMode` | Values `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions` (`manual` is an alias for `default`); `auto` and `bypassPermissions` don't take effect from project or local settings |
| `permissions.disableBypassPermissionsMode` | [settings-reference, same name](https://code.claude.com/docs/en/settings-reference#permissions-disablebypasspermissionsmode) | `"disable"` prevents entering `bypassPermissions` mode; scope "Any file", "typically set in managed settings" |
| Managed settings files | [managed-settings, "Where each mechanism stores the policy" and "Split a file-based policy across teams"](https://code.claude.com/docs/en/managed-settings) | `managed-settings.json` and `managed-settings.d/` in the system folder above; "Claude Code merges `managed-settings.json` first, then every `*.json` file in the directory in alphabetical order" and "ignores hidden files" |
| `skipDangerousModePermissionPrompt` | settings-reference, same name | Boolean; skips the confirmation before `bypassPermissions` mode; scope is user, local or managed |
| `enableAllProjectMcpServers` | settings-reference, settings index (MCP) | Approves every server in project `.mcp.json` files without a prompt; any file |
| `permissions.additionalDirectories` | settings-reference, same name; permissions, "Working directories" | Gives Claude file access to directories outside the one you started in |
| `hooks.PreToolUse` and matchers | hooks, "Matcher patterns" | The match-all, exact-list and unanchored-regex rules above |
| Hooks merge across files | hooks, the table of hook locations | Hook entries from user, project and local settings merge instead of replacing each other |
| `disableAllHooks` | hooks, "Disable or remove hooks"; settings-reference, `disableAllHooks` | Boolean; resolved by settings precedence, so a project `false` overrides a user `true` |

## Limits

- **Most of managed settings isn't read.** From the managed settings files doctor reads only `disableBypassPermissionsMode`. Managed settings delivered another way (server-managed settings, an MDM profile or plist, the Windows registry) aren't read at all; when one of those supplies your organization's policy, Claude Code may skip the files, and doctor can't tell. Deny rules, hooks and modes set in managed settings are invisible to doctor, so it can report a missing deny rule or hook that your organization actually provides.
- **`--settings` files, command-line flags and plugins aren't read.** The same goes for `--dangerously-skip-permissions`, `--permission-mode`, `--add-dir`, plugin hooks and hooks in skill or subagent frontmatter.
- **`CLAUDE_CONFIG_DIR` isn't honoured.** Doctor reads `~/.claude/settings.json` and `~/.claude/projects`, even when Claude Code is pointed at another configuration folder. Name that folder's `projects` as `transcripts-dir` to scan its transcripts; its settings file is still not read.
- **A project's own `defaultMode` isn't modelled.** A project or local file that sets another default mode can override the user's `bypassPermissions` there, but doctor still counts that scope.
- **Workspace trust isn't modeled.** Allow-rules and `additionalDirectories` in a project's shared `.claude/settings.json` take effect only after you trust the folder (permissions, "Project allow rules and workspace trust"), but doctor counts them anyway.
- **Projects are found from your transcripts.** A project you never ran a session in, and that isn't the folder you run doctor from, is not read.
- **Older Claude Code versions differ.** Before v2.1.257, `bypassPermissions` took effect from any settings file. Doctor follows current behavior and counts only the user file's default.
- **Hooks are counted, not run.** A PreToolUse hook on Bash may do anything, including nothing. Doctor counts that one exists.
- **Secrets and broad wildcards are shapes.** Placeholders count, and secrets in other formats are missed. A rule over 4,096 characters is not searched at all; it is counted as too long instead. See METHODOLOGY.md.
- **Never-fired is an estimate.** It uses reconstructed rule matching, like `fix`. That plan tests every rule for secrets itself, so a very long rule still costs time there.
- **`claude doctor` is something else.** It's Claude Code's own command, which lists the settings entries Claude Code rejected. It's unrelated to `vetobench doctor`.
