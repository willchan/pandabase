"""Versioned prompt files: `prompts/{job_type}.v{N}.md` (CLAUDE.md: a change is a new version).

A file holds the system prompt, then a line `---user---`, then the user message template.
The highest version wins; jobs record it as `prompt_version` (e.g. `paper_receipt.v1`).
"""

import re
from dataclasses import dataclass
from pathlib import Path

SEPARATOR = "---user---"


@dataclass(frozen=True)
class Prompt:
    version: str
    system: str
    user: str

    def render(self, **values: str) -> str:
        out = self.user
        for k, v in values.items():
            out = out.replace("{{" + k + "}}", v)
        return out


def load_prompt(prompts_dir: Path, job_type: str) -> Prompt:
    pattern = re.compile(rf"^{re.escape(job_type)}\.v(\d+)\.md$")
    found = [
        (int(m.group(1)), p)
        for p in prompts_dir.iterdir()
        if (m := pattern.match(p.name)) is not None
    ]
    if not found:
        raise FileNotFoundError(f"no prompt for {job_type} in {prompts_dir}")
    n, path = max(found)
    system, sep, user = path.read_text().partition(SEPARATOR)
    if not sep:
        raise ValueError(f"{path.name}: missing {SEPARATOR} line")
    return Prompt(f"{job_type}.v{n}", _strip_header(system), user.strip())


def _strip_header(text: str) -> str:
    """Drop the leading `<!-- … -->` maintainer comment, if any."""
    t = text.strip()
    if t.startswith("<!--"):
        t = t.split("-->", 1)[1]
    return t.strip()
