# Claims ledger

Every number published about vetobench or from it. Status: **measured** (reproducible from a command and corpus), **estimated** (model or approximation) or **retracted** (wrong; kept here on purpose).

| # | Claim | Status | Window / corpus | Reproduce |
|---|---|---|---|---|
| 1 | 237,578 of 237,951 tool calls carry a recorded permission decision | measured | 2026-10-22..2026-11-20, author's private corpus (1,744 transcripts) | `node bin/vetobench.js <snapshot> --since 2026-10-22 --until 2026-11-21` |
| 2 | Static allow-rules approved 72.7%, the AI classifier 26.8% | measured | same | same |
| 3 | 12 actions were approved by the author through a permission prompt (0.005%); 72 more `user_*` decisions were answers to the agent's questions | measured | same | same; chat approvals not counted. (Corrected 2026-11-23 from 69, before publication: the CLI counts 72.) |
| 4 | At least 29,319 static-approved shell actions relied on a wildcard interpreter/remote rule | estimated (lower bound; reconstructed rule matching against pre-cleanup settings) | same | `approval_split.py` in the author's research repo; to be ported |
| 5 | 1,293 allow-rules, 0 deny, 0 ask; 33 held secrets inline (before cleanup) | measured | author's settings, 2026-11-20 | settings backups, counts only |
| 6 | 873 database URLs with passwords in plaintext transcripts | measured | 30 days to 2026-11-20 | secrets scan, counts only |
| 7 | A small prod-write hook would have asked 20 times in 30 days; 17 were right | measured (author's hand review) | 260,333 shell commands, same window | replay script, to be ported |
| 8 | 320 allow-rules were deleted in the 2026-11-20 cleanup: 1,293 → 973 (154 global, 166 in one project) | measured | author's settings: backups from 2026-10-20 and 2026-11-06, global snapshot of 2026-11-20, project file as of 2026-11-23 (no post-cleanup snapshot of it) | `jq '.permissions.allow \| length'` on each file; counts only |
| 9 | 69.3% of decisions (164,580) were made inside subagents; none was approved by a human (static rules 73.5%, classifier 26.3%) | measured | 2026-10-22..2026-11-20, 1,352 subagent transcripts | `node bin/vetobench.js <snapshot> --since 2026-10-22 --until 2026-11-21 --json` (`byShape.graph`) |
| 10 | 28.3% of decisions (67,118) were made in main interactive sessions; all 12 human approvals happened there | measured | same, 370 sessions | same (`byShape.interactive`) |
| 11 | 2.5% of decisions (5,880) were made in sessions that ran a loop (`/loop`, `/goal`, ScheduleWakeup, CronCreate); none was approved by a human | measured (whole-session label: includes the turns before the loop started) | same, 22 sessions | same (`byShape.loop`) |
