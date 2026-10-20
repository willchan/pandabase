"""HTTP with bounded retries for transient failures (network errors, 429, 5xx)."""

import logging
import time
from collections.abc import Callable, Mapping

import httpx

from pandabase_worker.config import HTTP_ATTEMPTS, HTTP_BACKOFF_SECONDS

log = logging.getLogger(__name__)

Sleep = Callable[[float], None]


def is_transient(status: int) -> bool:
    return status == 429 or status >= 500


def request_with_retries(
    client: httpx.Client,
    method: str,
    url: str,
    *,
    sleep: Sleep = time.sleep,
    attempts: int = HTTP_ATTEMPTS,
    json: object = None,
    content: bytes | None = None,
    headers: Mapping[str, str] | None = None,
) -> httpx.Response:
    """Send a request, retrying transient failures with exponential backoff.

    Returns the last response (callers check its status); raises the last transport error if
    every attempt failed to get one. Only send non-idempotent requests here with an
    `Idempotency-Key` (or when a repeat is harmless).
    """
    delay = HTTP_BACKOFF_SECONDS
    for n in range(1, attempts + 1):
        try:
            res = client.request(method, url, json=json, content=content, headers=headers)
        except httpx.TransportError as err:
            if n == attempts:
                raise
            log.warning("%s %s failed (%s); retry %d/%d", method, _path(url), err, n, attempts - 1)
        else:
            if not is_transient(res.status_code) or n == attempts:
                return res
            log.warning(
                "%s %s → %d; retry %d/%d", method, _path(url), res.status_code, n, attempts - 1
            )
        sleep(delay)
        delay *= 2
    raise AssertionError("unreachable")


def _path(url: str) -> str:
    """URL without its query string: presigned URLs carry credentials."""
    return url.split("?", 1)[0]
