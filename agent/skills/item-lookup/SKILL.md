---
name: item-lookup
description: Answer "do we have X?" / "how much X is left?" anywhere in Discord from PandaBase's inventory estimate, with an honest confidence hint.
metadata:
  {
    "openclaw":
      {
        "emoji": "🔎",
        "requires": { "bins": ["pandabase-tools"], "env": ["AGENT_API_TOKEN", "PANDABASE_CONFIG"] },
      },
  }
---

# Item lookup

Trigger: a household member asks whether we have something, how much is left, or whether to buy
it — in `#pandabase`, a cycle thread, a DM, or another channel where you were mentioned (often
from a store aisle, so answer fast and short). Read-only: no writes, no `--actor`.

```sh
pandabase-tools api get /api/items/lookup -q q=<item words>
```

- Post `matches[0].text` as-is (it already carries the estimate and confidence, e.g.
  "~2 milk (bought Oct 12, unverified) → probably fine").
- If `matches[1]` is a different item with a similar `score` (within 0.1), add its `text` as a
  second line. Never more than two lines.
- No matches: "❓ I don't track <words> yet." Don't ask a follow-up question.
- Several items in one question ("milk and eggs?"): one lookup per item, one line each.

Don't add advice beyond the text, don't nag about counting, and don't offer to add it to the
list unless they ask (then hand off to `grocery-cycle`). On an error exit, reply
"⚠️ Can't reach PandaBase right now."
