# vetobench mcp

## What it does

`vetobench mcp` counts your MCP permission surface: the MCP servers Claude Code is set up to start, the allow-rules that let their tools run without asking, the project servers that start without asking, and who approved the MCP tool calls in your transcripts. It prints counts only, never a server name, tool name, URL, command, env value, header or path, so the output is safe to paste in public. It only reads files.

It reports:

- **Servers by scope and transport:** user, local, project (`.mcp.json`) and managed scope, each split into stdio, http, sse and other.
- **Servers whose every tool is allowed by a rule:** an allow-rule such as `mcp__server__*` or `mcp__server` covers the whole server, including tools it adds later.
- **Allow-rules for MCP tools, by kind:** whole server, a pattern (`mcp__server__get_*`), single tools (`mcp__server__tool`), and rules that approve nothing. It also counts deny-rules and ask-rules, and allow-rules that name a server found in no config file read and never called in the window.
- **Project servers that start without asking:** `.mcp.json` servers approved by name (`enabledMcpjsonServers`) or by the all-servers switch (`enableAllProjectMcpServers`), the ones rejected, and the ones that still wait for your approval. It also counts the settings files that turn the switch on. In your user or managed settings, the switch approves the `.mcp.json` servers of every project, including a repository you clone tomorrow.
- **MCP tool calls in the window and who approved them:** static allow-rule, AI classifier, you through a permission prompt, or blocked, with shares, using the same gates as the card (see [METHODOLOGY.md](../METHODOLOGY.md#gates)). It also counts the servers called, split into configured, from a plugin, claude.ai connector, or found in no config read.
- **Which kind of rule a rule-approved call matches now:** a whole-server rule, a pattern, a single-tool rule, or no rule in your settings files. This is the MCP counterpart of the card's wildcard count.

## Usage

```
npx vetobench mcp [transcripts-dir] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--json]
```

- `transcripts-dir`: default `~/.claude/projects`.
- `--since` / `--until`: window the tool calls by UTC day (`--until` is exclusive). Servers, rules and approvals are always read as they are now.
- `--json`: the same counts as JSON.

## How it works

### Sources

Each location and key below was checked against Claude Code's documentation on 2026-11-25.

| What | Where vetobench reads it | Documentation |
|---|---|---|
| User-scope servers | `mcpServers` at the top of `~/.claude.json` | [MCP](https://code.claude.com/docs/en/mcp): "User-scoped servers are stored in `~/.claude.json`". The page names the file, not the key; vetobench reads the top-level `mcpServers`, which has the same shape as a local-scope entry |
| Local-scope servers | `projects["<folder>"].mcpServers` in `~/.claude.json` | [MCP: local scope](https://code.claude.com/docs/en/mcp#local-scope): "Claude Code stores it in `~/.claude.json` under that project's path", with a JSON example of that shape |
| Project-scope servers | `mcpServers` in `.mcp.json` at a project's root folder | [MCP: project scope](https://code.claude.com/docs/en/mcp#project-scope) |
| Managed servers | `mcpServers` in `managed-mcp.json`, and `managedMcpServers` in managed settings | [Managed MCP](https://code.claude.com/docs/en/managed-mcp) and [settings reference: `managedMcpServers`](https://code.claude.com/docs/en/settings-reference#managedmcpservers) |
| Managed folder | macOS `/Library/Application Support/ClaudeCode/`, Linux and WSL `/etc/claude-code/`, Windows `C:\Program Files\ClaudeCode\`, with drop-ins in `managed-settings.d/`: every `*.json` file there, in alphabetical order after `managed-settings.json`, hidden files left out | [Managed settings: where each mechanism stores the policy](https://code.claude.com/docs/en/managed-settings#where-each-mechanism-stores-the-policy) and [split a file-based policy across teams](https://code.claude.com/docs/en/managed-settings#split-a-file-based-policy-across-teams) |
| Transport | the entry's `type`: `stdio`, `http` (`streamable-http` is an alias), `sse`; no `type` means stdio. An entry with a `url` but no `type` is a configuration error that Claude Code skips; vetobench counts it as other, with `ws` and `sdk` | [MCP](https://code.claude.com/docs/en/mcp): "Claude Code reads an entry with no `type` as a stdio server" |
| Permission rules | `permissions.allow`, `deny`, `ask` in `~/.claude/settings.json`, a project's `.claude/settings.json` and `.claude/settings.local.json`, and managed settings | [Settings](https://code.claude.com/docs/en/settings) |
| MCP rule syntax | `mcp__<server>` and `mcp__<server>__*` match every tool of a server, `mcp__<server>__<tool>` one tool. Allow-rules accept a glob only after a literal `mcp__<server>__` prefix: `"mcp__*"` and `"*"` approve nothing, and a `mcp__` rule with parentheses is skipped. For a server whose name contains `__` or ends in `_`, only the `mcp__<server>__*` form names it (`mcp__reports__v2__*`); the bare `mcp__reports__v2` is read as tool `v2` of a server named `reports`. vetobench takes any run of `*` after the last `__` as the wildcard form, and sorts rules with the same function as `vetobench doctor` (`parseMcpRule` in `src/rules.js`) | [Permissions: MCP](https://code.claude.com/docs/en/permissions#mcp), [tool name wildcards](https://code.claude.com/docs/en/permissions#tool-name-wildcards) and [match by input parameter](https://code.claude.com/docs/en/permissions#match-by-input-parameter) |
| Server name in rules and tool names | each character outside `A-Z`, `a-z`, `0-9`, `_` and `-` becomes `_` (`my.server` becomes `my_server`). Plugin servers are `plugin_<plugin>_<server>`, connectors Claude Code fetches are `claude_ai_<server>` | [Permissions: MCP](https://code.claude.com/docs/en/permissions#mcp) and [MCP: plugin-provided servers](https://code.claude.com/docs/en/mcp#plugin-provided-mcp-servers) |
| Project server approvals | `enableAllProjectMcpServers` (boolean), `enabledMcpjsonServers` and `disabledMcpjsonServers` (lists of names from `.mcp.json`), in any settings file. Claude Code writes them to `.claude/settings.local.json` when you answer its approval dialog. A rejection wins over both approvals; for the switch, a `false` in a higher-precedence file overrides a `true` in a lower one | [Settings reference](https://code.claude.com/docs/en/settings-reference#enableallprojectmcpservers) and [MCP: project server approvals](https://code.claude.com/docs/en/mcp#project-server-approvals-and-workspace-trust) |
| MCP tool calls | tool calls named `mcp__<server>__<tool>` in the transcripts, with the recorded decision of each | the scanner behind the card ([METHODOLOGY.md](../METHODOLOGY.md#data)) |

### Projects

vetobench reads the project files of every folder that `~/.claude.json` keeps settings for, every folder a counted session ran in, and the folder you run it from. Folders that no longer exist are counted but not read. For each folder it reads `.mcp.json` and the local-scope servers in `~/.claude.json`, and it finds the project's settings files the same way the card does (the nearest folder at or above it with a `.claude/settings.json` or `.claude/settings.local.json`, stopping below your home folder).

### Counting

- **A server** is counted once per scope, name and definition. The same `.mcp.json` copied into several worktrees of a repository is one server. A definition that differs (another command, URL or env value) is another server.
- **Every tool allowed:** a server counts when a whole-server allow-rule for its name, spelled as in its tool names, is in managed or user settings, or in the settings of a project where the server applies. For user and managed servers, any project's settings count.
- **Project server status:** a rejection (`disabledMcpjsonServers`) wins, then an approval by name, then `enableAllProjectMcpServers`, taken from the highest-precedence file that sets it (managed, then project local, then shared project, then user). A server copied into several projects counts with its most open status: if it starts without asking in one of them, it counts as starting without asking.
- **Rules** are counted once per distinct rule across all files read, so a rule copied into several worktrees' settings counts once.
- **Calls:** each tool call is counted once, as on the card, and the window applies to the tool result's timestamp. The servers called are told apart by the server part of the tool name. A decision is named after the whole scan, so a resumed session whose decision sits in an earlier transcript than its tool call still counts as an MCP call. Transcripts that can't be read are skipped and counted (`calls.unreadable` in JSON), as `vetobench drift` does.
- **Rule-approved calls:** a call whose gate is a static allow-rule is matched against the rules in effect for its session now (managed, user, and its project's), the same way the card matches shell commands. A single-tool rule outranks a pattern, which outranks a whole-server rule. A pattern is a glob in which `*` matches any text, matched in time linear in the tool name however many `*` it has. "No rule" means the rule that approved it is gone from your settings files, or came from somewhere vetobench does not read (see Limits).

## Limits

- **The config is read as it is now.** Servers, rules and approvals are not windowed: a rule added after a call still matches it, and a removed server no longer counts.
- **Workspace trust is not modelled.** Claude Code ignores the approvals in a project's shared `.claude/settings.json`, and applies those in `.claude/settings.local.json`, only after you accept the folder's trust dialog. vetobench counts them either way, so for folders you never trusted it can overcount the servers that start without asking.
- **Not read:** servers that plugins bring (their tool calls are still counted, as from a plugin), claude.ai connectors (likewise), servers passed with `--mcp-config`, rules passed on the command line (`--allowedTools`), servers you turned off in `/mcp`, a `CLAUDE_CONFIG_DIR` other than `~/.claude`, and the `allowedMcpServers` / `deniedMcpServers` lists in managed settings.
- **Only managed files are read.** Managed settings delivered as server-managed settings, by an MDM profile or plist, or through the Windows registry (`HKLM` or `HKCU`) are not read, so their servers, rules and approvals are missing from the counts. When one of those sources supplies your organization's policy, Claude Code may skip the managed files that vetobench does read.
- **Only the project's own folder** is searched for `.mcp.json`, not its parent folders.
- **A managed `managed-mcp.json`** makes Claude Code load only its servers. vetobench says so, but still counts the servers in the other scopes.
- **Tool names are split heuristically** when a server is not configured: the server part is the text before the first `__`, so a plugin or removed server with `__` in its name counts as another server. A whole-server rule is matched by its `mcp__<server>__` prefix, so `mcp__reports` also matches the tools of a server named `reports__v2`, which Claude Code would not approve.
- **The transport is the configured one.** vetobench never starts or contacts a server, so it cannot tell whether a server works or which tools it offers.
