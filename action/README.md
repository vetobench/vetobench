# vetobench check-settings action

A GitHub Action that fails a job when a repository's committed Claude Code settings allow too much. It checks every rule in `permissions.allow` and fails when one:

- **holds a secret:** a password, key or token written into the rule (database URLs with a password, `PGPASSWORD=`, private keys, API keys and tokens, JWTs, `*_TOKEN=` and similar assignments). A `$VARIABLE` in place of the value is fine;
- **is a broad wildcard** on an interpreter or remote command: `python3:*`, `node:*`, `bash:*`, `ssh:*`, `curl:*`, `git:*`, `gh:*`, `npm:*`, `docker:*`, `sudo:*` and the rest of the `BROAD` list in [`src/analyze.js`](../src/analyze.js). Narrow rules such as `Bash(git status)` or `Bash(npm run lint:*)` pass;
- **allows every shell command:** `Bash`, `Bash()`, `Bash(*)`, `Bash(:*)`, `Bash(**)`, `Bash(* *)`, or any other rule whose parentheses hold only `*` and spaces. A `*` in a Bash rule matches any text, spaces included ([permissions, "Wildcard patterns"](https://code.claude.com/docs/en/permissions#wildcard-patterns));
- **is too long to check:** a rule over 4,096 characters is never run through the secret patterns, because some of them take quadratic time on a crafted rule, and a pull request from a fork can commit any settings file. Such a rule fails the check on its own.

It also fails when a file you named is missing or a file is not valid JSON (comments and a byte-order mark are accepted). These are the same secret and wildcard checks that `vetobench fix` uses, and the same bare-Bash shape that `vetobench doctor` counts.

## Usage

```yaml
name: claude-settings
on:
  pull_request:
    paths: ['.claude/**']
  push:
    branches: [main]
    paths: ['.claude/**']
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 22
      - uses: vetobench/vetobench/action@COMMIT_SHA # v0.3.0
```

`timeout-minutes: 5` caps the job: the check takes seconds, and a cap stops a pull request from holding a runner for GitHub's six-hour default.

Replace `COMMIT_SHA` with the full commit SHA of the release tag you choose, as the other two actions are pinned. `git ls-remote https://github.com/vetobench/vetobench 'refs/tags/v0.3.0*'` prints it: take the line that ends in `^{}` if there is one, otherwise the only line. A tag name or a branch would let a later push change the code your CI runs.

The action needs Node.js 18 or later on the runner. GitHub-hosted runners ship with one, but `actions/setup-node` keeps the version fixed; the action stops with an error when it finds no Node.js or an older one.

### Inputs

| Input | Default | What it does |
|---|---|---|
| `files` | `.claude/settings.json` and `.claude/settings.local.json`, the ones present | Settings files to check, relative to the workspace, separated by spaces or newlines. A path may not contain a space or start with `-`. |

For a repository with several projects, name each file:

```yaml
      - uses: vetobench/vetobench/action@COMMIT_SHA # v0.3.0
        with:
          files: |
            .claude/settings.json
            services/api/.claude/settings.json
```

Claude Code keeps `settings.local.json` out of git by default, so in CI the default usually checks `.claude/settings.json` alone. With no settings file present, the check passes and says there was nothing to check.

## What it reads, and what it prints

- **Only the settings files in the checked-out repository:** the two defaults or the files you name. It reads no transcripts, nothing in the runner's home folder (`~/.claude`) and no other file.
- **Nothing to install, nothing sent.** The action runs `node` on the vetobench code that GitHub downloaded with the action, at the commit you pinned. vetobench has no dependencies, so no package is installed, and that code makes no network calls (the repository's tests and CI enforce this). It needs no token and no permission beyond `contents: read` for the checkout.
- **Counts only.** The log shows how many files and rules were checked and how many failed each check, never a rule, a path or a secret, so it is safe in a public repository's CI log:

```
vetobench 0.3.0 check-settings: 1 settings file(s), 5 allow-rule(s)

  Rules with a secret inside                             1
  Broad wildcards (python3:*, ssh:*, git:* ...)          1
  Bare Bash (allows every shell command)                 1
  Rules too long to check (over 4,096 characters)        0

3 allow-rule(s) to remove or narrow. Open the file(s) on your machine to find them.
Check failed.
Counts only: no rule, path or secret is printed.
```

That is the output for [`test/fixtures/check-settings/risky.json`](../test/fixtures/check-settings/risky.json). A secret that the check finds in a committed file is already in the repository's history: rotate it, then remove the rule.

It does not check deny or ask rules, `defaultMode`, hooks, `env` values, or settings outside the repository (your own `~/.claude/settings.json`, managed settings).

## The same check without the action

```sh
npx vetobench check-settings                       # the two default files in this folder
npx vetobench check-settings path/to/settings.json --json
```

Exit code 0 means the check passed (or there was nothing to check), 1 that it failed. `--json` prints the same counts as JSON.
