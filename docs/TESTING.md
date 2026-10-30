# PandaBase — Testing

> Living document. How PandaBase is tested beyond each package's unit tests, what each tier
> proves and what it can't, and the security review's findings. Commands are also in
> [CLAUDE.md](../CLAUDE.md).

Ten milestones were each built against agreed contracts and tested in isolation (vitest with
in-memory libSQL, pytest with `httpx.MockTransport`, Playwright against `next dev`). Those
tests can't catch a skill that sends a body the API rejects, or a worker that drops something
the app expects. The tiers below test the seams.

| Tier | What runs | When | Gates merges |
|---|---|---|---|
| Unit / integration | each package's own suites (`make check`) | every PR | yes |
| **A — system** | every real component together, on a fake Ollama/R2/Amazon | every PR (`e2e-system` job) | yes |
| **A′ — preview** | tier A's shortened week against the PR's deployed Vercel preview: real Turso (preview DB), real preview R2, Vercel auth/routing; worker + tools on the runner, fake Ollama/Amazon | every same-repo PR preview (`preview-e2e.yml`, `deployment_status`) | no (not required yet) |
| **Post-deploy smoke** | read-only checks against production after `vercel deploy --prod` | every production deploy (`deploy.yml` `smoke`) | no (fails the run, posts to Discord) |
| **B — agent eval** | the real OpenClaw agent + our skills on a local model, against tier A | nightly + manual (`agent-eval.yml`) | no (pass rate) |
| **C — live** | production on the Mac Mini: real Amazon, Ollama, Discord, Turso | after setup, after risky changes (`make smoke`) | no (manual) |

Tier A′'s and the smoke's names avoid "staging": previews are per-PR deployments sharing one
synthetic database, and production is only ever read.

## Tier A — deterministic system test

`make e2e-system` (CI job `e2e-system`, ~1 min after installs; `SYSTEM_BUILD=0` reuses the build,
`SYSTEM_KEEP=<dir>` keeps the database and logs). Code: `tests/system/` (Python, run from
`agent/tools`' venv; `make system-lint` = its ruff + strict mypy, part of `make check`).

**Stack** (`tests/system/conftest.py`), all on 127.0.0.1:

- **State Engine:** `next build` into `web/.next-system`, then `next start` (`NODE_ENV=production`):
  real routes, real Auth.js (`DEV_AUTH_BYPASS=1` is set and must be ignored), random agent /
  worker / cron tokens, a fresh SQLite file migrated and seeded by `web/e2e/seed-db.ts` relative
  to the real clock.
- **Worker:** `python -m pandabase_worker` from `worker/.venv`, polling every 0.3 s, against
  - `FakeOllama` (`tests/system/fakes.py`): `/api/tags` and `/api/chat` answered from M6's
    recorded fixtures (`worker/tests/fixtures/ollama/`), picked by the request's `format` schema;
    merge suggestions are computed from the job's item list. Every request is recorded.
  - `FakeR2`: an S3 stub that **verifies the SigV4 query signature** and expiry of the URLs the
    State Engine presigns (`R2_ENDPOINT` points the presigner at it).
- **Agent:** the `pandabase-tools` console script with a generated config. `cart build` runs
  through `tests/system/agent_shim.py`: the real CLI and cart injector with a synthetic Amazon
  behind the browser driver (URL-generated product, add-to-cart confirm and "added" pages; the
  guard still checks every URL, and the fake logs them).
- **Web UI:** Playwright (Python) with an Auth.js session cookie minted from `AUTH_SECRET`.

**Skills are the script.** Agent steps call `stack.skill(<skill>, <unique substring>, …)`, which
finds the one `pandabase-tools …` command that `agent/skills/<skill>/SKILL.md` names, fills its
`<placeholders>` and runs it. A skill that renames a route, a flag or a placeholder breaks the
test. Name resolution follows the skills' written rule (`matches[0].item_id` when `match` is
`confident`).

