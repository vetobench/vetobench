# vetobench doctor

## What it does

`vetobench doctor` is a checkup of your Claude Code permission setup. It reads your settings files, runs eleven fixed checks and prints one count per check, each with a level: **high**, **medium** or **info**. It changes nothing. To remove risky allow-rules, use `vetobench fix`.

Like the card, it prints counts only. No rule, command, path, folder name, MCP server name or secret value ever appears in the output, so you can paste it in public.

The checks are heuristics on your settings files. They tell you where to look. They don't prove a setup is safe or unsafe.

## Usage

```
npx vetobench doctor [transcripts-dir] [--json] [--ci]
```

- `transcripts-dir`: default `~/.claude/projects`. The transcripts tell doctor which projects your sessions ran in, so it can read their settings. They also feed the never-fired estimate.
- `--json`: the same counts as JSON. Each check has `id`, `level`, `title`, `unit` and `count`, plus `estimate` and `note` where they apply.
- `--ci`: exit with status 1 when any **high** check is non-zero. Medium and info checks never fail a run.

If the default transcripts folder is missing, as on a CI runner, doctor still checks `~/.claude/settings.json` and the `.claude` settings of the folder you run it from. A transcripts folder you name on the command line must exist.

| Level | id | Check | Counts |
| :- | :- | :- | :- |
| high | `secret-in-rule` | Allow-rules with a secret inside | rules |
| high | `bash-allowed-wholesale` | `Bash` or `Bash(*)` in an allow list: every shell command | rules |
| high | `bypass-default-mode` | `permissions.defaultMode` is `bypassPermissions` in your user settings | files |
| medium | `bypass-prompt-skipped` | `skipDangerousModePermissionPrompt: true` | files |
| medium | `broad-wildcard` | A prefix allow-rule on one bare interpreter or remote command (`python3:*`, `ssh *`, `git*`) | rules |
| medium | `mcp-server-wholesale` | `mcp__<server>` or `mcp__<server>__*` in an allow list: every tool of that server | rules |
| medium | `project-mcp-auto` | `enableAllProjectMcpServers: true` | files |
| medium | `no-deny-rules` | Scopes with no deny rule at all | scopes |
| info | `no-bash-hook` | Scopes where no PreToolUse hook runs for Bash | scopes |
| info | `additional-dirs` | Entries in `permissions.additionalDirectories` | directories |
| info | `unused-shell-rules` | Shell allow-rules that never approved a command (an estimate) | rules |

## How it works

**Files.** Doctor reads the same settings files as the card (see METHODOLOGY.md, "Settings files"): `~/.claude/settings.json`, the `.claude/settings.json` and `.claude/settings.local.json` of every project a session in the transcripts ran in, and those of the folder you run it from. Each file is read once. A file that isn't valid JSON is counted as unreadable and adds nothing. Claude Code's settings are strict JSON too: comments and trailing commas are errors.

**Scopes.** A scope is a set of settings files that sessions run under. One scope is your user settings alone, which covers sessions outside any project with settings. Each project adds one more scope: user settings plus that project's files. Claude Code merges list keys such as `permissions.deny` across files, and it merges hook entries too. So a scope has a deny rule, or a Bash hook, if any of its files has one.

**Rule checks.** These go through every `permissions.allow` entry in every file:

- **A secret inside:** the `SECRET_PATTERNS` shapes, tested the way `vetobench fix` tests them. A `$VARIABLE` written where the value would go is a reference, not a secret.
- **Broad wildcards:** the same test as the card and `fix` use (`isBroadWildcard`).
- **Bash with no pattern:** exactly `Bash` or `Bash(*)`.
- **MCP wholesale:** `mcp__<server>` with no tool, or `mcp__<server>__*`. A rule for one tool (`mcp__<server>__<tool>`) or a glob inside a tool name (`mcp__<server>__get_*`) doesn't count. Neither does a glob in the server part (`mcp__*`), because Claude Code skips that in allow lists.

Ask and deny rules are never counted by these checks.

**Mode checks.**

- `bypass-default-mode` counts only the user file. The docs say `bypassPermissions` as a default doesn't take effect from project or local settings. A user file that also sets `permissions.disableBypassPermissionsMode: "disable"` doesn't count.
- `bypass-prompt-skipped` counts user and local files only, because the key isn't honored in a project's shared file. Claude Code writes this key to your user settings the first time you accept the bypass confirmation.
- `auto`, `acceptEdits`, `plan`, `dontAsk` and `default` are not flagged.

**Hooks.** A PreToolUse matcher group counts for Bash when it holds at least one hook and its matcher matches `Bash`, by the documented rules:

