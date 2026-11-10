# Phase 2: the Mac mini

This guide puts PandaBase's Mac side on a Mac mini: the worker, the agent tools and skills, one
signed-in browser per member, and the OpenClaw automations. It is the order that worked on a
fresh Mac mini (Apple silicon, 32GB) in November 2026, with these choices:

- a dedicated **agent account** that runs everything, separate from your admin account;
- **Colima** for Docker (Docker Desktop works too; see [README step 8](../README.md#8-mac-mini-base));
- **Google Chrome** for the per-member browsers (Homebrew's `chromium` cask was disabled on
  2026-09-01);
- a **local reply model** on Ollama, so photos never leave the Mac
  ([README *Photo privacy*](../README.md#photo-privacy), option C).

Do [Phase 1](SETUP-CLOUD.md) first: this guide reuses its tokens and member names. The
[README checklist](../README.md#setup-from-zero) explains each step in more depth; this page is
the short path. Budget an afternoon, most of it model downloads and the backfill.

> Never paste tokens into chat, issues or commits. Every value below comes from your Phase 1
> password-manager note and goes only into gitignored files on the Mac.

## Before you start

Have these ready on the Mac mini. How you install the OS-level pieces is up to you; PandaBase only
needs them present.

- **Two macOS accounts.** An **admin** account that owns Homebrew, and a **Standard** account for
  the agent that logs in automatically (*Users & Groups → Automatically log in as*). The browsers
  and Ollama need a GUI session after a power cut.
  - *FileVault trade-off:* automatic login needs FileVault **off**, so an unattended restart comes
    back on its own but the disk isn't encrypted at rest. With FileVault on, every reboot waits
    for a password at the Mac.
  - *Energy:* prevent automatic sleeping; start up automatically after a power failure.
- **Homebrew** (as the admin) with: `node@24` (linked), `pnpm` 12, `uv`, `jq`, `git`,
  `colima`, `docker` (the CLI), `docker-compose`, and the casks `google-chrome` and `ollama`.
  The agent account uses `/opt/homebrew/bin` from its `PATH`; it doesn't need to own Homebrew.
- **Docker's compose plugin** found by the CLI: in the agent account's `~/.docker/config.json`,

  ```json
  { "cliPluginsExtraDirs": ["/opt/homebrew/lib/docker/cli-plugins"] }
  ```

  Check: `docker compose version`.
- **Ollama.app** opened once in the agent account, with *launch at login* on.
- **OpenClaw** installed for the agent account and **onboarded on a local Ollama model** (pull it
  first: `ollama pull qwen3.5:27b`, or the most capable model your memory allows). Onboarding
  writes `~/.openclaw/openclaw.json` and lists every pulled Ollama model; PandaBase's config is a
  patch on top of that.
- **A Discord bot** (Developer Portal application) and a server with a `#pandabase` channel.
- **Firewall on** (*System Settings → Network → Firewall*).

Everything below runs **as the agent account**, from the repo root unless it says otherwise.

## 1. Repo and tools

```sh
git clone https://github.com/willchan/pandabase.git ~/Code/pandabase && cd ~/Code/pandabase
make install
```

Check: `node -v` → v24, `pnpm -v` → 12, `uv --version`.

## 2. Secrets

```sh
cp ops/mac.env.example .env
make secrets
```

Then edit `.env` and paste the **prod** `AGENT_API_TOKEN` and `WORKER_API_TOKEN` from your Phase 1
note, and set `PANDABASE_API_URL` to the production URL. `make secrets` keeps values that are
already set and never prints them.

`AUTH_SECRET` and `CRON_SECRET` live only in Vercel. `make secrets` also writes a `.env.vercel`
with fresh values; the Mac doesn't need it, so delete it (`rm .env.vercel`) and skip
`make vercel-env`.

## 3. Ollama

```sh
make install-ollama-env   # OLLAMA_NUM_PARALLEL=1, OLLAMA_MAX_LOADED_MODELS=1, OLLAMA_NO_CLOUD=1
# quit Ollama from the menu bar and open it again so it reads them
ollama pull qwen3.5:9b    # the VLM: receipts, Trash Cam, OpenClaw's photo descriptions
ollama pull qwen3.5:4b    # merge suggestions (optional: README "Single-model option")
```

With a ~25GB reply model there's room for one model at a time: keep
`OLLAMA_MAX_LOADED_MODELS=1` and let Ollama swap (the first reply after a photo waits a few
seconds while the reply model reloads). `OLLAMA_NO_CLOUD=1` turns off Ollama's cloud models.

**Also turn on Ollama → Settings → Airplane mode.** The Ollama app passes its own
`OLLAMA_NO_CLOUD` to the server from that setting, overriding launchd, so with Airplane mode off
the server runs with `OLLAMA_NO_CLOUD=0` and cloud models stay reachable.

Check: `ps eww -p "$(pgrep -f 'ollama serve' | head -1)" | tr ' ' '\n' | grep '^OLLAMA_'` shows
all three at their values (that's what the server actually got; `launchctl getenv` only shows
what was set); a `:cloud` model is refused with "ollama cloud is disabled"; `ollama list` shows
the models.

**On a shared host** (other apps on the same Ollama, a host-level runbook): Ollama's settings
and which models are pulled belong to the host, not to PandaBase. Skip `make install-ollama-env`
and check the host sets the three values above. PandaBase's own needs are the VLM
(`OLLAMA_VLM_MODEL`, ~7–8GB loaded) and the text model (`OLLAMA_TEXT_MODEL`, ~4GB, or the VLM
under the single-model option), each loaded briefly per job, plus OpenClaw's reply model if it
runs on this Ollama (README "Memory budget").

## 4. Agent tools and config

```sh
make install-agent-tools
```

This creates `agent/pandabase.config.json` and `agent/profiles.json` (gitignored). Fill them in as
[README step 9](../README.md#9-mac-mini-agent-tools-and-worker) describes. One member is fine to
start: remove the second from both files and add them later.

Discord ids: turn on **Developer Mode** (*Settings → Advanced*), then right-click (long-press on a
phone) the server, channel or user → *Copy ID*. On iOS, the quickest way to get your own user id
is to send `\@yourname` in a channel: Discord shows the raw `<@id>` mention.

In `.env`, `CHROMIUM_BIN` already points at Google Chrome
(`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`).

Check: `scripts/ops/agent-run.sh config show` prints your members and `"token_set": true`.

## 5. OpenClaw: Discord, PandaBase config, skills, automations

1. **Discord plugin.** If `openclaw plugins list` doesn't show Discord, install it at your
   OpenClaw version and pin it:

   ```sh
   openclaw plugins install @openclaw/discord@<your openclaw version> --pin
   ```

   Then connect the bot token as OpenClaw's docs describe.
2. **Discord portal and server.** Enable **Message Content Intent** for the bot. Invite it with
   the `bot` scope and, on `#pandabase`: View Channel, Send Messages, Create Public Threads, Send
   Messages in Threads, Add Reactions, Read Message History, Attach Files.
3. **PandaBase's gateway config.**

   ```sh
   cp agent/openclaw.pandabase.example.json5 agent/openclaw.pandabase.json5
   # edit: guild id, #pandabase id, the members' Discord ids (both places)
   openclaw config patch --file agent/openclaw.pandabase.json5 --dry-run   # read the diff
   openclaw config patch --file agent/openclaw.pandabase.json5
   openclaw gateway restart
   ```

   The dry run must not touch `models.providers.ollama.models`: that list comes from onboarding.
   To give the VLM a small context and short keep-alive, set its params by index:

   ```sh
   openclaw config get models.providers.ollama.models --json   # find qwen3.5:9b's index
   openclaw config set "models.providers.ollama.models[<i>].params" \
     '{"num_ctx":8192,"keep_alive":"2m"}' --strict-json
   ```
4. **Skills and automations.**

   ```sh
   make install-agent-skills   # adds agent/skills; settings → ~/.config/pandabase/agent.env
   openclaw gateway restart    # only if it says so
   make install-agent-cron
   ```

   After later merges this happens by itself: when an update (`make update`, every 15 min) brings
   changes to the jobs, agent configs or installers, it re-runs them, restarting the gateway only
   when its env changed, and posts to #pandabase if that fails. `make mac-rollout` does the same
   by hand (update to the newest green `main`, the installers, then a list of the `pandabase-*`
   automations).

Check:

```sh
openclaw skills check --agent main   # the PandaBase skills are eligible
openclaw automations list    # pandabase-* jobs
openclaw infer image describe --file <any photo> --model ollama/qwen3.5:9b --timeout-ms 180000
```

The image check needs the longer timeout: the default 30s runs out while Ollama swaps models.

## 6. Colima at login, and its firewall rule

Colima runs the worker. Start it at login with a LaunchAgent in the agent account,
`~/Library/LaunchAgents/com.pandabase.colima.plist` (your label and log path may differ):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.pandabase.colima</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/colima</string><string>start</string><string>--foreground</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
```

Load it with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.pandabase.colima.plist`.

The worker only needs the host's Ollama. Containers can otherwise reach every service on the host,
including the browsers' DevTools ports (full control of signed-in Amazon sessions) and the
OpenClaw gateway. Limit them with a `provision:` script in `~/.colima/default/colima.yaml`
(Colima's host address is `192.168.5.2`):

```yaml
provision:
  - mode: system
    script: |
      iptables -N DOCKER-USER 2>/dev/null || true
      for r in "-d 192.168.5.2 -p tcp ! --dport 11434 -j REJECT --reject-with tcp-reset" "-d 192.168.5.2 -p udp -j REJECT"; do
        iptables -C DOCKER-USER $r 2>/dev/null || iptables -I DOCKER-USER $r
      done
```

Restart Colima (`colima stop`, and the LaunchAgent starts it again) so the script runs.

Check: `docker context show` → `colima`; `colima ssh -- sudo iptables -S DOCKER-USER` shows both
rules.

## 7. Worker

```sh
make up      # ghcr.io/willchan/pandabase-worker:main (public image: no docker login)
make logs    # a heartbeat, then "ollama ok"
```

Check (optional): from a container, Ollama answers and other host ports don't:
`docker run --rm curlimages/curl -s -m 3 http://host.docker.internal:11434/api/version` prints a
version; the same against `:9222` fails.

## 8. Browsers, one per member

```sh
make install-chromium
```

Each member gets a Google Chrome window titled "PandaBase · <profile>" with its own user data dir
and a DevTools port on `127.0.0.1` only. Sign in to Amazon **by hand** in each window: use
*Screen Sharing* into the agent account (or sit at the Mac), tick *Keep me signed in*, and visit
Whole Foods on Amazon once to set the store. The tools never sign in.

## 9. Smoke test and backfill

```sh
make smoke      # every check ✓ (README step 13 has the opt-in cart and end-to-end checks)
make backfill   # 12 months of receipts per member; resumable
```

## 10. Automatic updates

```sh
make install-update-timer   # make update every 15 min: newest green main, health check, rollback
```

The worker image on GHCR is public, so there's no `docker login`. Optionally set
`DEPLOY_DISCORD_WEBHOOK_URL` in `.env` for failure posts ([README step 15](../README.md#15-continuous-deployment)).

## Security defaults

- **No web or browser tools for the agent.** The PandaBase patch sets OpenClaw
  `tools.deny: ["group:web", "browser"]`. A small local model with a raw browser next to a
  signed-in Amazon session could be steered by page text into Buy Now; `openclaw security audit`
  reports this combination as critical (`models.small_params`). The cart tools guard against
  checkout in code instead. If your config already has a `tools.deny` list, merge by hand.
- **Only members, everywhere.** The patch's `"*"` channel rule lists the members' user ids, so the
  bot answers only them outside `#pandabase` too.
- **Containers reach the host only on Ollama's port** (the Colima rule in step 6).
- **No cloud models.** `OLLAMA_NO_CLOUD=1`, and no cloud provider keys or fallbacks in OpenClaw.
- **Private state:** `chmod 700 ~/.openclaw`; `.env` is mode 600 (`make secrets` sets it).
- **macOS firewall on.** The DevTools ports are bound to `127.0.0.1` and never exposed.

Run `openclaw security audit` after any OpenClaw config change.
