"""What a job handler gets: the claimed job, its normalized image(s), the model client."""

from dataclasses import dataclass, field
from datetime import date, datetime
from zoneinfo import ZoneInfo

from pandabase_worker.config import Settings
from pandabase_worker.contracts import ClaimedJob
from pandabase_worker.ollama import OllamaClient
from pandabase_worker.prompts import Prompt


@dataclass
class JobContext:
    job: ClaimedJob
    settings: Settings
    ollama: OllamaClient
    prompt: Prompt
    # Normalized JPEGs (the keyframes), empty for text-only jobs.
    images: list[bytes] = field(default_factory=list)

    def today(self) -> date:
        return datetime.now(ZoneInfo(self.settings.household_tz)).date()
