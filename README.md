# PandaBase

A household operating system for groceries: a Next.js + Turso **State Engine** and our family
**OpenClaw agent** working together over Discord and the browser to keep track of what we have,
predict what we need, and fill the weekly Whole Foods/Amazon cart (cart only, never checkout).

- [Product requirements](docs/PRD.md): what it does and why
- [Design](docs/DESIGN.md): architecture, schema, API, algorithms, agent
- [Build plan](docs/PLAN.md) · [Roadmap](docs/ROADMAP.md) · [CLAUDE.md](CLAUDE.md) (dev commands)

```
 phones ──Google──▶ Vercel: web UI + API + daily cron ──▶ Turso (libSQL)
                        ▲ bearer tokens (outbound only)
 Mac Mini: OpenClaw + skills ─ pandabase-tools ─ CDP ─▶ Chromium (one per member, signed in)
           worker (Docker) ─▶ Ollama (native, Metal)          media: Cloudflare R2
```

The Mac Mini makes outbound connections only. Details: [DESIGN §1](docs/DESIGN.md#1-architecture).

---

## Setup from zero

> **No computer yet? Do Phase 1 from your phone:** [docs/SETUP-PHONE.md](docs/SETUP-PHONE.md)
> sets up Turso, R2, Google sign-in, Vercel and the GitHub deploy from Safari and the GitHub app.
> It covers steps 2–4, 6, 7 and 15.1–15.3 below and changes step 5; each of those steps says so.

You need: a Mac Mini (Apple silicon, 32GB; macOS with a GUI login), the household's existing
OpenClaw gateway on it with a Discord bot, a Discord server with a `#pandabase` channel, each
member's Amazon account, a GitHub checkout of this repo, and accounts at **Turso**,
**Cloudflare** (R2), **Google Cloud** (OAuth) and **Vercel**. Do the steps in order; each
ends with a check. Commands run from the repo root unless they say otherwise.

### 1. Tools

On the Mac Mini (and on a laptop if you prefer to do steps 2–7 there):

```sh
brew install git jq uv node@24 tursodatabase/tap/turso && brew link --force node@24
brew install --cask docker chromium ollama   # Docker Desktop, Chromium, Ollama.app
npm i -g pnpm@12 vercel
git clone https://github.com/willchan/pandabase.git && cd pandabase   # private repo: gh auth login first
pnpm install && make install
```

Check: `node -v` → v24, `pnpm -v` → 12, `uv --version`, `turso --version`, `vercel --version`.

### 2. Turso (database)

*Phase 1 done? Skip: it created both databases and tokens in the Turso dashboard.*

```sh
turso auth login
turso db create pandabase           # production
turso db create pandabase-preview   # Vercel preview deployments
turso db show pandabase --url             # → TURSO_DATABASE_URL (libsql://…)
turso db tokens create pandabase          # → TURSO_AUTH_TOKEN
turso db show pandabase-preview --url     # preview URL
turso db tokens create pandabase-preview  # preview token
```

Keep the four values for step 6. They go to Vercel only (the Mac Mini never touches the DB).

### 3. Cloudflare R2 (photos and keyframes)

*Phase 1 done? Skip.*

1. Cloudflare dashboard → **R2** → *Create bucket* `pandabase-media` (location: automatic).
2. R2 → *Manage API tokens* → *Create API token*: permission **Object Read & Write**, scoped to
   that bucket only. Note the **Access Key ID** and **Secret Access Key**, and your **Account
   ID** (R2 overview page).
3. Lifecycle: **none for v1**. Photos and `keyframes/` are kept indefinitely
   ([DESIGN §5](docs/DESIGN.md#5-media-pipeline)); the 90-day video rule arrives with video
   audits (v1.1).

No CORS rule is needed: uploads come from the Mac Mini, and the web UI shows photos through
presigned links.

### 4. Google OAuth (sign-in)

*Phase 1 done? Skip.*

1. [Google Cloud console](https://console.cloud.google.com/) → new project `pandabase` →
   *APIs & Services* → *OAuth consent screen*: External, app name PandaBase, your email; add both
   members' Gmail addresses as **test users** (Testing mode is fine and limits who can sign in).
2. *Credentials* → *Create credentials* → *OAuth client ID* → Web application. Authorized
   redirect URIs:
   - `https://<your production domain>/api/auth/callback/google`
   - `http://localhost:3000/api/auth/callback/google` (local dev)
   - each preview origin you'll sign in on, `https://<preview host>/api/auth/callback/google`
3. Note the **Client ID** and **Client secret** for step 6.

### 5. Generate secrets

*Phase 1 done? Don't generate new ones: Vercel already has yours. `cp ops/mac.env.example .env`,
paste `AGENT_API_TOKEN`, `WORKER_API_TOKEN` and `PANDABASE_API_URL` from your password manager,
create `.env.vercel` with `AUTH_SECRET=…` and `CRON_SECRET=…`, then run `make secrets` (it keeps
every value already set; copy the template first, because an existing `.env` is kept as is and
doesn't get the template's other settings). Skip `make vercel-env`.*

```sh
make secrets
```

Creates `.env` (Mac Mini runtime: `AGENT_API_TOKEN`, `WORKER_API_TOKEN`, settings) and
`.env.vercel` (`AUTH_SECRET`, `CRON_SECRET`), both mode 600 and gitignored, and fills in any
empty secret. It never prints or replaces an existing value, so it's safe to re-run. If you ran
it on a laptop, copy both files to the Mac Mini's checkout over a secure channel (e.g.
`scp`) — the tokens must match on both sides. Then edit `.env`: set `PANDABASE_API_URL` to
your production URL (step 6).

### 6. Vercel (web app, API, cron)

*Phase 1 done? Skip, except item 4 (the URL in `agent/pandabase.config.json` comes with step 9).*

1. Vercel → *Add New Project* → import this repo. **Root Directory: `web`** (framework Next.js;
   pnpm is detected from the lockfile; keep "include files outside the root directory" on — the
   app imports `/db`).
2. Environment variables — **Production**:

   | Variable | Value |
   |---|---|
   | `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | production DB (step 2) |
   | `AUTH_SECRET` | from `.env.vercel` |
   | `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | step 4 |
   | `ALLOWED_EMAILS` | both members' Google emails, comma-separated |
   | `AGENT_API_TOKEN`, `WORKER_API_TOKEN` | from `.env` (same values as the Mac Mini) |
   | `CRON_SECRET` | from `.env.vercel` (Vercel Cron sends it as the bearer token) |
   | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | step 3 |
   | `HOUSEHOLD_TZ` | `America/Los_Angeles` |

   **Preview**: the same, except `TURSO_*` = the preview DB. Leave `DEV_AUTH_BYPASS` unset
   everywhere on Vercel (it only works in `next dev` anyway).

   The four generated secrets can be pushed without copy-pasting: `(cd web && vercel link)`,
   then `make vercel-env` (production; `VERCEL_ENVS="production preview" make vercel-env` for
   both). It skips variables that already exist and prints names only.
3. Deploy once by hand (*Deployments → Redeploy*, or `vercel deploy --prod` from the repo root).
   The daily maintenance cron (`web/vercel.json`, 11:17 UTC) registers itself. After that,
   production deploys come only from GitHub Actions (step 15): `web/vercel.json` sets
   `git.deploymentEnabled.main: false`, so a push to `main` no longer deploys on its own (it would
   ship code before its migration). PR previews still build through Vercel's Git integration.
4. Put the production URL in `.env` (`PANDABASE_API_URL`) and in
   `agent/pandabase.config.json` (step 9).

Check: `https://<domain>/sign-in` loads (signing in comes after step 7).

### 7. First run of the database

*Phase 1 done? Skip: the **Bootstrap** workflow (Actions → Bootstrap → Run workflow) migrated
both databases (members are created on first sign-in). Its `add-member` also works later from a
phone, e.g. to set a Chromium profile: the member's position in the `ALLOWED_EMAILS` secret.*

```sh
# production (needs the step-2 values in your shell; they're not in .env)
TURSO_DATABASE_URL=libsql://pandabase-… TURSO_AUTH_TOKEN=… pnpm db:migrate:prod
# preview
TURSO_DATABASE_URL=libsql://pandabase-preview-… TURSO_AUTH_TOKEN=… pnpm db:migrate:prod

# optional: members are created on first sign-in (then edited in Settings); add-member sets fields
# up front, incl. the Chromium profile Settings doesn't edit; exactly one cart account
TURSO_DATABASE_URL=… TURSO_AUTH_TOKEN=… pnpm db:add-member --email will@example.com --name Will \
  --discord <discord user id> --profile will --sweep daily --cart
TURSO_DATABASE_URL=… TURSO_AUTH_TOKEN=… pnpm db:add-member --email partner@example.com \
  --name Partner --discord <discord user id> --profile partner --sweep weekly
```

`db:add-member` creates or updates by email, so re-running is safe. Discord user ids: Discord →
Settings → Advanced → Developer Mode, then right-click a member → *Copy User ID*. Never run
`db:seed` against Turso — it's the synthetic dev household.

Check: both members can sign in; *Settings* shows them (set Discord ids and the cart account
there if you skipped `db:add-member`).

### 8. Mac Mini: base

Manual (macOS settings, once):

- **Users & Groups → Automatically log in as** the household user (the Chromium windows and
  Ollama need a GUI session after a power cut). Consider FileVault's trade-off: with FileVault on,
  auto-login is unavailable and a reboot waits for a password.
- **Energy → Prevent automatic sleeping**, and *Start up automatically after a power failure*.
- **Docker Desktop → Settings**: *Start when you sign in*; Resources → Memory 4GB is plenty (the
  worker uses ~150MB; Ollama runs outside Docker).
- Open **Ollama.app** once and enable *launch at login*.

Then:

```sh
make install-ollama-env            # OLLAMA_NUM_PARALLEL=1, OLLAMA_MAX_LOADED_MODELS=1 (LaunchAgent)
# quit Ollama from the menu bar and open it again so it reads them
ollama pull qwen3.5:9b             # the VLM: receipts, Trash Cam, and OpenClaw's photo descriptions
ollama pull qwen3.5:4b             # merge suggestions (skip if you choose the single-model option)
```

Check: `curl -s localhost:11434/api/tags | jq -r '.models[].name'` lists both models;
`launchctl getenv OLLAMA_MAX_LOADED_MODELS` → `1`.

#### Memory budget (32GB)

| Component | Resident | Notes |
|---|---|---|
| macOS, Docker Desktop VM, worker | ~5GB | the worker container itself is ~150MB |
| `qwen3.5:9b` (VLM, q4_K_M, 8K context) | ~7–8GB while loaded | worker and OpenClaw use `keep_alive` 2m: unloads two minutes after the last photo |
| `qwen3.5:4b` (text, `OLLAMA_TEXT_MODEL`) | ~3.5–4GB while loaded | merge suggestions only; with `OLLAMA_MAX_LOADED_MODELS=1` it replaces the VLM rather than sitting beside it |
| OpenClaw gateway (Node) | ~0.5–1GB | |
| OpenClaw's reply model, `$OPENCLAW_MODEL` | 0 if cloud; its size if local | if it runs on this Ollama, set `OLLAMA_MAX_LOADED_MODELS=2` in `ops/launchd/com.pandabase.ollama-env.plist` and budget its size here |
| Chromium × 2 (one per member) | ~0.5–1.5GB each | only one is driven at a time (profile lock) |
| Evening Claude Code sessions | ~1–2GB | |
| **Worst case** | **~18–20GB + `$OPENCLAW_MODEL`** | leaves headroom for the OS cache |

`OLLAMA_NUM_PARALLEL=1` keeps one request (and one KV cache) at a time; the worker is
single-job anyway. `OLLAMA_MAX_LOADED_MODELS=1` caps Ollama at one resident model.

**Single-model option:** set `OLLAMA_TEXT_MODEL=qwen3.5:9b` in `.env` (and skip pulling the 4B).
Then only one model ever loads: no swap when a merge job follows a receipt, ~3.4GB less disk,
one model to keep updated. The cost: merge suggestions run on the bigger model, a little slower
per job (they're rare, short text jobs, so it barely matters), and you lose the 4B's lower peak
memory if a merge job is the only thing running. Either works; the default keeps the 4B because
it frees memory sooner on a busy evening.

### 9. Mac Mini: agent tools and worker

```sh
make install-agent-tools   # uv sync agent/tools, link ~/.local/bin/pandabase-tools, create configs
```

This creates `agent/pandabase.config.json` and `agent/profiles.json` from the examples (only if
missing; both gitignored). Edit `agent/pandabase.config.json`:

| Field | Set to |
|---|---|
| `api_base_url`, `web_url` | your production URL |
| `discord.guild_id` | server id (right-click the server → *Copy Server ID*) |
| `discord.cycle_channel`, `intake_channel`, `ops_channel` | `#pandabase`'s channel id (all three) |
| `members[]` | `name`, `discord_id`, `profile` (= key in `profiles.json`), `cart_member` (exactly one `true`), `receipt_sweep` (`daily`/`weekly`/`off`) — match step 7 |
| `diagnostics_dir` | already the repo's `diagnostics/` (gitignored) |
| `cart.wholefoods_tier1` | leave `false` until step 13 says otherwise |

Make sure `~/.local/bin` is on your `PATH`. The OpenClaw gateway needs it too: if `openclaw
skills check` (step 11) reports `pandabase-tools` missing, link it into a directory the gateway
already has, e.g. `BIN_DIR=/opt/homebrew/bin make install-agent-tools`. Then start Docker
Desktop, log in to GHCR (the worker image is private; step 15 has the token) and start the worker:

```sh
docker login ghcr.io -u <github-user>   # password: the read:packages token from step 15
make up        # docker compose up -d — ghcr.io/willchan/pandabase-worker:main
make logs      # expect a heartbeat; "ollama ok" once models are pulled
```

Before the first deploy workflow has published an image, `make up-local` builds `./worker` here
instead.

Check: `scripts/ops/agent-run.sh config show` prints your members and `"token_set": true`.

### 10. Chromium profiles (one per member)

```sh
make install-chromium
```

One LaunchAgent per profile in `agent/profiles.json` starts that member's Chromium at login with
its own user-data dir and a DevTools port bound to `127.0.0.1` only (9222, 9223, …). CDP means
full control of a signed-in browser: never expose those ports. If macOS blocks Chromium the first
time, open it once from Finder (right-click → Open) and re-run.

Manual: in **each** Chromium window, sign in to that member's Amazon account (tick *Keep me
signed in*) and visit Whole Foods on Amazon once to set the store. The tools never sign in; if a
session expires, the smoke check and the agent will say so, and you sign in again by hand.

### 11. OpenClaw (Discord, skills, automations)

Manual, in the [Discord Developer Portal](https://discord.com/developers/applications) for the
existing bot: enable **Message Content Intent**. In the server, give the bot these permissions on
`#pandabase`: View Channel, Send Messages, Create Public Threads, Send Messages in Threads, Add
Reactions, Read Message History, Attach Files.

```sh
cp agent/openclaw.pandabase.example.json5 agent/openclaw.pandabase.json5
# edit: guild id, #pandabase id, both members' Discord ids, browser profile names (= profiles.json)
openclaw gateway stop
openclaw config patch --file agent/openclaw.pandabase.json5 --dry-run   # read the diff
openclaw config patch --file agent/openclaw.pandabase.json5
openclaw gateway start

make install-agent-skills   # skills.load.extraDirs += agent/skills; agent env → ~/.openclaw/.env
openclaw gateway restart    # if it said so
make install-agent-cron     # the automations from agent/cron.example.json (idempotent)
```

The patch sets the `#pandabase` channel policy, local photo descriptions on Ollama, and the
agent's browser profiles (attach-only to the step-10 Chromiums). It names `qwen3.5:9b`: if you
change `OLLAMA_VLM_MODEL`, change it there too. Arrays in a patch replace: if
you already had `tools.media.models` or Ollama models configured, merge those lists by hand.

Exec policy: OpenClaw's default host exec mode works as is. If you run `tools.exec.mode:
"allowlist"`, allowlist `pandabase-tools` (the only command the skills run).

Check:

```sh
openclaw skills check     # the five PandaBase skills are eligible (no missing bin/env)
openclaw automations list # pandabase-* jobs, household-TZ schedules
openclaw infer image describe --file <any photo> --model ollama/qwen3.5:9b   # local vision works
```

Then say "do we have milk?" mentioning the bot in any channel, and post a test message in
`#pandabase`.

### 12. Decide on photo privacy

Read [Photo privacy](#photo-privacy) below. If OpenClaw's reply model is local (our setup),
there is nothing to do beyond keeping cloud models out of its fallbacks. With a cloud reply model,
pick an option; A is recommended.

### 13. Smoke test

```sh
make smoke
```

Checks, each ✓/✗ with a reason: `.env` + config, agent-token API round trip, worker container
up, both models pulled, Ollama host settings, the worker's VLM on a synthetic receipt (in the
container, < 60s; a cold first load may need a re-run), job replies print `NO_REPLY` (skipped
while real replies are pending, so it never eats them), CDP attach to each member's Chromium on
a loopback port, and a clean worker stop/restart. Re-run any time; it changes nothing by
default.

Opt-in checks:

```sh
# Tier-1 cart: adds one Amazon and one Whole Foods item (quantity 1) to the cart member's cart
# with the real cart code, then deletes them again. Use ASINs that aren't already in the cart.
SMOKE_CART=1 SMOKE_AMAZON_ASIN=B0XXXXXXXX SMOKE_WF_ASIN=B0YYYYYYYY make smoke SMOKE_ONLY=cart

# End to end: a blank synthetic photo → R2 → Trash Cam job → worker → Ollama → completed.
# Leaves one Trash Cam review in Cleanup (dismiss it, or it expires).
SMOKE_E2E=1 make smoke SMOKE_ONLY=e2e
```

If the cart check reports the Whole Foods item as `added`, set `cart.wholefoods_tier1: true` in
`agent/pandabase.config.json` (otherwise the agent adds Whole Foods lines itself, which is
slower but fine). If it can't delete a test item, it says which one to remove by hand.

### 14. Backfill 12 months of receipts

```sh
make backfill               # every member with receipt_sweep ≠ off; or MEMBER=will
```

Walks each member's Amazon order history back 12 months (3s per page), ingesting delivered,
picked-up and in-store orders. It's resumable and deduped by order id: if it stops (Chromium
signed out, network), fix the cause and run it again. Orders whose items it can't read are
listed; ask the agent in `#pandabase`: "backfill receipts for will" to extract them. At the end it
asks the State Engine for merge suggestions (backfilled products start as unverified items); they
show up in *Cleanup → Merges* and nobody has to answer them. Then check
the *Pantry* page: items should show purchase history and estimates.

You're done. From here the automations run the week: Friday 18:00 nudge, Saturday 10:00 cart
build, nightly receipt sweeps, Sunday 23:00 diagnostics (see [PRD §4](docs/PRD.md)).

---

### 15. Continuous deployment

Merging to `main` deploys everything (DESIGN §8 *Continuous deployment*): GitHub Actions
`deploy.yml` runs after CI passes — **migrate** Turso production → **deploy-web** (`vercel deploy
--prod`) → **publish-worker** (`ghcr.io/willchan/pandabase-worker:<sha>` and `:main`, arm64) —
and the Mac Mini pulls the new worker, tools and skills itself every 15 min. Nothing connects
into the home network. Until the `production` environment has its secrets, every run fails at its
first step with one error naming the missing ones (nothing is migrated or deployed).

*Phase 1 done? Items 1–3 are done; start at item 4.*

1. **GitHub environment `production`** (repo → *Settings → Environments → New environment*).
   Restrict *Deployment branches* to `main`. Add:

   | Kind | Name | Value |
   |---|---|---|
   | secret | `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | production DB (step 2) |
   | secret | `VERCEL_TOKEN` | vercel.com → *Account Settings → Tokens* (scope: your team) |
   | secret | `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` | `web/.vercel/project.json` after `(cd web && vercel link)` (`orgId`, `projectId`) |
   | secret | `AGENT_API_TOKEN` | from `.env` — only for `deploy` telemetry (optional) |
   | secret | `ALLOWED_EMAILS` | same as Vercel — only for the Bootstrap workflow's `add-member` |
   | variable | `PANDABASE_API_URL` | production URL (telemetry target + the environment's link) |

2. **GitHub environment `preview`** with `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` = the preview
   DB. `preview-migrate.yml` migrates it for PRs that add migrations (it skips with a notice until
   these exist).
3. **Vercel:** nothing more — `web/vercel.json` already turns off production auto-deploys from
   `main`. Keep the *Production Branch* = `main` (previews for every other branch).
4. **GHCR on the Mac Mini:** GitHub → *Settings → Developer settings → Personal access tokens →
   Tokens (classic)* → a token with only **`read:packages`**, no expiry or a reminder to rotate
   it. Then `docker login ghcr.io -u <github-user>` and paste it; Docker Desktop keeps it in the
   macOS keychain. The updater uses it twice: to check that `:<sha>` exists (that is its "CI
   passed and the web deployed" signal — it never deploys a commit without it) and to pull.
   After the first deploy run, open the package (github.com → your profile → *Packages*) and
   check it's linked to this repo and private.
5. **Discord alert (optional but recommended):** `#pandabase` → *Edit Channel → Integrations →
   Webhooks → New Webhook* → copy URL into `.env` as `DEPLOY_DISCORD_WEBHOOK_URL`. A failed
   update posts there once.
6. **Install the timer:**

   ```sh
   make update DRY_RUN=1      # what it would do now (git fetch runs; nothing else changes)
   make install-update-timer  # launchd: make update every 15 min; log ~/Library/Logs/pandabase-update.log
   ```

What `make update` does: skip if paused or inside a quiet window (**Fri 17:30–19:00, Sat
09:30–12:00** household time, around the nudge and the cart build) or if another run holds the
lock → `git fetch` → pick the newest commit on `origin/main` whose image exists (older green
commits still deploy while the newest is red or building) → `git merge --ff-only` → `uv sync`
(tools) → `PANDABASE_WORKER_TAG=<sha>` in `.env` → `docker compose pull && up -d` → health check
(worker running, a heartbeat from the new sha within 2 min via `GET /api/health/worker`, an
agent-token API round trip). On failure it rolls back to the previous sha and image, remembers
the bad sha (skipped until a newer commit lands), posts once to Discord, and sends `deploy`
telemetry (weekly report, *Deploys*). It needs a clean checkout on `main`.

- **Pause / resume:** `make update-pause` / `make update-resume` (`make update-status` shows
  state, the last update and skipped shas). To stop the timer entirely:
  `launchctl bootout gui/$(id -u)/com.pandabase.update`.
- **Manual rollback:** `make rollback` (to the sha before the last update) or
  `make rollback TO=<sha>`. It resets the checkout, reuses that image, health-checks, and pauses
  auto-update so the next tick doesn't move forward again; `make update-resume` when fixed.
  The web app: Vercel → *Deployments* → the previous production deployment → *Instant Rollback*
  (safe because migrations are backward-compatible; a rolled-back web app runs on the newer
  schema).
- **Migrations that drop or rename** must wait for a later PR (CLAUDE.md). CI's ops job fails a
  PR whose *new* migration has `DROP TABLE`/`DROP COLUMN`/`RENAME` unless the file has a
  `-- contract-migration: <reason>` line or the PR has the `contract-migration` label.

## Photo privacy

PandaBase is local-first for vision ([PRD §3.6](docs/PRD.md), [DESIGN §10 #10, #34](docs/DESIGN.md#10-key-decisions--rationale)):
the worker only talks to the local Ollama, and the step-11 config makes OpenClaw describe each
inbound Discord photo with the same local model (`tools.media.models` → `ollama/qwen3.5:9b`), so
the skills work from that text and the agent's reply model never needs the pixels.

**Residual risk.** OpenClaw's media understanding is best-effort: if the local description fails
(Ollama down or busy past the 180s timeout, a photo over the size limit, the second of several
attachments), OpenClaw falls back to delivering the image **natively to the reply model**. If
that model is a cloud model (your `$OPENCLAW_MODEL`), the photo — a receipt, or the inside of
your trash can — goes to that provider. OpenClaw documents this; `tools.media.image.enabled:
false` does not stop native delivery.

**With a local reply model (our setup), there is no residual risk.** If OpenClaw's agent runs on
a model served by this Mac's Ollama, a photo the media model couldn't describe goes to that local
model instead: it never leaves the Mac. That's option C below, with two conditions:

- **No cloud fallback.** OpenClaw's model setting can list backups (`model: { primary,
  fallbacks }`). Don't put a cloud model there, and the simplest guarantee is to configure no
  cloud provider keys at all.
- **Memory.** The reply model and `qwen3.5:9b` share one Ollama. With
  `OLLAMA_MAX_LOADED_MODELS=1` each photo swaps them (unload yours, describe the photo, reload
  yours): correct but slower. If both fit (see [Memory budget](#memory-budget-32gb)), set it
  to `2` in `ops/launchd/com.pandabase.ollama-env.plist` and re-run `make install-ollama-env`.

Small local models are weaker than cloud ones at multi-step tool use; the Saturday cart build
(tier-2 browsing for lines the add-to-cart link couldn't handle) is the most demanding job, so
use the most capable model your memory allows and watch the first few builds.

The options below matter only if the reply model is a cloud model.

Options (the owner chooses; record the choice in PLAN M8 Notes):

- **A. Text-only reply model for PandaBase (recommended).** A dedicated `pandabase` agent bound to
  `#pandabase` uses your usual cloud model registered under its own provider id with `input:
  ["text"]`. OpenClaw only attaches images to turns whose model is image-capable, so a failed
  local description leaves the agent with no image rather than a cloud upload; the skill then
  classifies the photo by its caption (or files it as a receipt) and the worker still reads it
  locally. Your other agents keep vision.
  ```sh
  cp agent/openclaw.privacy.example.json5 agent/openclaw.privacy.json5   # fill in the <…>
  openclaw gateway stop
  openclaw config patch --file agent/openclaw.privacy.json5 --dry-run
  openclaw config patch --file agent/openclaw.privacy.json5
  openclaw gateway start
  OPENCLAW_AGENT=pandabase make install-agent-cron   # run the automations as that agent
  ```
  Verify: post a receipt photo in `#pandabase` and one in a cycle thread. Each should get the
  usual "queued" reply (the skill still receives the attachment's file path; OpenClaw keeps
  attachments for text-only models as file refs — not verified on a live gateway yet), and
  `openclaw sessions list` should show both sessions on the `pandabase` agent. If your gateway had one agent, also bind it for everything else
  (see the comment in the file), or other channels stop routing.
- **B. Mark your model text-only everywhere.** One metadata row,
  `models.providers.<provider>.models: [{id: "<model>", input: ["text"]}]`. Simplest, but every
  agent on the gateway loses vision.
- **C. Keep the step-11 config only.** Right for a local reply model (no risk; the conditions
  above). With a cloud reply model it means accepting the risk: failures are rare when Ollama is
  healthy (`make smoke` checks it), and the photos are household receipts and bins.

Scoping media understanding to `#pandabase` (`tools.media.image.scope`) doesn't help here: it
limits where the *local* description runs, so photos elsewhere would go natively to the reply
model more often, not less.

## Where each secret lives

| Secret | Generated by | Lives in | Used by |
|---|---|---|---|
| `AGENT_API_TOKEN` | `make secrets` | `.env`, `~/.openclaw/.env`, Vercel | agent tools → API (scope `agent`) |
| `WORKER_API_TOKEN` | `make secrets` | `.env`, Vercel | worker → API (scope `worker`) |
| `AUTH_SECRET` | `make secrets` | `.env.vercel`, Vercel | Auth.js session JWTs |
| `CRON_SECRET` | `make secrets` | `.env.vercel`, Vercel | Vercel Cron → `/api/cron/maintenance` |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | `turso` (step 2) | Vercel (+ your shell for migrations) | web app only |
| `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | Google console (step 4) | Vercel | sign-in |
| `R2_*` | Cloudflare (step 3) | Vercel | presigned upload/download URLs |
| Amazon sessions | you, by hand | each Chromium user-data dir | agent tools over CDP (never stored by PandaBase) |
| Discord bot token, cloud model keys | OpenClaw setup | OpenClaw's own config | OpenClaw |
| `TURSO_*` (prod), `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `AGENT_API_TOKEN` | Turso, Vercel, `make secrets` (step 15) | GitHub environment `production` secrets | `deploy.yml` (migrate, deploy, telemetry); `bootstrap.yml` (`TURSO_*`) |
| `ALLOWED_EMAILS` | you (step 6) | GitHub environment `production` (+ `preview`, optional) secret | `bootstrap.yml` `add-member` (emails never go in public run inputs) |
| `TURSO_*` (preview) | `turso` (step 2) | GitHub environment `preview` secrets | `preview-migrate.yml`, `bootstrap.yml` |
| `GITHUB_TOKEN` | GitHub, per run | nowhere (ephemeral) | `deploy.yml` pushes to GHCR (`packages: write` in that job only) |
| GHCR read token (`read:packages`) | you (step 15) | macOS keychain via `docker login ghcr.io` | Mac Mini: image exists? + pull |
| `DEPLOY_DISCORD_WEBHOOK_URL` | Discord (step 15) | `.env` | Mac Mini updater's failure post |

`.env*`, `agent/pandabase.config.json`, `agent/profiles.json`, `agent/openclaw.*.json5` and
`diagnostics/` are gitignored. To rotate a token: delete its line from `.env` (or
`.env.vercel`), `make secrets`, `vercel env rm <NAME> production` + `make vercel-env`, redeploy,
`make install-agent-skills` (agent token), `make up` (worker token).

## Manual steps that can't be scripted

- Creating the Turso, Cloudflare, Google Cloud and Vercel accounts/projects, and the Google OAuth
  consent screen + redirect URIs (steps 2–4, 6).
- macOS settings: auto-login, no sleep, restart after power failure, Docker Desktop and Ollama at
  login (step 8); opening Chromium once past Gatekeeper (step 10).
- Signing in to Amazon in each member's Chromium, and again whenever a session expires (step 10).
- Discord: Message Content Intent and the bot's channel permissions; copying ids (steps 7, 11).
- Filling in `agent/pandabase.config.json` and the OpenClaw patch file (steps 9, 11).
- The photo-privacy choice (step 12) and turning on `cart.wholefoods_tier1` after the cart check.
- GitHub environments and their secrets, the Vercel token, the GHCR read token + `docker login`,
  the Discord webhook, and checking the GHCR package is private (step 15).
- Extracting orders the backfill couldn't read (ask the agent; step 14).

## Day 2

- **Updates:** automatic (step 15). `make update` runs one now (same checks); `make
  update-status`, `make update-pause`/`update-resume`, `make rollback [TO=<sha>]`. Skills load
  straight from the repo, so new skill text applies to new OpenClaw sessions.
- **Logs:** `make logs` (worker), `openclaw logs`, `~/Library/Logs/PandaBase/` (Chromium).
- **Re-check everything:** `make smoke`.
- **Diagnostics:** every Sunday the agent writes `diagnostics/YYYY-Www.md` plus JSONL extracts
  (gitignored) and posts a 3-line summary. To review them with Claude Code on the Mac Mini, ask it
  to "review diagnostics" (playbook in [CLAUDE.md](CLAUDE.md); report sections in
  [DESIGN §7](docs/DESIGN.md#7-diagnostics)). Insights in the web UI shows the same report.
- **Pause a member's sweeps:** set `receipt_sweep: "off"` in the config and run
  `make install-agent-cron` (it tells you which automation to remove).

## Development

See [CLAUDE.md](CLAUDE.md) for every command. Quick start: `pnpm install`,
`pnpm db:reset && pnpm db:seed`, `pnpm dev` (local DB, `DEV_AUTH_BYPASS=1` in `web/.env.local`),
`make check` before pushing. Test tiers (system test, agent eval, live): [docs/TESTING.md](docs/TESTING.md).
