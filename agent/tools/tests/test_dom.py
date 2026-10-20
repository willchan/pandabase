from __future__ import annotations

from pandabase_tools import dom


def test_asin_from_dp_gp_product_and_slugged_links() -> None:
    assert dom.asin_from_href("/dp/B0SYNTH001") == "B0SYNTH001"
    assert dom.asin_from_href("/Organic-Bananas/dp/B0SYNTHWF1?ref=x") == "B0SYNTHWF1"
    assert dom.asin_from_href("https://www.amazon.com/gp/product/B0SYNTHWF4?psc=1") == "B0SYNTHWF4"
    assert dom.asin_from_href("/gp/product/B0SYNTHWF3/") == "B0SYNTHWF3"
    assert dom.asin_from_href("/dp/B0SYNTH00") is None  # 9 chars
    assert dom.asin_from_href("/dp/B0SYNTH0011") is None  # 11 chars
    assert dom.asin_from_href("/s?k=dp/B0SYNTH001") is None  # not in the path


def test_text_keeps_blocks_and_skips_scripts() -> None:
    root = dom.parse("<div>a <b>b</b></div><script>x()</script><p>c</p><br>d")
    assert root.text() == "a b\nc\nd"


def test_stray_end_tags_and_void_elements() -> None:
    root = dom.parse("<div><img src=x><input name=a></span>t</div>")
    assert root.text() == "t"
    assert [n.attrs["name"] for n in root.find_all("input")] == ["a"]
