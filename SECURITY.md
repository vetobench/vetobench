# Security

vetobench reads sensitive local files (agent transcripts and settings). Its promise is that it never sends anything anywhere and never prints secrets.

## Report privately

Use GitHub's private vulnerability reporting on this repository ("Report a vulnerability" under the Security tab) for:

- any network activity by vetobench;
- output that reveals commands, paths, prompts, rule bodies or secret values;
- a tampered release or package, or a compromised publishing path.

You will get a reply within 72 hours.

## Report publicly

A guard verdict you think vetobench mis-scored, or a rule it misclassifies, is not a vulnerability. Open a normal issue with a synthetic reproduction (a dedicated "wrong verdict" form arrives with the benchmark). Never paste real transcripts.

## Releases

Every vetobench release on npm that contains the CLI is published by [`.github/workflows/release.yml`](.github/workflows/release.yml) from a version tag, through npm trusted publishing, and carries a provenance attestation linking it to the tagged commit in this repository. The repository holds no npm token. The package page on npmjs.com shows the provenance, and `npm audit signatures` verifies it for an installed copy. The `0.0.0` placeholders only reserve the name. Any other version without provenance did not come from this repository: report it privately.
