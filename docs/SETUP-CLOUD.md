# Phase 1: cloud setup

This guide sets up everything PandaBase runs in the cloud, using only a
browser and a password manager: no terminal, and nothing installed. It
works before the Mac Mini exists.

When you finish:

- the production site is live on Vercel, and you and your partner can sign
  in with Google;
- every merge to `main` deploys on its own: migrate the database → deploy
  the web app → publish the worker image;
- everything that needs the Mac Mini waits for Phase 2
  ([what's left](#phase-2-on-the-mac-mini)).

Budget about 90 minutes. Do the parts in order: later parts need values
from earlier ones. Each part ends with a **Check**.

## Before you start

- **Accounts:** GitHub (owner of `willchan/pandabase`), Turso, Cloudflare,
  Google, Vercel. Sign in to Turso and Vercel *with GitHub*: it saves
  passwords and links the repo.
- **Cloudflare R2 needs a payment method** on file, even inside the free
  tier.
- **A password manager** with a password generator. 1Password and
  Bitwarden let you set length and character types. Apple's Passwords app
  works too (see [part 1](#1-the-four-random-secrets)).
- **One secure note** in the password manager called *PandaBase*. Every
  value this guide asks you to "save" goes there. You'll copy from it into
  Vercel and GitHub, and later into the Mac Mini's `.env`.

> **Never paste a secret into a chat (including Claude), an issue, a PR or
> a commit.** Only into the password manager, Vercel and GitHub settings.
>
> **The repo is public**, and so are its Actions logs. Secrets stored in
> GitHub settings are masked in logs; that's why this guide never asks
> you to type an email or a secret into a workflow's inputs.

---

## 1. The four random secrets

PandaBase needs four random values. Nobody gives them to you; you make
them up.

- `AGENT_API_TOKEN`: the OpenClaw agent's API key
- `WORKER_API_TOKEN`: the worker's API key
- `AUTH_SECRET`: signs sign-in sessions
- `CRON_SECRET`: lets Vercel Cron call the nightly job

For each one:

1. Open your password manager's generator.
2. Choose **64 characters, letters and digits, no symbols.**
   (1Password: *Random password* type. Bitwarden: *Password*, special
   characters off.)
3. Save it in the *PandaBase* note under its name.

**Apple Passwords:** its *Strong Password* is a fixed format (about 20
characters with hyphens) and can't be set to 64. Generate two and join
them into one value; letters, digits and hyphens are all fine here.

These four never change unless you rotate them. On the Mac Mini they go
into `.env` and `.env.vercel` ([Phase 2](#phase-2-on-the-mac-mini));
`make secrets` keeps values that are already there and only fills in
missing ones.

**Check:** the note has four 64-character values with the names above.

---

## 2. Turso (the database)

You need two databases: `pandabase` (production) and `pandabase-preview`
(PR previews).

1. Open [app.turso.tech](https://app.turso.tech) → sign in with
   GitHub.
2. **Databases** → **Create Database** (on a new account it may say
   **New Database**).
3. Name: `pandabase`. Group/location: the default, or the region nearest
   you (e.g. US West). → **Create**.
   If it offers a choice of engine, keep the default (**libSQL**). Don't
   pick the new Rust engine (*Turso Database* / `tursodb`): on Turso Cloud
   it's an early preview, and PandaBase is built and tested on libSQL
   (`@libsql/client`, Drizzle's libSQL driver and migrations).
4. Open the database. Copy its **URL** (starts with `libsql://`) and save
   it as *prod `TURSO_DATABASE_URL`*.
5. On the same page: **Create Token** (sometimes under **⋯** or
   **Connect**). Pick **Read & Write** and **no expiration** if offered.
   Copy the token and save it as *prod `TURSO_AUTH_TOKEN`*. It is shown
   only once.
6. Repeat 2–5 for `pandabase-preview`. Save as *preview
   `TURSO_DATABASE_URL`* and *preview `TURSO_AUTH_TOKEN`*.

Don't create tables by hand: a GitHub workflow does that in
[part 8](#8-create-the-tables-and-the-members).

Docs: [Turso dashboard](https://docs.turso.tech/),
[database tokens](https://docs.turso.tech/cli/db/tokens/create)
(CLI page; the dashboard does the same).

**Check:** two databases listed; four values saved.

---

## 3. Cloudflare R2 (photo storage)

1. Open [dash.cloudflare.com](https://dash.cloudflare.com) → menu
   (☰) → **R2 Object Storage**. If asked, add the R2 subscription (free
   tier; needs a card).
2. **Create bucket** → name `pandabase-media` → location
   **Automatic** → **Create bucket**.
3. Back on the R2 **Overview** page, find **Account Details**. Save the
   **Account ID** as `R2_ACCOUNT_ID`.
4. Next to **API Tokens** select **Manage** → **Create Account API token**.
   - Name: `pandabase`
   - Permissions: **Object Read & Write**
   - Specify bucket(s): **Apply to specific buckets only** →
     `pandabase-media`
   - TTL: **Forever**
5. **Create API Token**. Save **Access Key ID** as `R2_ACCESS_KEY_ID`
   and **Secret Access Key** as `R2_SECRET_ACCESS_KEY` (shown only once).
   Ignore the token value and the endpoint shown above them.
6. Save `R2_BUCKET` = `pandabase-media`.

No CORS rule and no lifecycle rule: uploads come from the Mac Mini and
photos are kept (README step 3).

Docs: [R2 API tokens](https://developers.cloudflare.com/r2/api/tokens/),
[create a bucket](https://developers.cloudflare.com/r2/buckets/create-buckets/).

**Check:** the bucket is listed; four `R2_*` values saved.

---

## 4. Vercel: import the project

Do this before Google: Google needs your Vercel address.

1. Open [vercel.com](https://vercel.com) → sign in with GitHub.
2. **Add New…** → **Project**.
3. Under *Import Git Repository*, connect GitHub if asked. When GitHub
   asks which repositories the Vercel app may see, choose **Only select
   repositories** → `willchan/pandabase`.
4. **Import** next to `pandabase`.
5. **Project Name:** `pandabase`.
6. **Root Directory:** **Edit** → choose `web` → **Continue**.
   Framework should now read **Next.js**.
7. Skip *Environment Variables* here (part 6 adds them per environment).
   Select **Deploy**.
8. The first deployment may fail or show an error page. That's expected:
   it has no settings yet. Continue to the project dashboard.
9. Project → **Settings** → **Domains**. Your production address is the
   `….vercel.app` domain listed there (e.g. `pandabase.vercel.app`, or
   with a suffix if the name was taken). Save it as
   `PANDABASE_API_URL`, written as `https://<domain>` with no trailing
   slash.
10. **Settings → Build and Deployment → Root Directory:** keep
    **Include files outside the root directory in the Build Step**
    turned on (the app imports `/db`).

**Production auto-deploy is already off.** `web/vercel.json` sets
`git.deploymentEnabled.main: false`, so a push to `main` doesn't deploy
by itself; GitHub Actions deploys after migrating (DESIGN §8). Nothing
to switch in the dashboard. Leave **Settings → Git → Production
Branch** = `main`; PR branches still get preview deployments.

Docs: [import a project](https://vercel.com/docs/getting-started-with-vercel/import),
[root directory](https://vercel.com/docs/project-configuration/general-settings),
[git configuration](https://vercel.com/docs/project-configuration/git-configuration).

**Check:** the project exists and you saved its `https://…vercel.app`
address.

---

## 5. Google sign-in (OAuth)

Google's console moved the old *OAuth consent screen* into **Google Auth
Platform** (sections *Branding*, *Audience*, *Clients*).

1. Open
   [console.cloud.google.com](https://console.cloud.google.com) → project
   picker (top) → **New Project** → name `pandabase` → **Create**. Make
   sure it's selected.
2. Menu (☰) → **Google Auth Platform** (or *APIs & Services → OAuth
   consent screen*, which leads there) → **Get started**.
   - App name `PandaBase`, support email: yours.
   - Audience: **External**.
   - Contact email: yours. Agree → **Create**.
3. **Audience** → *Test users* → **Add users** → both Gmail addresses
   (yours and your partner's) → **Save**. Leave *Publishing status* on
   **Testing**: only test users can sign in, which is what we want.
4. **Clients** → **Create client** → type **Web application** → name
   `pandabase-web`.
5. **Authorized redirect URIs** → **Add URI**, one per line:
   - `https://<your domain>/api/auth/callback/google`
     (the domain from part 4, step 9)
   - `http://localhost:3000/api/auth/callback/google` (local dev)
6. **Create**. Save **Client ID** as `AUTH_GOOGLE_ID` and **Client
   secret** as `AUTH_GOOGLE_SECRET`. Google may not show the secret
   again; if there's a **Download JSON** option, you can skip it, the
   password manager is enough.
7. Save `ALLOWED_EMAILS` = both Gmail addresses, comma-separated,
   lowercase, no spaces: `you@gmail.com,partner@gmail.com`.

PandaBase asks only for name and email (no sensitive scopes), so Testing
mode needs no Google review.

Preview deployments get a new address per build, so Google sign-in on
previews needs a redirect URI per preview host. Skip that for now.

Docs: [manage OAuth clients](https://support.google.com/cloud/answer/15549257),
[test users / audience](https://support.google.com/cloud/answer/15549945).

**Check:** *Audience* shows 2 test users and *Testing*; *Clients* shows
`pandabase-web` with the production redirect URI exactly as above (a
trailing slash or `http` instead of `https` breaks sign-in).

---

## 6. Vercel: settings and the deploy token

### 6a. Environment variables

Vercel project → **Settings** → **Environment Variables**. Add each
variable: **Key**, **Value** (paste from the note), then tick the
environments. Turn on **Sensitive** for every secret. Leave
*Development* unticked.

Same value for **Production and Preview** (tick both):

- `AUTH_SECRET`
- `AUTH_GOOGLE_ID`
- `AUTH_GOOGLE_SECRET`
- `ALLOWED_EMAILS`
- `AGENT_API_TOKEN`
- `WORKER_API_TOKEN`
- `CRON_SECRET`
- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET` (`pandabase-media`)
- `HOUSEHOLD_TZ` (`America/Los_Angeles`)

Different per environment (add each twice, ticking one environment
each time):

- `TURSO_DATABASE_URL`: prod URL → **Production**; preview URL →
  **Preview**
- `TURSO_AUTH_TOKEN`: prod token → **Production**; preview token →
  **Preview**

Never add `DEV_AUTH_BYPASS` on Vercel.

Shortcut: the *Key* field accepts a pasted block of `KEY=value` lines and
splits it into rows. Only use it if your note has such a block; never
paste secrets anywhere else to build one.

### 6b. Token and IDs for GitHub Actions

The deploy workflow uses the Vercel CLI, which needs a token and two
IDs.

1. **Token:** avatar (top right) → **Account Settings** → **Tokens**
   (or open
   [vercel.com/account/settings/tokens](https://vercel.com/account/settings/tokens)).
   - Name `github-deploy`.
   - Scope: your team (the one that owns the project).
   - Expiration: the longest offered. If it expires, add a calendar
     reminder to replace the GitHub secret before then.
   - **Create** → save as `VERCEL_TOKEN` (shown only once).
2. **Org ID:** the team's **Settings** → **General** → **Team ID**
   (starts with `team_`). Save as `VERCEL_ORG_ID`. On an old personal
   account without a team, use **Account Settings → General → Vercel
   ID** instead.
3. **Project ID:** project → **Settings** → **General** → **Project ID**
   (starts with `prj_`). Save as `VERCEL_PROJECT_ID`.

Docs: [environment variables](https://vercel.com/docs/environment-variables),
[access tokens](https://vercel.com/docs/accounts/access-tokens),
[project settings](https://vercel.com/docs/project-configuration/general-settings).

**Check:** *Environment Variables* lists 16 rows: 12 shared + 2×2
`TURSO_*`. The note has `VERCEL_TOKEN`, `VERCEL_ORG_ID`,
`VERCEL_PROJECT_ID`.

---

## 7. GitHub: environments and secrets

Open
[github.com/willchan/pandabase](https://github.com/willchan/pandabase)
→ **Settings** → **Environments**.

### 7a. `production`

1. Open **production** if it's listed (failed Deploy runs created it),
   otherwise **New environment** → `production` → **Configure
   environment**.
2. **Deployment branches and tags** → **Selected branches and tags** →
   **Add deployment branch or tag rule** → `main`.
3. **Environment secrets** → **Add environment secret**, once each:
   - `TURSO_DATABASE_URL` (prod)
   - `TURSO_AUTH_TOKEN` (prod)
   - `VERCEL_TOKEN`
   - `VERCEL_ORG_ID`
   - `VERCEL_PROJECT_ID`
   - `ALLOWED_EMAILS` (same value as on Vercel; part 8 reads members'
     emails from it)
   - `AGENT_API_TOKEN` (optional: deploy telemetry for the weekly
     report)
4. **Environment variables** → **Add environment variable**:
   `PANDABASE_API_URL` = `https://<your domain>`.

### 7b. `preview`

1. **New environment** → `preview` (no branch rule: PR branches use
   it).
2. Environment secrets: `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`
   with the **preview** values. Add `ALLOWED_EMAILS` too if you ever
   want members in the preview database.

### 7c. Worker image (nothing to do)

The deploy publishes `ghcr.io/willchan/pandabase-worker`, a public image
([part 9](#9-first-deploy)). No token or setting is needed.

Docs: [deployment environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

**Check:** `production` shows 7 secrets (6 without telemetry), 1
variable and the `main` rule; `preview` shows 2 secrets.

---

## 8. Create the tables (and, optionally, the members)

The **Bootstrap** workflow runs the database commands for you. It is
safe to re-run: migrating twice changes nothing, and adding a member
again updates that member.

**Members are optional here.** Anyone in `ALLOWED_EMAILS` becomes a
member the first time they sign in (part 10), and you set their Discord
id, sweep and cart account in the app's **Settings**. Use `add-member`
only to set those fields before signing in, or to set the browser
*profile* (Settings doesn't edit it).

How to run it: GitHub (web or mobile app) → `pandabase` → **Actions** → **Bootstrap** →
**Run workflow** (branch `main`) → fill in → **Run**. Tick **Only
validate the inputs** first if you want to check a member's fields
without changing anything.

1. **Migrate production:** action `migrate`, target `production`.
2. **Migrate preview:** action `migrate`, target `preview`.
3. **Add yourself:** action `add-member`, target `production`:
   - member: your position in `ALLOWED_EMAILS` (`1` if your address is
     first). The workflow reads the email from that secret, so no email
     ever appears in the public run.
   - name: your first name
   - discord: your Discord user id ([how](#finding-a-discord-user-id);
     optional now)
   - profile: a short lowercase name for your Mac Mini browser profile,
     e.g. `will` (optional now)
   - sweep: `daily`
   - cart: ticked if your Amazon account fills the cart
4. **Add your partner:** the same with member `2`, their name, id and
   profile, sweep `weekly`, cart unticked.

Only one member is the cart account; ticking *cart* on someone moves it
to them. Fill in missing Discord ids or profiles later by running
`add-member` again with the same member number.

The run log masks emails and the Discord id. Name, profile and Discord id
are inputs, which GitHub may show on the run's page; Discord ids are
already visible to anyone in your server, but use a first name, not a
full name.

### Finding a Discord user id

1. Discord app → your avatar (bottom right) → **Settings** (gear) →
   **App Settings** → **Advanced** → turn on **Developer Mode**. (Older
   app versions: **Appearance** → **Advanced**.)
2. Open the member's profile (select their name in a channel or the member
   list) → **⋯** (top right) → **Copy User ID**.
3. Paste it into the *PandaBase* note. It is 17–20 digits.

**Check:** green Bootstrap runs (two migrates, plus any add-members). The add-member logs say
`added member ***` (or `updated` on a re-run). A red run lists every
wrong input at once, e.g. `ALLOWED_EMAILS has only 2 address(es), not 3`.

---

## 9. First deploy

Once `production` has its secrets, every merge to `main` deploys by
itself. For the first one:

- If an earlier Deploy run failed because secrets were missing (its
  first step says `GitHub environment 'production' not configured` and
  names them), open it: **Actions** → **Deploy** → that run → **Re-run
  jobs** → **Re-run all jobs**. Re-runs read the secrets as they are now,
  but GitHub only re-runs runs younger than 30 days.
- Otherwise, the next merge to `main` deploys (any small PR will do).

Watch three jobs go green in order: **migrate** → **deploy-web** →
**publish-worker** (the first build of the ARM worker image takes about
5 minutes; later ones reuse the cache). If the first step fails, its
message lists exactly which secrets are still missing in `production`.

**Worker image:** `ghcr.io/willchan/pandabase-worker` is **public**,
like the repo it's built from. It holds only that code (no secrets), and
being public means the Mac Mini pulls it without a GitHub token. Nothing
to change.

**Check:** the Deploy run is green. Vercel → **Deployments** shows a new
**Production** deployment of the same commit. Vercel → **Settings** →
**Cron Jobs** lists `/api/cron/maintenance`.

---

## 10. Sign in

1. Open `https://<your domain>/sign-in` → **Sign in with
   Google** → your Gmail.
2. Your partner does the same.
3. **Settings** in the app shows both members. If you skipped
   `add-member`, set each person's Discord id and receipt sweep there,
   and pick the cart account.

If sign-in fails:

- `redirect_uri_mismatch`: part 5 step 5, the URI must match exactly.
- *Access denied*: the email is missing from `ALLOWED_EMAILS` (part 6a;
  redeploy after changing it, by re-running the Deploy run), from Google
  test users (part 5).
- A server error: check that Vercel has all 16 variables and that
  Bootstrap's production migrate succeeded.

**Phase 1 is done.** From now on every merge to `main` migrates, deploys
the site and publishes a new worker image, without you doing anything.

---

## 11. Preview tests and the production smoke

Two automatic checks (docs/TESTING.md): every PR's preview runs a short
household week (**Preview E2E**), and every production deploy ends with
read-only checks (**smoke**). Both skip, or skip the checks that need a
missing secret, until you do this part. About 10 minutes, from a phone.

### 11a. Let the tests through preview protection

Vercel protects preview deployments (you get a Vercel login page
there). The tests use a secret that skips that page.

1. vercel.com → project `pandabase` → **Settings** → **Deployment
   Protection**.
2. **Protection Bypass for Automation** → **Add Secret** (or **Create**)
   → leave the value empty to let Vercel generate it → **Save**. Copy the
   value and save it in the note as `VERCEL_AUTOMATION_BYPASS_SECRET`.
   (Vercel also gives every deployment this value as an environment
   variable of the same name; nothing to add there.)
3. github.com/willchan/pandabase → **Settings** → **Environments** →
   **preview** → **Add environment secret** →
   `VERCEL_AUTOMATION_BYPASS_SECRET` = that value.
4. Vercel → **Settings → Git**: keep **Git Fork Protection** on (the
   default: fork PRs build only after you approve them). If the page
   lists **repository_dispatch events**, make sure they're on: the
   tests start from them.

The Preview E2E also needs the `preview` secrets from
[part 7b](#7b-preview) (the preview tokens, `AUTH_SECRET` and `R2_*`).
Until all of them exist, its run says *skipped* and stays green.

Regenerating or deleting the bypass secret breaks it for older
previews; update the GitHub secret right after.

**Check:** push to any PR (or GitHub → **Actions** → **Preview E2E** →
**Run workflow** with a preview's `https://….vercel.app` address). A
minute after Vercel's preview is ready, the PR's checks list **Preview
E2E** (pending, then green after about 5 minutes). Before you finish
this part it shows *Skipped, the preview environment isn't fully
configured*. Branches created before the tests existed say *merge main*.

### 11b. Production smoke secrets (optional)

The smoke needs nothing new to run; these make it check more:

- `production` environment → `AGENT_API_TOKEN` (already there if you
  added telemetry) and **`WORKER_API_TOKEN`** (the *prod* value): the
  smoke checks that each token works only where it should.
- `production` → **`DEPLOY_DISCORD_WEBHOOK_URL`**: the same
  `#pandabase` webhook as the Mac Mini's (README step 15); a failed
  smoke posts there once.

**Check:** the next Deploy run shows a fourth job, **smoke**, with a
table of checks in its summary. *worker heartbeat: no heartbeat yet* is
expected until the Mac Mini runs.

---

## Rolling back production

The smoke never rolls back by itself. If it fails (or the site is
broken), from a phone:

1. vercel.com → project `pandabase` → on the **Production Deployment**
   tile, **Instant Rollback** (or **Deployments** → the previous
   *Production* deployment → **⋯** → **Instant Rollback**).
2. Pick the deployment to go back to → **Confirm**. It switches in
   seconds; nothing is rebuilt.

What to know:

- On the Hobby plan you can roll back only to the **previous**
  production deployment; Pro can pick any earlier one.
- The rolled-back deployment keeps its **old environment variables and
  cron settings**.
- After a rollback Vercel stops promoting new production deploys on its
  own, so the next Deploy run's `vercel deploy --prod` won't go live by
  itself. Once a fix is merged and deployed, open that deployment →
  **⋯** → **Promote** (or **Undo Rollback**) to go back to normal.
- The database isn't rolled back. Migrations are backward-compatible,
  so the older code runs on the newer schema.

Docs: [Instant Rollback](https://vercel.com/docs/instant-rollback).

---

## Secrets map

Each value: where it comes from → where it goes. "Vercel P/Pv" means the
Production and Preview environments. "GH prod / GH preview" are the GitHub
environments. "Mac" is Phase 2.

**`AGENT_API_TOKEN`**
- From: password manager (part 1)
- To: Vercel P/Pv, GH prod (optional), Mac `.env`

**`WORKER_API_TOKEN`**
- From: password manager (part 1)
- To: Vercel P/Pv, Mac `.env`

**`AUTH_SECRET`**
- From: password manager (part 1)
- To: Vercel P/Pv, Mac `.env.vercel` (only so `make secrets` keeps it)

**`CRON_SECRET`**
- From: password manager (part 1)
- To: Vercel P/Pv, Mac `.env.vercel` (same reason)

**`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` (prod)**
- From: Turso, database `pandabase` (part 2)
- To: Vercel P, GH prod. Never the Mac.

**`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` (preview)**
- From: Turso, database `pandabase-preview` (part 2)
- To: Vercel Pv, GH preview. Never the Mac.

**`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`R2_BUCKET`**
- From: Cloudflare R2 (part 3)
- To: Vercel P/Pv

**`AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`**
- From: Google Auth Platform → Clients (part 5)
- To: Vercel P/Pv

**`ALLOWED_EMAILS`** (kept secret: the repo is public)
- From: you (part 5)
- To: Vercel P/Pv, GH prod (and GH preview, optional)

**`HOUSEHOLD_TZ`** (setting)
- To: Vercel P/Pv

**`VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`**
- From: Vercel (part 6b)
- To: GH prod

**`PANDABASE_API_URL`** (not secret)
- From: Vercel → Settings → Domains (part 4)
- To: GH prod (variable), Mac `.env`

**Later, Phase 2 only:** the Discord webhook URL
(`DEPLOY_DISCORD_WEBHOOK_URL` in Mac `.env`). README step 15.

The README's [Where each secret lives](../README.md#where-each-secret-lives)
has the same information as a table, plus rotation.

---

## Phase 2: on the Mac Mini

Follow the [README setup](../README.md#setup-from-zero). Phase 1 already
did steps 2–4, 6, 7 and 15.1–15.3; skip them. What's left:

1. **Step 1 (tools):** Homebrew, Docker, Ollama, the repo checkout. You
   can skip the `turso` and `vercel` CLIs.
2. **Step 5 (secrets), with your existing values. Don't generate new
   ones:**
   - `cp ops/mac.env.example .env`, then paste `AGENT_API_TOKEN` and
     `WORKER_API_TOKEN` from the note, and set `PANDABASE_API_URL`.
   - Create `.env.vercel` with `AUTH_SECRET=…` and `CRON_SECRET=…`.
   - Run `make secrets`: it keeps every value already set, fills only
     empty ones and sets file modes to 600. Copy the template first: if
     `.env` already exists, `make secrets` keeps that file as it is and
     won't add the template's other settings.
   - Skip `make vercel-env`; Vercel already has the values.
3. **Steps 8–14:** Mac base settings, agent tools and worker, Chromium
   profiles (the names you used as *profile* in part 8), OpenClaw and
   Discord, photo privacy, smoke test, backfill.
4. **Step 15.5–15.6:** the Discord webhook, `make install-update-timer`
   (15.4 needs nothing: the worker image is public).
5. Missing Discord ids: app **Settings**. Browser profile names:
   **Bootstrap** `add-member` (part 8).

---

## Notes from the first run (October 2026)

The guide was followed end to end, and every part worked as
written. Dashboards rename buttons now and then; if a label differs,
look for the nearest match. What the first run settled:

- **GitHub:** a container package that a workflow publishes for a
  public repo starts out public. We kept it public (part 9).
- **Deploy:** after part 7, a merge to `main` ran migrate → deploy-web
  → publish-worker green on its own; no re-run was needed.
- **Still assumed, not checked:** whether `workflow_dispatch` inputs
  are shown to everyone on a public repo's run page. Part 8 assumes they
  may be, so no email or secret is ever an input.
