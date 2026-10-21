"""Smoke: the worker's VLM path on a synthetic receipt (PLAN M6 Notes, check 2).

Runs inside the worker image (`docker compose run`), so it also proves the container reaches the
host's Ollama. Renders a receipt with Pillow, sends it with the current paper_receipt prompt,
the schema as `format` and `keep_alive` 2m (the worker's own client), and checks that the reply
validates as `VlmReceipt` within the time limit. Prints one JSON line; exit 0 pass, 1 fail.
"""

import io
import json
import os
import sys
import time
from pathlib import Path

from PIL import Image, ImageDraw

from pandabase_worker.config import DEFAULT_VLM_MODEL
from pandabase_worker.jobs.paper_receipt import VlmReceipt
from pandabase_worker.ollama import OllamaClient, OllamaError, ParseFailure
from pandabase_worker.prompts import load_prompt

LIMIT_SECONDS = float(os.environ.get("SMOKE_VLM_SECONDS", "60"))
ROWS = [
    "PANDABASE SMOKE TEST MARKET",
    "1 TEST WAY  10/18/2026",
    "BANANAS                  0.91",
    "WHOLE MILK 1GAL          4.29",
    "SOURDOUGH BREAD          5.99",
    "SUBTOTAL                11.19",
    "TAX                      0.00",
    "TOTAL                   11.19",
]


def receipt_png() -> bytes:
    im = Image.new("RGB", (900, 40 + 60 * len(ROWS) + 40), "white")
    d = ImageDraw.Draw(im)
    for n, row in enumerate(ROWS):
        d.text((40, 40 + n * 60), row, fill="black", font_size=36)
    out = io.BytesIO()
    im.save(out, "PNG")
    return out.getvalue()


def main() -> int:
    model = os.environ.get("OLLAMA_VLM_MODEL") or DEFAULT_VLM_MODEL
    url = os.environ.get("OLLAMA_URL", "http://host.docker.internal:11434")
    prompt = load_prompt(Path(os.environ.get("PROMPTS_DIR", "/app/prompts")), "paper_receipt")
    client = OllamaClient(url)
    start = time.monotonic()
    try:
        inf = client.generate(model, prompt.system, prompt.render(), VlmReceipt, [receipt_png()])
    except (OllamaError, ParseFailure) as err:
        print(json.dumps({"ok": False, "model": model, "error": str(err)}))
        return 1
    finally:
        client.close()
    seconds = round(time.monotonic() - start, 1)
    lines = len(inf.value.lines)
    ok = seconds <= LIMIT_SECONDS and lines > 0
    print(
        json.dumps(
            {
                "ok": ok,
                "model": model,
                "prompt_version": prompt.version,
                "seconds": seconds,
                "limit_seconds": LIMIT_SECONDS,
                "lines": lines,
                "total": inf.value.total,
                "repaired": inf.repaired,
            }
        )
    )
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
