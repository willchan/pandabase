---
name: telemetry-aggregator
description: Weekly PandaBase diagnostics — fetch the rendered report, write it to /diagnostics on the Mac Mini, and post a 3-line summary to #pandabase (Sunday 23:00 automation).
metadata:
  {
    "openclaw":
      {
        "emoji": "📊",
        "requires": { "bins": ["pandabase-tools"], "env": ["AGENT_API_TOKEN", "PANDABASE_CONFIG"] },
      },
  }
---

# Telemetry aggregator

Trigger: the Sunday 23:00 automation, or someone asks for "diagnostics for 2026-W42".

```sh
pandabase-tools diagnostics write
```

(`--week 2026-W42` for a specific week; the default is the last complete household week.) It
writes `/diagnostics/<week>.md` and `/diagnostics/<week>/*.jsonl` (the `diagnostics_dir` in the
config; never committed) and prints `{week, files, summary}` — `summary` is the report's top 3
findings.

Post once to `channels.ops_channel` (`#pandabase`):

> 📊 **Diagnostics 2026-W42** — `/diagnostics/2026-W42.md`
> 1. Tier-1 cart injection succeeded for 82% of lines (target ≥ 90%).
> 2. 1 media job(s) failed.
> 3. 2 review item(s) expired unanswered.

With an empty `summary`: "📊 Diagnostics 2026-W42 written — nothing notable." On an error
exit: "⚠️ Couldn't write diagnostics for <week>: <error>." Don't interpret or act on the
findings — the review happens with Claude using the CLAUDE.md "review diagnostics" playbook.
