Ollama `/api/chat` (non-streaming) and `/api/tags` responses in Ollama's wire shape, used by the
tests in place of a live Ollama. Synthetic: the receipt content matches the fake receipt the
tests render with Pillow (`tests/conftest.py`), not any real purchase. To re-record against a
live model, POST the request the worker sends (`format`, `keep_alive: "2m"`, `think: false`) and
save the response body here, scrubbed of anything real.
