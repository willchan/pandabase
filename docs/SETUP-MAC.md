# Phase 2: the Mac mini

This guide puts PandaBase's Mac side on a Mac mini: the worker, the agent tools and skills, one
signed-in browser (the cart member's Amazon session), and the `pandabase` agent's OpenClaw
automations. It is the order that worked on a
fresh Mac mini (Apple silicon, 32GB) in November 2026, with these choices:

- a dedicated **agent account** that runs everything, separate from your admin account;
- **Colima** for Docker (Docker Desktop works too; see [README step 8](../README.md#8-mac-mini-base));
- **Google Chrome** for PandaBase's browser (Homebrew's `chromium` cask was disabled on
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
start: remove the second and add them later. Only the cart member has a `profile` (`pandabase`,
the one key in `profiles.json`); the others have none.

Discord ids: turn on **Developer Mode** (*Settings → Advanced*), then right-click (long-press on a
phone) the server, channel or user → *Copy ID*. On iOS, the quickest way to get your own user id
is to send `\@yourname` in a channel: Discord shows the raw `<@id>` mention.

In `.env`, `CHROMIUM_BIN` already points at Google Chrome
(`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`).

Check: `scripts/ops/agent-run.sh config show` prints your members and `"token_set": true`.

## 5. OpenClaw: Discord, PandaBase config, skills, automations

The gateway may host more than one agent on the same Discord bot, routed by channel and by DM
sender. PandaBase's config describes the **`pandabase` agent**: the agent bound to `#pandabase` (and
the household's other shared channels), on the local model, with no web or browser tools, and
the one the automations run as. Any other agents (e.g. a member's personal agent for their own DMs
and channels) are set up outside this repo, and may have the PandaBase skill and token too. So not
every Discord message reaches the `pandabase` agent, and the `pandabase` agent isn't the only one
that can call PandaBase; shared data lives in PandaBase, not in agent memory.

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
   ```

   The patch is gateway-wide (the `#pandabase` channel policy, local photo descriptions) and
   leaves the arrays other agents and onboarding share alone: `agents.list`, `bindings` and
   `models.providers.ollama.models`. The dry run must not touch any of them. Per-agent and
   per-model settings go in by index instead:

   ```sh
   # the `pandabase` agent: no web or browser tools (Security defaults below)
   openclaw config get agents.list --json   # find the `pandabase` agent's index and id
   openclaw config set "agents.list[<i>].tools.deny" '["group:web","browser"]' --strict-json
   # the VLM: a small context and short keep-alive
   openclaw config get models.providers.ollama.models --json   # find qwen3.5:9b's index
   openclaw config set "models.providers.ollama.models[<i>].params" \
     '{"num_ctx":8192,"keep_alive":"2m"}' --strict-json
   openclaw gateway restart
   ```

   Name the agent `pandabase` and put `OPENCLAW_AGENT=pandabase` in `.env` (unset, it is `main`):
   the installers and the 15-minute updater add the automations and check the skills as that agent.
4. **Skills and automations.**

   ```sh
   make install-agent-skills   # adds agent/skills (gateway-wide); settings → ~/.config/pandabase/agent.env
   openclaw gateway restart    # only if it says so
   make install-agent-cron     # as OPENCLAW_AGENT
   ```

   After later merges this happens by itself: when an update (`make update`, every 15 min) brings
   changes to the jobs, agent configs or installers, it re-runs them, restarting the gateway only
   when its env changed, and posts to #pandabase if that fails. `make mac-rollout` does the same
   by hand (update to the newest green `main`, the installers, then a list of the `pandabase-*`
   automations).

Check:

```sh
openclaw skills check --agent pandabase   # the PandaBase skills are eligible
openclaw automations list    # pandabase-* jobs, all on the `pandabase` agent
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

## 8. PandaBase's browser

```sh
make install-chromium
```

PandaBase drives one browser profile, **`pandabase`**: the cart member's Amazon session, in a
Google Chrome window titled "PandaBase · pandabase" with its own user data dir
(`~/Library/Application Support/PandaBase/chromium-pandabase`) and a DevTools port on `127.0.0.1`
only (9222). Sign in to Amazon **by hand** in that window: use *Screen Sharing* into the agent
account (or sit at the Mac), tick *Keep me signed in*, and visit Whole Foods on Amazon once to set
the store. Optionally name the Chrome profile "PandaBase" (profile menu → *Customize profile*).
The tools never sign in.

Members' own Chrome profiles, e.g. one per member for their personal OpenClaw agents, aren't
PandaBase's. They're set up outside this repo, under their own names, and must not reuse
PandaBase's user data dir or DevTools port, or be attached to it as an OpenClaw browser profile.
Members other than the cart member have no `profile` in `agent/pandabase.config.json`, and so no
receipt sweep.

### Renaming the browser profile to `pandabase`

For a Mac set up when the profile was named after a member (`will`: LaunchAgent
`com.pandabase.chromium.will`, data dir `…/PandaBase/chromium-will`). **Unverified: not yet run on
the Mac.** These steps stop and restart PandaBase's Chrome, so do them by hand, outside the Friday
evening and Saturday morning windows, with no PandaBase job running.

1. Nothing holds the profile: `scripts/ops/agent-run.sh lock status --member will` shows no lease.
2. Stop the old Chrome and remove its LaunchAgent (this quits that Chrome window):

   ```sh
   launchctl bootout "gui/$(id -u)/com.pandabase.chromium.will"
   rm ~/Library/LaunchAgents/com.pandabase.chromium.will.plist
   pgrep -fl 'PandaBase/chromium-will' || echo stopped   # must print "stopped" before step 3
   ```
3. Move the data dir (same volume, so it's a rename):

   ```sh
   mv ~/"Library/Application Support/PandaBase/chromium-will" \
      ~/"Library/Application Support/PandaBase/chromium-pandabase"
   ```
4. Edit the gitignored configs: in `agent/profiles.json` rename the key `will` to `pandabase` and
   its `user_data_dir` to `~/Library/Application Support/PandaBase/chromium-pandabase`; in
   `agent/pandabase.config.json` set the cart member's `"profile": "pandabase"` and remove
   `profile` from every other member (or give them `receipt_sweep: "off"`).
5. Start the new one and check it: `make install-chromium` (it warns about any other
   `com.pandabase.chromium.*` agent still loaded), then `make smoke` (`cdp-…` should attach and
   show the cart page signed in), then `make install-agent-cron`.
6. Record it in the database: Actions → Bootstrap → `add-member` with your member number and
   profile `pandabase` (or `pnpm db:add-member --email … --profile pandabase`). The State Engine
   only stores this column; the tools read the profile from the config files.
7. Optional: in that Chrome, profile menu → *Customize profile* → name it "PandaBase".

Does it sign Amazon out? It shouldn't: the cookies move with the data dir, and Chrome on macOS
encrypts them with the "Chrome Safe Storage" Keychain item, which belongs to the app and the
macOS account, not to the folder, so the same Chrome in the same account can still read them.
Amazon may still ask for the password again on its own schedule, as it does anyway. If step 5
shows signed out, sign in by hand as in step 8 above. To avoid the move altogether, keep the old
folder: rename only the key, and leave `user_data_dir` pointing at `…/chromium-will`.

Code from before this change also works with the renamed configs, and new code works with the old
ones, so the order against the 15-minute updater doesn't matter.

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

- **No web or browser tools for the `pandabase` agent.** Its entry in `agents.list` has
  `tools.deny: ["group:web", "browser"]` (step 5). It's per agent: other agents on the gateway may
  have web tools and a browser, with their own Chrome profiles. A small local model with a raw
  browser next to a signed-in Amazon session could be steered by page text into Buy Now;
  `openclaw security audit` reports this combination as critical (`models.small_params`). The cart
  tools guard against checkout in code instead. If an older PandaBase patch left the deny in the
  gateway-wide `tools` block, move it: `openclaw config unset tools.deny`, then step 5's
  `config set`. An agent with the browser must never be given an OpenClaw browser profile that
  attaches to PandaBase's DevTools port.
- **Only members, everywhere.** The patch's `"*"` channel rule lists the members' user ids, so the
  bot answers only them outside the channels configured by name (if another agent's setup has its
  own `"*"` rule, merge the user lists).
- **Containers reach the host only on Ollama's port** (the Colima rule in step 6).
- **No cloud models for the `pandabase` agent.** `OLLAMA_NO_CLOUD=1`, and no cloud fallbacks on
  its model. Other agents' models are their own setup's choice; a photo sent to one of them
  follows its model ([README *Photo privacy*](../README.md#photo-privacy)).
- **Private state:** `chmod 700 ~/.openclaw`; `.env` is mode 600 (`make secrets` sets it).
- **macOS firewall on.** The DevTools ports are bound to `127.0.0.1` and never exposed.

Run `openclaw security audit` after any OpenClaw config change.