- a missing matcher, `""` or `"*"` matches every tool;
- a matcher of only letters, digits, `_`, `-`, spaces, `,` and `|` is an exact name, or a list of names split on `|` or `,`;
- any other matcher is a JavaScript regular expression and is not anchored, so `^Ba` matches.

`disableAllHooks` takes the value left after settings precedence (local, then shared project, then user). A `true` turns the scope's hooks off.

**Never-fired rules.** Doctor plans `vetobench fix --include-shared` and never applies the plan. Its never-fired count is this estimate, with the same conditions: at least 14 days of history, at least 90% of tool calls carrying a recorded decision, 14 days of each project's own history for that project's files, and only rule shapes the matcher can judge. When fix can't judge, the count is `-` (`null` in JSON) with a note. Rules that `fix` counts as secrets or broad wildcards are left out here, so the same rule is never counted twice. See METHODOLOGY.md, "Fix" and "Unused rules".

### What was checked against Claude Code's documentation

Each settings key and its meaning was checked on 2026-11-25 against Claude Code's official documentation at code.claude.com/docs:

| Key or behavior | Page, section | What the docs say |
| :- | :- | :- |
| `permissions.allow` / `ask` / `deny`; deny first | permissions, "Manage permissions" | Rules are evaluated deny, then ask, then allow |
| Lists merge across files | settings, "Lists merge instead of overriding" | `permissions.allow` and other list keys are combined, not overridden |
| Settings files and precedence | settings, "Settings files and who they affect", "Settings precedence" | User, shared project, project local, managed; precedence is managed, command line, local, shared, user |
| Strict JSON | settings, "Edit a settings file" | A `//` comment or a trailing comma is a syntax error |
| `Bash` and `Bash(*)` | permissions, "Match all uses of a tool" | A bare tool name matches every use; `Bash(*)` is equivalent to `Bash` |
| `:*`, ` *` and `*` in Bash rules | permissions, "Wildcard patterns" | `Bash(ls:*)` matches the same commands as `Bash(ls *)` |
| `mcp__<server>`, `mcp__<server>__*` | permissions, "Tool-specific permission rules" (MCP) and "Wildcard patterns" | Both match every tool of the server; allow globs need a literal `mcp__<server>__` prefix, and `mcp__*` is skipped in allow lists |
| `permissions.defaultMode` | settings-reference, `permissions.defaultMode` | Values `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions` (`manual` is an alias for `default`); `auto` and `bypassPermissions` don't take effect from project or local settings |
| `permissions.disableBypassPermissionsMode` | settings-reference, same name | `"disable"` prevents entering `bypassPermissions` mode |
| `skipDangerousModePermissionPrompt` | settings-reference, same name | Boolean; skips the confirmation before `bypassPermissions` mode; scope is user, local or managed |
| `enableAllProjectMcpServers` | settings-reference, settings index (MCP) | Approves every server in project `.mcp.json` files without a prompt; any file |
| `permissions.additionalDirectories` | settings-reference, same name; permissions, "Working directories" | Gives Claude file access to directories outside the one you started in |
| `hooks.PreToolUse` and matchers | hooks, "Matcher patterns" | The match-all, exact-list and unanchored-regex rules above |
| Hooks merge across files | hooks, the table of hook locations | Hook entries from user, project and local settings merge instead of replacing each other |
| `disableAllHooks` | hooks, "Disable or remove hooks"; settings-reference, `disableAllHooks` | Boolean; resolved by settings precedence, so a project `false` overrides a user `true` |

## Limits

- **Managed settings, `--settings` files, command-line flags and plugins aren't read.** A deny rule, a hook or a mode set there is invisible to doctor. The same goes for `--dangerously-skip-permissions`, `--permission-mode`, `--add-dir`, plugin hooks and hooks in skill or subagent frontmatter. So doctor can report a missing deny rule or hook that your organization actually provides.
- **Workspace trust isn't modeled.** Allow-rules and `additionalDirectories` in a project's shared `.claude/settings.json` take effect only after you trust the folder (permissions, "Project allow rules and workspace trust"), but doctor counts them anyway.
- **Projects are found from your transcripts.** A project you never ran a session in, and that isn't the folder you run doctor from, is not read.
- **Older Claude Code versions differ.** Before v2.1.257, `bypassPermissions` took effect from any settings file. Doctor follows current behavior and counts only the user file.
- **Hooks are counted, not run.** A PreToolUse hook on Bash may do anything, including nothing. Doctor counts that one exists.
- **Secrets and broad wildcards are shapes.** Placeholders count, and secrets in other formats are missed. See METHODOLOGY.md.
- **Never-fired is an estimate.** It uses reconstructed rule matching, like `fix`.
- **`claude doctor` is something else.** It's Claude Code's own command, which lists the settings entries Claude Code rejected. It's unrelated to `vetobench doctor`.
