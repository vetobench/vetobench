## What and why

<!-- One or two sentences. Link the issue if there is one. -->

## Checklist

- [ ] `node --test` passes.
- [ ] Zero network: nothing in `bin/` or `src/` imports a network-capable module or calls a network API, and `test/no-egress.test.js` is not weakened.
- [ ] No runtime dependency and no install script added.
- [ ] Output is counts, shares and version strings only: no commands, paths, prompts, rule bodies or secrets.
- [ ] Fixtures are synthetic and hand-written: no real transcripts, settings, labels or commands.
- [ ] Every new or changed public number has its line in `CLAIMS.md`, with the command that reproduces it.
- [ ] Docs match the change (README, `METHODOLOGY.md`, `CHANGELOG.md`, `--help`).
- [ ] No attribution lines in the commits or this description (no `Co-Authored-By:` trailers, no "Generated with" footers).
