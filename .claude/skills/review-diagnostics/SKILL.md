---
name: review-diagnostics
description: The PandaBase "review diagnostics" playbook — read the agent's weekly diagnostics reports, rank issues by household impact, and propose evidence-backed fixes for approval. Use when asked to review diagnostics, the weekly report, or PRD §6 metrics.
---

# Reviewing PandaBase diagnostics

When asked to review diagnostics (normally run on the Mac Mini, where the gitignored repo-root
`diagnostics/` holds the agent's weekly output — "`/diagnostics`" below):

1. Read the last 4 weekly reports in `/diagnostics/*.md` (newest first). Note the *Summary* findings
   and any metric trending the wrong way vs PRD §6 targets.
2. For the top issues, open the matching JSONL extracts in `/diagnostics/YYYY-Www/` and look at
   concrete cases (and keyframes by R2 key if needed — ask before downloading many).
3. Rank issues by household impact: wrong/missing cart lines > wasted human effort > data quality >
   performance.
4. For each top issue, propose a change with evidence: prompt (new version file), threshold
   (`web/lib/config.ts`), matching/learning logic, model choice, or tool/selector fix. Estimate the
   effect using the extracts where possible (e.g. "replaying last 4 weeks of receipts with
   threshold 0.80 would auto-match 12 more lines, 1 wrong").
5. Present the ranked proposals and wait for approval. Implement approved ones as PRs that include
   before/after evidence and update DESIGN.md if behavior changes.
6. Check ROADMAP "Candidate improvements" — if the evidence now supports one, say so.