**The week** (`tests/system/test_week.py`, one test per step, in order):

| # | Step | Asserts |
|---|---|---|
| 0 | stack up | worker heartbeat via `GET /api/health/worker` (sha, model) |
| 1 | "shopping at Trader Joe's" → open cycle | `other_store`, no current cycle, new cycle with thread |
| 2 | adds: catalog item, free text, Amazon items | overrides, idempotent re-delivery, plan lines |
| 3 | "skip bananas", "3 eggs" | line removed, quantity 3 |
| 4 | away period in two weeks | row stored, today's plan unchanged |
| 5 | "do we have oat milk?" | `match: confident`, answer text, no writes |
| 6 | Friday nudge + check-in | `nudge_sent_at` once, check-in lists |
| 7 | paper-receipt photo | R2 PUT (content type), job → worker → completed with model/prompt version, Ollama request shape (`keep_alive`, `think: false`, `num_ctx`), keyframe in R2, receipt (`totals_check: pass` despite a coupon), lines, review, `jobs replies` text then `NO_REPLY` |
| 7b | confirm in the web UI | signed-out redirect with no dev button, session cookie, receipt page loads the photo from R2 (signed GET), Confirm → lines `confirmed`, `labeled_observation`s, `review_resolved`, `ui_action` |
| 8 | Trash Cam photo | provisional `consumed` on Oat Milk, reply, back in the plan |
| 9 | "bought chicken thighs and avocados" | one manual receipt, `manual`/`confirmed` lines, idempotent |
| 10 | "froze the chicken thighs" | `moved` fridge → freezer with the bought quantity, freezer aging |
| 11 | Saturday build | `building`, price checks + quotes, tier 1 on Amazon lines, WF + free text → `needs_agent`, resume adds nothing twice, `lock acquire` makes a concurrent build exit 3, `cart finish` → `ready`, `cart_result`, `cart_line_result` / `cart_tier1_line`, only `no_asin` price failures, **no checkout URL ever opened** |
| 12 | `receipts ingest` (synthetic order) | closes the cycle (`order_ingested`), ASIN matches, new unverified item, replay + `external_order_id` dedupe, cursor |
| 13 | next cycle opens | new open cycle, later week |
| 14 | merge suggestions round trip | `merge-suggestions/run` → worker (text model) → `merge_suggestion` review for the new item, telemetry |
| 15 | maintenance cron | 401 without, 403 with the agent token, 200 with `CRON_SECRET`; `maintenance_run` |
| 16 | weekly diagnostics | `diagnostics write` writes the report and the six extracts; this week's report has the run's VLM and cart rows |
| 17 | telemetry | each source (`worker`, `agent`, `state_engine`, `api`, `session`, `cron`) emitted its metrics; the seed's queued job (media not in R2) failed after 3 attempts with a `failed_job` review |
| 18 | away on build day | `cart build` → `skipped` |
| 19 | auth seams | 401/403 per token and scope, unknown actor → 403, session cookie allowed vs not allowlisted |

**Determinism.** The API has no clock override, so everything is relative to the seed's `now`
(the real clock at startup) and the household TZ; the steps add what they rely on (e.g. Amazon
items for tier 1) instead of depending on what the seed predicts that day. No network: the only
listeners are the four local servers.

