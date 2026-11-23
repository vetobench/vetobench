# Changelog

Notable changes to vetobench, newest first. Versions follow [Semantic Versioning](https://semver.org/).

Corrections to published numbers go here as **retractions**: the claim as published, the corrected number, why it was wrong, and the [CLAIMS.md](CLAIMS.md) line it affects. That line stays in CLAIMS.md, marked retracted, so the record stays complete.

## Unreleased

### Added

- The card: `npx vetobench` reads the Claude Code transcripts on your machine and prints who approved each tool call (static allow-rules, the AI classifier, or you through a permission prompt), as counts and shares only. Options: `[dir]`, `--since`, `--until`, `--json`.
- Supply-chain hardening for the repository: every GitHub Action pinned to a full commit SHA and kept current by Dependabot, a read-only default token, and no persisted git credentials in any workflow.
- An OpenSSF Scorecard workflow.
- A release workflow: a `v*` tag runs the same tests as CI, then publishes to npm through trusted publishing (no long-lived token) with provenance.
- CONTRIBUTING.md and this changelog.

### Retractions

None.
