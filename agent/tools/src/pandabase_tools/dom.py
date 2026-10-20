"""A tiny HTML tree (stdlib `html.parser`) for layout-agnostic extraction.

Parsing works on page HTML captured from the browser, so the extraction rules are plain functions
tested against saved fixtures. Rules key off URLs (`/dp/{ASIN}`, `orderID=`), form actions,
`name`/`itemprop` attributes and visible text, never class names, so small layout changes don't
break them (DESIGN §6).
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from html.parser import HTMLParser
from urllib.parse import parse_qs, urljoin, urlsplit

VOID_TAGS = frozenset(
    {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param"}
    | {"source", "track", "wbr"}
)
SKIP_TEXT_TAGS = frozenset({"script", "style", "noscript", "template"})
BLOCK_TAGS = frozenset(
    {"address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt", "fieldset"}
    | {"figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header"}
    | {"hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "tbody", "td", "tfoot"}
    | {"th", "thead", "tr", "ul"}
)

# ASINs are 10 upper-case alphanumerics; Amazon links carry them as /dp/{ASIN} or
# /gp/product/{ASIN} (optionally after a slug: /Some-Title/dp/{ASIN}).
ASIN_PATH = re.compile(r"/(?:dp|gp/product|gp/aw/d)/([A-Z0-9]{10})(?=[/?#]|$)")


@dataclass(eq=False)
class Node:
    tag: str
    attrs: dict[str, str] = field(default_factory=dict)
    children: list[Node | str] = field(default_factory=list)
    parent: Node | None = None

    def iter(self) -> Iterator[Node]:
        """This node and every descendant element, document order."""
        yield self
        for child in self.children:
            if isinstance(child, Node):
                yield from child.iter()

    def find_all(self, tag: str) -> list[Node]:
        return [n for n in self.iter() if n.tag == tag]

    def ancestors(self) -> Iterator[Node]:
        node = self.parent
        while node is not None:
            yield node
            node = node.parent

    def text(self) -> str:
        """Visible text with block boundaries as newlines and whitespace collapsed per line."""
        parts: list[str] = []
        _collect_text(self, parts)
        lines = ("".join(parts)).split("\n")
        return "\n".join(t for t in (" ".join(line.split()) for line in lines) if t)


def _collect_text(node: Node, out: list[str]) -> None:
    if node.tag in SKIP_TEXT_TAGS:
        return
    block = node.tag in BLOCK_TAGS
    if block:
        out.append("\n")
    for child in node.children:
        if isinstance(child, str):
            out.append(child)
        else:
            _collect_text(child, out)
    if block:
        out.append("\n")


class _TreeBuilder(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = Node("#document")
        self.current = self.root

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        node = Node(tag, {k: v or "" for k, v in attrs}, parent=self.current)
        self.current.children.append(node)
        if tag not in VOID_TAGS:
            self.current = node

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        node = Node(tag, {k: v or "" for k, v in attrs}, parent=self.current)
        self.current.children.append(node)

    def handle_endtag(self, tag: str) -> None:
        # Close the nearest open element with this tag; ignore stray end tags.
        node: Node | None = self.current
        while node is not None and node.tag != tag:
            node = node.parent
        if node is not None and node.parent is not None:
            self.current = node.parent

    def handle_data(self, data: str) -> None:
        self.current.children.append(data)


def parse(html: str) -> Node:
    builder = _TreeBuilder()
    builder.feed(html)
    builder.close()
    return builder.root


def asin_from_href(href: str) -> str | None:
    match = ASIN_PATH.search(urlsplit(href).path)
    return match.group(1) if match else None


def asin_links(root: Node) -> list[tuple[str, Node]]:
    """(ASIN, <a>) for every product link, document order."""
    out: list[tuple[str, Node]] = []
    for a in root.find_all("a"):
        asin = asin_from_href(a.attrs.get("href", ""))
        if asin:
            out.append((asin, a))
    return out


def asins_in(node: Node) -> set[str]:
    return {asin for asin, _ in asin_links(node)}


def query_param(href: str, name: str) -> str | None:
    values = parse_qs(urlsplit(href).query).get(name)
    return values[0] if values else None


def absolute(base_url: str, href: str) -> str:
    return urljoin(base_url, href)


def widest_ancestor(node: Node, keep: Callable[[Node], bool]) -> Node:
    """Climb from `node` while the ancestor still satisfies `keep(ancestor)`; return the widest."""
    best = node
    for anc in node.ancestors():
        if anc.tag == "#document" or not keep(anc):
            break
        best = anc
    return best
