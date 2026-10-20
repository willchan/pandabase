"""Image normalization (EXIF rotate, ≤ 2048px, JPEG, metadata stripped) and presigned URLs."""

import io

import pillow_heif
import pytest
from PIL import Image

from pandabase_worker.contracts import KeyframeUpload
from pandabase_worker.media import MediaError, normalize


def encode(im: Image.Image, fmt: str, **kw: object) -> bytes:
    out = io.BytesIO()
    im.save(out, fmt, **kw)
    return out.getvalue()


def decode(data: bytes) -> Image.Image:
    im = Image.open(io.BytesIO(data))
    im.load()
    return im


def test_exif_orientation_is_applied_and_stripped() -> None:
    im = Image.new("RGB", (400, 200), "white")
    im.paste((255, 0, 0), (0, 0, 40, 200))  # red stripe on the left edge
    exif = Image.Exif()
    exif[0x0112] = 6  # Orientation: rotate 90° CW to display
    exif[0x8825] = {2: (37.0, 46.0, 30.0)}  # GPS
    out = decode(normalize(encode(im, "JPEG", exif=exif.tobytes())))
    assert out.format == "JPEG"
    assert out.size == (200, 400)  # portrait after rotation
    pixel = out.getpixel((100, 10))
    assert isinstance(pixel, tuple) and pixel[0] > 200  # the stripe is now at the top
    assert not out.getexif()  # no orientation, no GPS


def test_large_images_are_downscaled_and_small_ones_kept() -> None:
    big = decode(normalize(encode(Image.new("RGB", (5000, 3000)), "PNG")))
    assert big.size == (2048, 1229)
    small = decode(normalize(encode(Image.new("RGB", (640, 480)), "PNG")))
    assert small.size == (640, 480)


def test_rgba_png_and_heic_become_rgb_jpeg() -> None:
    rgba = decode(normalize(encode(Image.new("RGBA", (300, 300), (0, 0, 255, 128)), "PNG")))
    assert (rgba.format, rgba.mode) == ("JPEG", "RGB")
    heif = pillow_heif.from_pillow(Image.new("RGB", (320, 240), "green"))
    buf = io.BytesIO()
    heif.save(buf, quality=80)
    heic = decode(normalize(buf.getvalue()))
    assert (heic.format, heic.size) == ("JPEG", (320, 240))


def test_unreadable_media_is_a_media_error() -> None:
    with pytest.raises(MediaError, match="unreadable image"):
        normalize(b"definitely not an image")


def test_presigned_urls_survive_contract_parsing() -> None:
    url = (
        "https://acct.r2.cloudflarestorage.com/pandabase/keyframes/01JOB/0.jpg?X-Amz-Algorithm="
        "AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F20261020%2Fauto%2Fs3%2Faws4_request"
        "&X-Amz-Date=20261020T160000Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host"
        "&X-Amz-Signature=0123abcd"
    )
    upload = KeyframeUpload.model_validate({"key": "keyframes/01JOB/0.jpg", "url": url})
    assert str(upload.url) == url  # re-encoding would break the signature
