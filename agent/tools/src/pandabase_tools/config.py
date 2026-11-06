"""Agent pack configuration: `pandabase.config.json` + `profiles.json` (examples in `/agent`).

Secrets never live in these files: the API token comes from `PANDABASE_AGENT_API_TOKEN`. It's
prefixed because OpenClaw's env file is shared by every app's tools on the Mac (the engine and
the repo `.env` still call it `AGENT_API_TOKEN`). Tool tunables (batch sizes, throttles,
lookbacks) live here with their defaults so the JSON only needs what differs.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Annotated, Literal

from pydantic import BaseModel, Field, StringConstraints

CONFIG_ENV = "PANDABASE_CONFIG"
TOKEN_ENV = "PANDABASE_AGENT_API_TOKEN"
API_URL_ENV = "PANDABASE_API_URL"


class DiscordConfig(BaseModel):
    guild_id: str
    # v1: all three are the one #pandabase channel (DESIGN §6).
    cycle_channel: str
    intake_channel: str
    ops_channel: str


class Member(BaseModel):
    name: str
    discord_id: str
    profile: str
    cart_member: bool = False
    receipt_sweep: Literal["daily", "weekly", "off"] = "weekly"


class CartConfig(BaseModel):
    batch_size: int = Field(default=10, ge=1, le=50)
    # Whole Foods via the add-to-cart URL is unverified (DESIGN §6) until `make smoke` proves it;
    # while false, Whole Foods lines go straight to `needs_agent`.
    wholefoods_tier1: bool = False
    tier1_vendors: list[str] = Field(default_factory=lambda: ["amazon"])
    max_price_checks: int = Field(default=20, ge=0, le=200)
    page_delay_seconds: float = Field(default=1.5, ge=0)
    # How tier 1 adds a line: `product_page` (its `/dp/` page's own add-to-cart form, verified by
    # the cart count; `cart_add.py`) or `add_url` (the batched `/gp/aws/cart/add.html` link, which
    # stopped adding anything on 2026-11-04 — kept for when/if it comes back).
    tier1_method: Literal["product_page", "add_url"] = "product_page"
    # Tier 2 (`cart search` / `cart add`): candidates per search, characters of page text per
    # field returned to the model, and the most units one `cart add` may put in the cart.
    tier2_search_limit: int = Field(default=5, ge=1, le=10)
    tier2_title_chars: int = Field(default=160, ge=40, le=300)
    tier2_max_qty: int = Field(default=10, ge=1, le=50)
    # Layout watch (`layout_watch.py`): a build alerts the ops channel when at least this many
    # tier-1 lines failed for a page reason *and* they're at least this share of what tier 1 tried.
    layout_alert_min_lines: int = Field(default=2, ge=1)
    layout_alert_share: float = Field(default=0.5, gt=0, le=1)
    # The weekly add-button check (`cart probe`): one product ASIN per store ("amazon",
    # "wholefoods") whose page it opens. Pick everyday items that are rarely out of stock.
    probe_asins: dict[
        Literal["amazon", "wholefoods"],
        Annotated[str, StringConstraints(pattern=r"^[A-Z0-9]{10}$")],
    ] = Field(default_factory=dict)


class ReceiptsConfig(BaseModel):
    throttle_seconds: float = Field(default=3.0, ge=0)
    sweep_lookback_days: int = Field(default=14, ge=0)
    initial_sweep_days: int = Field(default=30, ge=1)
    backfill_months: int = Field(default=12, ge=1, le=36)
    max_pages: int = Field(default=60, ge=1)
    page_text_limit: int = Field(default=8000, ge=500)
    order_list_url: str = "https://www.amazon.com/your-orders/orders?timeFilter=months-3"
    backfill_list_urls: list[str] = Field(
        default_factory=lambda: ["https://www.amazon.com/your-orders/orders?timeFilter=year-{year}"]
    )
    order_details_url: str = "https://www.amazon.com/your-orders/order-details?orderID={order_id}"


class ToolsConfig(BaseModel):
    api_base_url: str
    web_url: str | None = None
    household_tz: str = "America/Los_Angeles"
    discord: DiscordConfig
    members: list[Member]
    profiles_file: str = "profiles.json"
    state_dir: str = "~/.pandabase/state"
    diagnostics_dir: str = "/diagnostics"
    cart: CartConfig = Field(default_factory=CartConfig)
    receipts: ReceiptsConfig = Field(default_factory=ReceiptsConfig)

    def member(self, name_or_discord_id: str) -> Member:
        for m in self.members:
            if name_or_discord_id in (m.name, m.discord_id):
                return m
        raise KeyError(f"unknown member {name_or_discord_id!r}")

    def cart_member(self) -> Member:
        for m in self.members:
            if m.cart_member:
                return m
        raise KeyError("no member has cart_member: true")


class Profile(BaseModel):
    """One member's long-lived Chromium, started with --remote-debugging-port (see M7 Notes)."""

    cdp_url: str = Field(pattern=r"^http://(127\.0\.0\.1|localhost):\d+/?$")
    user_data_dir: str | None = None
    openclaw_browser_profile: str | None = None


class ProfilesFile(BaseModel):
    profiles: dict[str, Profile]


class Loaded(BaseModel):
    config: ToolsConfig
    profiles: dict[str, Profile]
    config_path: str

    def profile(self, member: Member) -> Profile:
        try:
            return self.profiles[member.profile]
        except KeyError:
            raise KeyError(f"profile {member.profile!r} missing from profiles file") from None

    def state_dir(self) -> Path:
        path = Path(self.config.state_dir).expanduser()
        path.mkdir(parents=True, exist_ok=True)
        return path


def load(path: str | None = None) -> Loaded:
    config_path = Path(path or os.environ.get(CONFIG_ENV) or "pandabase.config.json").expanduser()
    config = ToolsConfig.model_validate(json.loads(config_path.read_text()))
    if os.environ.get(API_URL_ENV):
        config.api_base_url = os.environ[API_URL_ENV]
    profiles_path = Path(config.profiles_file).expanduser()
    if not profiles_path.is_absolute():
        profiles_path = config_path.parent / profiles_path
    profiles = ProfilesFile.model_validate(json.loads(profiles_path.read_text())).profiles
    return Loaded(config=config, profiles=profiles, config_path=str(config_path))
