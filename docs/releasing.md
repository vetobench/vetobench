# Releasing vetobench

A release is a `v*` tag pushed on `main`. The tag starts [`.github/workflows/release.yml`](../.github/workflows/release.yml), which runs the full CI and then publishes the package to npm through trusted publishing, with a provenance attestation. Nobody publishes from a laptop, and the repository holds no npm token.

## How a release runs

1. **The `test` job** calls [`ci.yml`](../.github/workflows/ci.yml): the tests on Node 18, 20 and 22, every CLI mode with networking switched off, and the check-settings action. The publish job waits for all of it.
2. **The `publish` job** runs in the `npm` environment with `id-token: write`, the only job that can request an OIDC token. It
   - checks that npm is 11.5.1 or later, the minimum for trusted publishing (the job uses Node 24, which bundles one);
   - checks that the tag equals `v` plus the `version` in `package.json`, and stops if not;
   - runs `npm publish --provenance --access public`.
3. **Trusted publishing:** npm exchanges the job's OIDC token for a short-lived publish token, and only for this repository, this workflow file and this environment. No `NPM_TOKEN` secret exists to leak.
4. **Provenance:** `--provenance` attaches a signed statement, recorded in the public Sigstore transparency log, that links the package to the workflow run and the tagged commit.

The GitHub Action in [`action/`](../action/README.md) needs no publishing step: it runs from the repository itself, so every tag is also an action release. Its users pin the tag's commit SHA.

## Cut a release

1. On a branch, set the new `version` in `package.json`, add its section to `CHANGELOG.md` (with any retractions), and update `CLAIMS.md` and the README for any number or output that changed. Open a pull request; `main` is protected, so this is the only way in.
2. Once it is merged and CI is green on `main`, tag the merge commit and push the tag:

   ```sh
   git switch main
   git pull --ff-only
   git tag -a v0.3.0 -m "vetobench 0.3.0"
   git push origin v0.3.0
   ```

3. Watch the `release` run under Actions. If the `npm` environment has protection rules, approve the deployment there.

A tag that does not match `package.json` stops the publish job before anything reaches npm. Delete the tag (`git push origin :refs/tags/v0.3.0` and `git tag -d v0.3.0`), fix `main` through a pull request, and tag again.

npm versions are immutable: a published version cannot be replaced, and unpublishing is limited by npm's policy. If a release is wrong, deprecate it with `npm deprecate vetobench@0.3.0 "<reason>"`, release a patch, and record what happened in `CHANGELOG.md`.

## Verify a release

- **On the npm page:** [npmjs.com/package/vetobench](https://www.npmjs.com/package/vetobench) shows a Provenance section for the version, with links to the commit and the workflow run that built it. Check that it names `vetobench/vetobench`, `.github/workflows/release.yml` and the tag's commit.
- **With npm:** in an empty folder,

  ```sh
  npm init -y
  npm install vetobench@0.3.0
  npm audit signatures
  ```

  It should report a verified registry signature and a verified attestation for the package. A version without provenance did not come from this repository: report it privately, as [SECURITY.md](../SECURITY.md) describes. (The `0.0.0` placeholders only reserve the name.)

## The trusted publisher on npmjs.com

Trusted publishing is set up once, under the package's Settings > Trusted publishing: GitHub Actions, organization `vetobench`, repository `vetobench`, workflow `release.yml`, environment `npm`. Every field must match the workflow exactly; renaming the workflow file or the environment breaks publishing until the configuration is updated.

A new trusted-publisher configuration has to be validated by a successful publish: one with no successful publish within 2 days expires. When you add or re-create it, do so on the day of a release or the day before, then push the tag.

npm refuses `--provenance` from a private repository, so the repository has to stay public for releases to work.
