# Claims ledger

Every number published about vetobench or from it. Status: **measured** (reproducible from a command and corpus), **estimated** (model or approximation) or **retracted** (wrong; kept here on purpose).

| # | Claim | Status | Window / corpus | Reproduce |
|---|---|---|---|---|
| 1 | 237,578 of 237,951 tool calls carry a recorded permission decision | measured | 2026-10-22..2026-11-20, author's private corpus (1,744 transcripts) | `node bin/vetobench.js <snapshot> --since 2026-10-22 --until 2026-11-21` |
| 2 | Static allow-rules approved 72.7%, the AI classifier 26.8% | measured | same | same |
| 3 | 12 actions were approved by the author through a permission prompt (0.005%); 69 more `user_*` decisions were answers to the agent's questions | measured | same | same; chat approvals not counted |
| 4 | At least 29,319 static-approved shell actions relied on a wildcard interpreter/remote rule | estimated (lower bound; reconstructed rule matching against pre-cleanup settings) | same | `approval_split.py` in the author's research repo; to be ported |
| 5 | 1,293 allow-rules, 0 deny, 0 ask; 33 held secrets inline (before cleanup) | measured | author's settings, 2026-11-20 | settings backups, counts only |
| 6 | 873 database URLs with passwords in plaintext transcripts | measured | 30 days to 2026-11-20 | secrets scan, counts only |
| 7 | A small prod-write hook would have asked 20 times in 30 days; 17 were right | measured (author's hand review) | 260,333 shell commands, same window | replay script, to be ported |
