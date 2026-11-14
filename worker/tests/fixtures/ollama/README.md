Ollama `/api/chat` (non-streaming) and `/api/tags` responses in Ollama's wire shape, used by the
tests in place of a live Ollama. Synthetic: the receipt content matches the fake receipt the
tests render with Pillow (`tests/conftest.py`), not any real purchase. To re-record against a
live model, POST the request the worker sends (`format`, `think: false`, `num_ctx` 32768,
`keep_alive: "30m"`) and save the response body here, scrubbed of anything real.

`merge_suggest.looping.json` is a synthetic repetition loop: the same suggestion over and over,
cut off mid-entry by `num_predict` (`done_reason: "length"`), as the 4B text model did on a
40-item batch in production (2026-11-09; the real output wasn't kept).
