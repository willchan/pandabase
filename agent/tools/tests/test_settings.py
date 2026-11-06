"""PandaBase's own env file on the Mac: `~/.config/pandabase/agent.env` (DESIGN §6, §10 #58).

Bug: the tools only read the process env, so their token and URL had to live in OpenClaw's
`~/.openclaw/.env`, which the gateway hands to every app's tools. They now read their own file;
the process env still wins (tests, `make smoke`, cron via agent-run.sh).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from pandabase_tools import cli, config

REPO = Path(__file__).resolve().parents[3]


@pytest.fixture
def setup(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    cfg = json.loads((REPO / "agent" / "pandabase.config.example.json").read_text())
    cfg["profiles_file"] = str(REPO / "agent" / "profiles.example.json")
    cfg_path = tmp_path / "pandabase.config.json"
    cfg_path.write_text(json.dumps(cfg))
    env_file = tmp_path / "agent.env"
    env_file.write_text(
        "# PandaBase agent settings\n"
        f"PANDABASE_CONFIG={cfg_path}\n"
        "PANDABASE_API_URL=https://from-file.test\n"
        'PANDABASE_AGENT_API_TOKEN="file-token"\n'
    )
    for key in (config.CONFIG_ENV, config.TOKEN_ENV, config.API_URL_ENV):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv(config.AGENT_ENV_FILE_ENV, str(env_file))
    return env_file


def config_show() -> dict[str, object]:
    env = cli.Env(cli.build_parser().parse_args(["config", "show"]))
    result = cli.cmd_config_show(env)
    assert isinstance(result, dict)
    return result


def test_settings_come_from_pandabase_agent_env(setup: Path) -> None:
    shown = config_show()
    assert shown["token_set"] is True
    assert shown["api_base_url"] == "https://from-file.test"
    assert config.setting(config.TOKEN_ENV) == "file-token"


def test_process_env_wins_over_the_file(setup: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(config.API_URL_ENV, "https://from-env.test")
    monkeypatch.setenv(config.TOKEN_ENV, "env-token")
    assert config_show()["api_base_url"] == "https://from-env.test"
    assert config.setting(config.TOKEN_ENV) == "env-token"


def test_unprefixed_keys_in_the_file_are_ignored(setup: Path) -> None:
    setup.write_text("AGENT_API_TOKEN=someone-elses\n")
    assert config.setting(config.TOKEN_ENV) == ""
    assert config.setting("AGENT_API_TOKEN") == ""


def test_missing_file_is_fine(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(config.TOKEN_ENV, raising=False)
    monkeypatch.setenv(config.AGENT_ENV_FILE_ENV, str(tmp_path / "nope.env"))
    assert config.setting(config.TOKEN_ENV) == ""
