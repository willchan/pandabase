"""Media: presigned download, normalization (EXIF rotate, ≤ 2048px, JPEG), keyframe upload."""

import io
import time

import httpx
import pillow_heif
from PIL import Image, ImageOps, UnidentifiedImageError

from pandabase_worker.config import API_TIMEOUT_SECONDS, JPEG_QUALITY, MAX_IMAGE_PX
from pandabase_worker.contracts import KeyframeUpload
from pandabase_worker.http import Sleep, request_with_retries

pillow_heif.register_heif_opener()  # iPhone photos arrive as HEIC


class MediaError(Exception):
    pass


def normalize(data: bytes, max_px: int = MAX_IMAGE_PX) -> bytes:
    """Decode any supported image, apply EXIF orientation, fit within `max_px`, re-encode JPEG.

    Re-encoding also strips EXIF (incl. GPS) from the keyframe we keep forever.
    """
    try:
        with Image.open(io.BytesIO(data)) as src:
            im = ImageOps.exif_transpose(src)
            if im.mode != "RGB":
                im = im.convert("RGB")
            im.thumbnail((max_px, max_px), Image.Resampling.LANCZOS)
            out = io.BytesIO()
            im.save(out, "JPEG", quality=JPEG_QUALITY, optimize=True)
            return out.getvalue()
    except (UnidentifiedImageError, OSError, ValueError) as err:
        raise MediaError(f"unreadable image: {err}") from err


class MediaClient:
    """Presigned R2 URLs need no credentials; they carry their own signature."""

    def __init__(
        self, *, transport: httpx.BaseTransport | None = None, sleep: Sleep = time.sleep
    ) -> None:
        self._http = httpx.Client(timeout=API_TIMEOUT_SECONDS, transport=transport)
        self._sleep = sleep

    def close(self) -> None:
        self._http.close()

    def download(self, url: str) -> bytes:
        res = request_with_retries(self._http, "GET", url, sleep=self._sleep)
        if res.status_code != 200:
            raise MediaError(f"media download failed: HTTP {res.status_code}")
        return res.content

    def upload_keyframe(self, upload: KeyframeUpload, jpeg: bytes) -> str:
        """PUT a keyframe (idempotent: same key, same bytes) and return its R2 key."""
        res = request_with_retries(
            self._http,
            "PUT",
            str(upload.url),
            content=jpeg,
            headers={"content-type": "image/jpeg"},
            sleep=self._sleep,
        )
        if res.status_code not in (200, 201, 204):
            raise MediaError(f"keyframe upload failed: HTTP {res.status_code}")
        return upload.key