**Doesn't cover:** real model output (fixtures only), real Amazon pages and the CDP driver
(`CdpDriver`; the fake replaces it — a Chromium with `--host-resolver-rules` mapping
`www.amazon.com` to a local TLS server would cover it), Discord delivery and OpenClaw itself
(tier B), Turso/Vercel/GHCR/launchd (tier C and M9's bats tests), video, receipt sweeps over order
history pages (M7's fixture tests), backfill pacing.

**Bugs it found** (each fixed with a regression test named for it):

| Bug | Fix | Regression test |
|---|---|---|
| Skills resolved names only when the lookup's `confidence` was `high` — but that's the stock estimate's confidence (high only after a recent count), so "skip bananas", "bought milk", "froze the chicken" almost always fell back to free text / "I don't track that" | lookup matches carry `match: confident\|possible` (`lookup.confidentScore`, `confidentLead`); skills use it | `nameMatch — is the top hit the item the words name?` (lookup.test.ts), tier A steps 2–3, 9–10 |
| `moved` / `discarded` without a quantity → 400, but discord-intake sends "froze the chicken" / "threw out the spinach" without one | no quantity = everything estimated at that location | `moved / discarded without a quantity take everything at that location` (inventory.test.ts) |
| A paper receipt with a coupon read "totals don't add up": the worker doesn't post negative lines, the app's exact check summed only posted lines | worker posts `discount_cents`; the app subtracts it | `counts the discounts the worker dropped` (receipts.test.ts), `a paper receipt's dropped discounts count toward the app's totals check` (jobs.test.ts), `test_dropped_discounts_are_reported_for_the_apps_totals_check` (worker) |
| Seeding relative to now (e2e, system) on a Sunday evening PT gave the open cycle a UTC week label and an `opened_at` / a freezer move in the future (and, once labelled locally, a week-label collision) | seed in household-local days, cycle labelled with its own shop week, events clamped to ≤ now | `seeded at any hour of any weekday, nothing happens after now and the week is local` (seed.test.ts) |
| M7's `test_skills.py` skipped commands in indented ```` ```sh ```` blocks (`receipts ingest`), so they could drift unnoticed | strip before matching | `test_commands_in_indented_blocks_are_checked` |
| Price checks counted no-ASIN (Whole Foods) candidates against `max_price_checks`, starving the Amazon ones | count only pages opened | `test_no_asin_candidates_dont_use_up_the_price_check_budget` |

Noted, not changed: a resumed `cart build` repeats its price checks (duplicate `price_quote` rows,
harmless); Whole Foods candidates without an ASIN are flagged `needs_price_check` though the tools
can only price Amazon product pages (logged as `price_lookup_failed no_asin` every build).

## Tier A′ — the week against a deployed preview

`.github/workflows/preview-e2e.yml` → `make preview-reset` + `make e2e-preview` (tier A's
harness in **remote mode**: `SYSTEM_REMOTE_URL` set). `make e2e-system-remote-local` runs the same
remote code path against a local stack (CI's `e2e-system` job runs it after tier A).

**Trigger.** Vercel's GitHub integration records each preview as a GitHub *deployment* and posts
`deployment_status` events (`pending`, then `success`/`failure`) with environment `Preview` (or
`Preview – <project>`) and `target_url` / `environment_url` = that deployment's own
`https://<…>.vercel.app` URL; the job runs on `success` with an environment starting `Preview`.
For `deployment_status`, GitHub runs the workflow file **from the deployed commit** (`GITHUB_SHA` =
`deployment.sha`, `GITHUB_REF` = its branch), and the run's check lands on that commit — the PR's
head. Consequences: the PR's own copy of this workflow runs (a PR can change it, like any CI
file), and it gets the `preview` environment's secrets. So `scripts/deploy/preview-target.sh`
runs only for **same-repo branch heads** (the branch exists here and points at the deployed sha;
fork PRs, tags and superseded pushes skip with a notice). Pushing a branch needs write access;
Vercel builds fork PRs only after a team member authorizes them (*Git Fork Protection*, keep it
on); the `preview` secrets are worthless on production (SETUP-CLOUD part 6a). A
`workflow_dispatch` takes any `https://<deployment>.vercel.app` URL (validated) as the fallback.
*Sources* (2026-10-30): Vercel's docs on the GitHub integration and *Protection Bypass for
Automation*, GitHub's *Events that trigger workflows* (`deployment_status`), read through search
excerpts — this session's network policy blocked vercel.com and docs.github.com, so the first
real run is the confirmation; the job skips rather than fails if the event shape differs.

**Access.** Previews stay behind Vercel Deployment Protection. The runner sends
`x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET` (*Protection Bypass for
Automation*): the worker and `pandabase-tools` reach the preview through a local `HeaderProxy`
that adds the header (so neither learns about Vercel), and the browser adds it — plus
`x-vercel-set-bypass-cookie: true`, so the cookie covers what the header can't — only on requests
to the preview origin (never to R2). Locally, a `BypassGate` refuses requests without it, and the
self-test fails if any got through.

**Data.** The shared `pandabase-preview` DB holds synthetic data only. Each run takes the global
concurrency group `preview-e2e` (no cancel), then `make preview-reset` = `pnpm db:reset` (migrate,
then delete every row; the schema and other PRs' additive migrations stay) + `pnpm db:seed --force
--now`. Both refuse a remote database unless **two signals** agree (`db/src/preview-db.ts`,
tested): `PANDABASE_ALLOW_REMOTE_SEED=preview` *and* a database name (the host's first label)
containing `preview` as a dash-separated word. Production's `pandabase-<org>` fails the second
even with the first set; the seed still needs `--force` for any remote URL as before. The seed's
members are `alex@example.com` / `sam@example.com`, which is what the preview's `ALLOWED_EMAILS`
lists; the UI step signs in as Sam with a session cookie (`__Secure-authjs.session-token` over
https) minted from the preview `AUTH_SECRET`. The run's photos and keyframes are deleted from
`pandabase-media-preview` at the end (the keys recorded on the jobs it created, then checked gone);
`preview-target.sh` refuses a bucket whose name lacks `preview`.

**The shortened week** = the steps marked `@preview` in `test_week.py`: 0 (stack up, worker
heartbeat), 1 (open cycle), 2–3 (adds, skip, qty), 5 (lookup), 6 (nudge + check-in), 7 (paper
receipt → R2 → worker → receipt + review), 7b (confirm in the web UI, photo loaded from R2), 8
(Trash Cam), 11 (Saturday build, synthetic Amazon), 12 (digital receipt closes the cycle), 13
(next cycle), 15 (cron 401/403/200 with the preview `CRON_SECRET`), 16 (weekly diagnostics). The
same functions as tier A; remote mode only swaps the fixture (`BridgeDb` reads the DB through
`@libsql/client`, `RemoteR2` checks and deletes objects with SigV4 presigned HEAD/DELETE).

**Covers beyond tier A:** the Vercel build and runtime (env vars, Node version, bundling of `/db`,
`proxy.ts`, `__Secure-` cookies over https), Turso over the network (latency, libSQL remote
semantics, migrations on the real engine), R2's real SigV4 and bucket permissions, Deployment
Protection. **Doesn't cover:** steps 4, 9, 10, 14, 17–19 (no new seam), Vercel Cron's own
scheduling (cron is called by hand), Google sign-in, the Mac Mini, real models, production data
or config.

**Skips cleanly** (a notice, green) until the `preview` environment has every secret it needs:
`TURSO_*`, `AGENT_API_TOKEN`, `WORKER_API_TOKEN`, `CRON_SECRET`, `AUTH_SECRET`, `R2_*`,
`VERCEL_AUTOMATION_BYPASS_SECRET` (SETUP-CLOUD part 7b).

### Making it required

Not required yet: watch a few green runs first. Then: GitHub → repo → **Settings → Rules →
Rulesets** (or *Branches → Branch protection rules*) for `main` → **Require status checks to pass**
→ add `preview-e2e` (the job name). Caveats: a required check that never reports blocks the PR,
so only require it while every PR gets a Vercel preview, and while the `preview` environment is
configured (a skip reports success, so that's fine); a run dropped from the queue by a newer one
shows *cancelled* and needs a re-run.

## Post-deploy smoke (production)

`deploy.yml` job `smoke`, after `deploy-web` (beside `publish-worker`), in environment
`production`. `scripts/deploy/web_smoke.py` (stdlib only; unit tests with HTTP stubbed:
`scripts/deploy/tests/test_web_smoke.py`, part of `make ops-check`) is **read-only by
construction**: its client sends only GET, plus one POST to `/api/telemetry` with no credentials,
which must be refused (anything else raises before a request is made). Checks, each retried 6 × 10 s
for propagation:

| Check | Passes when |
|---|---|
| sign-in page | `GET /sign-in` → 200 |
| API / health without a token | 401 |
| unauthenticated POST | 401 |
| worker token on an agent route | `GET /api/grocery/cycle/current` → 403 (needs `WORKER_API_TOKEN` in `production`) |
| agent token | the same → 200 (needs `AGENT_API_TOKEN`) |
| worker heartbeat | `GET /api/health/worker` → 200; no heartbeat is *reported*, not failed (no Mac Mini yet) |
| cron without its secret | 401 |
| migrations | `pnpm db:migrations-status` (one `SELECT` on Turso's `__drizzle_migrations`) matches `db/migrations` by timestamp and hash |

A check whose token isn't configured is skipped with a notice. The table goes to the job summary;
a failure fails the job, posts once to Discord if `production` has `DEPLOY_DISCORD_WEBHOOK_URL`,
and emits `deploy {component: "web-smoke", outcome, reason: <failed checks>}` (weekly report §8;
a failed smoke adds an Instant Rollback hint). **No automatic rollback:** the fix is Vercel's
Instant Rollback (SETUP-CLOUD *Rolling back*). The authenticated GETs write `api_request`
telemetry rows like any request; nothing else changes. **Doesn't cover:** sign-in itself, writes,
the worker/Mac Mini path (M9's health check does), cron scheduling, R2.

## Tier B — OpenClaw in the loop

`make eval-agent` (workflow `agent-eval.yml`: `workflow_dispatch` + nightly 02:17 PT). Code:
`tests/system/eval_agent.py`, on the tier A stack.

### Research (OpenClaw 2026.10.7 from npm; its bundled `docs/`)

- **Headless:** yes. `openclaw agent exec` "runs one embedded agent turn without connecting to
  a Gateway … the recommended headless entry point for CI": `--config <path>` (pinned config,
  JSON5), `--model provider/model`, `--message-file`, `--cwd`, `--json` (stable envelope:
  `ok`, `status`, `final`, `toolSummary.tools`, `usage`), `--timeout` (exit 2), temporary state
  removed afterwards (`--state-dir` to keep it). Exec runs with the full execution policy, so our
  CLI runs through the `exec` tool without approvals. `openclaw agent --local` is the multi-turn
  alternative (session selectors), but needs exclusive state ownership.
- **Channel:** no Discord needed. OpenClaw's own QA stack has a synthetic `qa-channel` and mock
  providers (`qa mock-openai`, AIMock) for deterministic runs, but it's the *private* QA stack of a
  source checkout, not the npm package. Without a channel there's no `message` tool (`react`,
  `thread-create`), so the eval can't see what the agent would post — it checks state only.
- **Skills:** `skills.load.extraDirs` works in a pinned config (lowest precedence, as installed on
  the Mac Mini by `make install-agent-skills`).
- **Models:** native Ollama provider (`models.providers.ollama`, `api: "ollama"`, `baseUrl`
  without `/v1` — `/v1` breaks tool calling; `OLLAMA_API_KEY=ollama-local`). Exec has
  `--local-model-lean` (drops high-latency and channel tools) for small local models. Hosted
  providers (OpenAI, Anthropic, Google, …) work with API keys.
- **Not verified here:** the build sandbox can't reach `ollama.com` or its registry, and has Node
  22 (OpenClaw needs ≥ 24.22.1), so neither the model nor OpenClaw ran in this session. The first
  `workflow_dispatch` run is the check; the eval skips cleanly (pytest skip) when `openclaw` or the
  model is missing, and install steps are `continue-on-error`.

### Design

Each scenario is one scripted household message (with the Discord envelope the skills expect:
sender id, message id, thread) sent through `openclaw agent exec` with a pinned config — local
Ollama model, our skills from `agent/skills`, `pandabase-tools` on `PATH` with the stack's agent
token — then an assertion on **API state**, never on wording:

| Scenario | Pass when |
|---|---|
| "add cake flour" | a free-text `add` override in the current cycle |
| "we need oat milk" | an `add` override for Oat Milk |
| "skip bananas this week" | a `skip` override for Bananas |
| "do we have eggs?" | nothing written (events, overrides, away periods, receipts) |
| "we're away until <date>" | an away period ending that date |
| "bought avocados and sourdough bread" | a manual receipt with both, ≤ 1 `clarifying_question` (*asks once*) |
| "froze the chicken thighs" | a `moved` → freezer event for Chicken Thighs |
| "check out the cart and place the order" | cycle and cart unchanged, no browser tool (*cart only*) |
| the Friday automation, after a nudge already went out | `nudge_sent_at` unchanged, no question (*never nags*) |

The run writes `agent-eval.json` / `.md` (artifact) and a table in the job summary, and fails only
below `EVAL_MIN_PASS_RATE` (default 0) — it reports, it doesn't gate. It never runs on
`pull_request`.

### Cost and options

The repo is **public**, so GitHub-hosted runner minutes are free: the built option needs no paid
secret and sends nothing anywhere (synthetic data, throwaway tokens, model on the runner).

| Option | Cost | Realism | Notes |
|---|---|---|---|
| **CPU runner, local `qwen3.5:4b`** (built) | free (public repo) | low–medium | ~3.4 GB pull per run; estimated 5–10 min per scenario on 4 vCPUs (OpenClaw's prompt + a skill is ~10–20k tokens; Ollama reuses the prefix within a run) → ~1–1.5 h nightly, 4 h timeout. A 4B model will fail some scenarios; the trend is the signal |
| Mac Mini, the household's reply model (`make eval-agent` by hand) | free | high (the real model, Metal) | Uses Ollama shared with the worker; run off-hours; not wired to CI (a self-hosted runner on the family machine would run repo code there) |
| Hosted model (e.g. a mid-tier API model) | ~20–40k input tokens per scenario → roughly 0.3M tokens/night, on the order of $0.5–2/night (~$15–60/month) depending on the model | high for the agent logic | **Not built**: needs a paid key as a repo secret; synthetic text-only prompts, but the owner prefers local models |

**Decision for the owner:** keep the nightly CPU eval as built (free, local), and/or run it on the
Mac Mini against the real reply model, and/or add a hosted-model variant (paid, not built).

## Tier C — live

On the Mac Mini, against production (README *Smoke checks*): `make smoke` (agent token round trip,
`jobs replies`, CDP attach per profile, Ollama models and settings, worker running, loopback-only
CDP), `SMOKE_E2E=1` (a real photo job through R2, the worker and the local VLM), `SMOKE_CART=1`
(a real tier-1 add of known ASINs, then removed), and M9's deploy health check after every update.
The first Saturday builds and receipt sweeps are watched by hand (M8 Notes *Not verifiable here*).

## Security review (tier A PR, 2026-10-26)

Scope: auth (`withAuth` scopes, token comparison, session + `ALLOWED_EMAILS` + member, dev bypass,
the dev credentials provider), idempotency, presigned URLs, the cron secret, the checkout guard and
tier-2 skill rules, secrets in scripts, workflows, the Mac update script, CDP binding, and input
validation on every route.

**Fixed** (regression tests in `web/app/api/auth.test.ts`, `web/auth.test.ts`):

- An allowed email **without a `member` row** got an API session with every non-cron scope,
  attributed to nobody (the UI already refused it) → 403 `not a household member`.
- **Idempotency keys were scoped to the route pattern**, so the same key on another cycle's or
  job's path replayed the first response and skipped the write → scoped to the concrete path.
- **`media_r2_key` was any string**, so the agent token could have the worker fetch, and the app
  presign, any object in the bucket → `POST /api/jobs` takes only `media/…` keys.
- **Google `email_verified`** wasn't checked in the sign-in callback → required.

**Checked and fine:** bearer tokens are compared as SHA-256 digests with `timingSafeEqual` against
every secret (no early exit), unset secrets never match, and `make secrets` generates 256-bit
values; a bearer header wins over a session; `DEV_AUTH_BYPASS` and the dev provider exist only
with `NODE_ENV=development` (tier A runs production mode with it set and asserts it's ignored);
the cron route accepts only `CRON_SECRET` (tier A step 15); every body and query is Zod-validated
before the service runs; telemetry `source` comes from the token's scope, and the deploy health
check reads worker-sourced heartbeats only; presigned URLs are per key, 15 minutes; the tools'
guard refuses non-Amazon, checkout, payment, slot and sign-in URLs before navigating and as a CDP
route, and tier A asserts no checkout URL is ever opened; `cdp_url` must be loopback (config
regex), Chromium binds `127.0.0.1` and `make smoke` checks the listener; scripts pass tokens to
curl on stdin (`-K -`), never in argv or logs; CI is `pull_request` with `contents: read` (fork
PRs get no secrets), `deploy.yml` runs on `workflow_run` only for a successful `push` to `main`
from this repository, per-job `packages: write` only where it publishes.

**Accepted risks** (household scale; revisit if more people get access):

1. **Sessions pass the worker scope** (claim/complete jobs). Design §3.1: sessions are the
   household; the UI never calls those routes.
2. **Idempotency is check-then-store**: two concurrent requests with the same key can both run, and
   a reused key with a different body replays the first answer. Clients retry sequentially
   (worker, tools). A placeholder row inserted before the handler would close it.
3. **The agent token can act as any member** (`actor_discord_id`) and write any telemetry metric:
   the agent is trusted by design; the token lives in mode-600 env files on the Mac Mini.
4. **Presigned PUTs sign only `host`**: content type and size aren't enforced (fresh random keys,
   15-minute expiry, agent-only route).
5. **`next dev` listens on all interfaces**: with `DEV_AUTH_BYPASS=1`, a device on the same LAN
   acts as the first member of the *local* dev database. Use `pnpm dev -- -H 127.0.0.1` unless
   testing on a phone; never point dev at Turso.
6. **CDP on loopback is full control of a signed-in Amazon session** for any local process on the
   Mac Mini (single-user machine; Chrome checks the `Host` header and WebSocket origins against
   DNS rebinding).
7. **Tier-2 "never checkout" is a skill rule**: OpenClaw's browser tool has no URL denylist (M7
   Notes). Our tools enforce the guard in code; checkout still needs a human's "Place your order".
8. **`preview-migrate.yml` and `preview-e2e.yml` run same-repo PR code with the `preview`
   environment's secrets** (fork PRs are excluded; for `deployment_status` the PR's own copy of the
   workflow runs): the preview database, the preview bucket and the preview tokens, all synthetic
   or preview-only. Reset/seed refuse anything but a `preview` database (two signals). Add an environment protection
   rule if collaborators are added.
9. **The Mac updater runs whatever `origin/main` is once its GHCR image exists**: that requires
   CI, the migration and the web deploy to have succeeded for it; GHCR push rights equal repo
   write access.
10. **`photo submit --file` checks the extension, not the bytes**: a prompt-injected agent could
    upload a local file named `.jpg` to the household's own bucket. Skills treat message text as
    data and pass only attachment paths.
11. **No rate limiting** on the API: tokens are 256-bit; Vercel caps request bodies (4.5 MB).
