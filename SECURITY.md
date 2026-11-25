# Security

vetobench reads sensitive local files (agent transcripts and settings). Its promise is that it never sends anything anywhere and never prints secrets.

## Report privately

Use GitHub's private vulnerability reporting: [report a vulnerability](https://github.com/vetobench/vetobench/security/advisories/new) (also under the Security tab, "Report a vulnerability"). Please report:

- any network activity by vetobench;
- output that reveals commands, paths, prompts, rule bodies or secret values;
- a tampered release or package, or a compromised publishing path.

You will get a reply within 72 hours. The process: I confirm the report, fix it in a private fork where possible, publish a release with the fix, and then disclose it in a GitHub security advisory with credit to you (unless you prefer not to be named). Please give me up to 90 days before you disclose publicly.

## Report publicly

A guard verdict you think vetobench mis-scored, or a rule it misclassifies, is not a vulnerability. Open a normal issue with a synthetic reproduction (a dedicated "wrong verdict" form arrives with the benchmark). Never paste real transcripts.

## Releases

Every vetobench release on npm that contains the CLI is published by [`.github/workflows/release.yml`](.github/workflows/release.yml) from a version tag, through npm trusted publishing, and carries a provenance attestation linking it to the tagged commit in this repository. The repository holds no npm token. The package page on npmjs.com shows the provenance, and `npm audit signatures` verifies it for an installed copy. The `0.0.0` placeholders only reserve the name. Any other version without provenance did not come from this repository: report it privately.
