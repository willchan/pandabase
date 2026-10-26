# Thin wrappers over pnpm/uv. Targets marked "stub" are filled in by the milestone named.
.PHONY: install dev lint typecheck test check py-check db-reset db-seed db-check contracts contracts-check \
	secrets vercel-env up up-local down logs update update-pause update-resume update-status rollback \
	install-update-timer deploy-test migrations-check install-agent-tools install-agent-skills install-agent-cron \
	install-chromium install-ollama-env backfill smoke ops-check e2e-system system-lint eval-agent

PY_PROJECTS := worker agent/tools

install:
	pnpm install
	@for p in $(PY_PROJECTS); do (cd $$p && uv sync) || exit 1; done

dev:
	pnpm dev

lint:
	pnpm lint

typecheck:
	pnpm typecheck

test:
	pnpm test

py-check:
	@for p in $(PY_PROJECTS); do \
	  (cd $$p && uv run ruff check && uv run ruff format --check && uv run mypy . && uv run pytest) || exit 1; \
	done

# The system test's Python (tests/system) passes agent/tools' ruff + strict mypy.
system-lint:
	cd agent/tools && uv run ruff check --config pyproject.toml ../../tests/system && \
	  uv run ruff format --check --config pyproject.toml ../../tests/system && \
	  uv run mypy --config-file pyproject.toml ../../tests/system

# Tier A system test (docs/TESTING.md): next build + start, the real worker against fake
# Ollama/R2, the real pandabase-tools running the skills' commands, Playwright for the web UI.
# SYSTEM_BUILD=0 reuses web/.next-system; SYSTEM_KEEP=<dir> keeps the db and logs.
e2e-system:
	cd agent/tools && uv run pytest -c ../../tests/system/pytest.ini ../../tests/system

# Tier B (docs/TESTING.md): the real OpenClaw agent + our skills on a local Ollama model against
# the tier A stack; reports a pass rate. Skips without `openclaw` on PATH or EVAL_MODEL pulled.
# EVAL_MODEL (qwen3.5:4b), EVAL_OLLAMA_URL, EVAL_MIN_PASS_RATE (0), EVAL_REPORT_DIR.
eval-agent:
	cd agent/tools && uv run pytest -c ../../tests/system/pytest.ini -o python_files=eval_*.py -rs \
	  ../../tests/system

# Everything CI runs.
check: lint typecheck test py-check system-lint db-check contracts-check ops-check
	pnpm --filter web build

db-reset:
	pnpm db:reset

db-seed:
	pnpm db:seed

# Migrations consistent and up to date with the schema, and the seed loads.
db-check:
	pnpm drizzle-kit check
	pnpm db:generate
	@test -z "$$(git status --porcelain -- db/migrations)" || \
	  (git status --porcelain -- db/migrations; echo "db/migrations differs from HEAD: commit the generated migration"; exit 1)
	pnpm db:reset && pnpm db:seed

# Zod → contracts/openapi.json → worker/agent Pydantic models (commit the output).
contracts:
	pnpm contracts:gen

# Generated contracts are up to date with web/lib/contracts.
contracts-check: contracts
	@git diff --exit-code --stat -- contracts worker/src/pandabase_worker/contracts.py agent/tools/src/pandabase_tools/contracts.py || \
	  (echo "generated contracts are stale: run pnpm contracts:gen and commit"; exit 1)

# --- Mac Mini ops (README; scripts in scripts/ops, scripts/smoke). All idempotent. ---------------

# .env (Mac Mini) + .env.vercel: generate missing tokens; never prints or changes existing ones.
secrets:
	scripts/ops/secrets.sh

# Add the generated secrets to the linked Vercel project (skips ones already there).
vercel-env:
	scripts/ops/vercel-env.sh

# The worker image CI published (PANDABASE_WORKER_TAG in .env; `make update` pins it).
up:
	docker compose up -d

# Build ./worker locally instead (docker-compose.build.yml).
up-local:
	docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build

down:
	docker compose down

logs:
	docker compose logs -f --tail=200 worker

# Continuous deployment (PLAN M9): newest green main → pull → health check → rollback on failure.
# The launchd timer (install-update-timer) runs it every 15 min; DRY_RUN=1 prints instead.
update:
	scripts/deploy/mac-update.sh

update-pause:
	scripts/deploy/mac-update.sh pause

update-resume:
	scripts/deploy/mac-update.sh resume

update-status:
	scripts/deploy/mac-update.sh status

# Roll back by hand (TO=<sha>, default: the sha before the last update); pauses auto-update.
rollback:
	scripts/deploy/mac-update.sh rollback $(TO)

install-update-timer:
	scripts/ops/install-update-timer.sh

# uv sync agent/tools, link pandabase-tools into BIN_DIR, create agent configs from examples.
install-agent-tools:
	scripts/ops/install-agent-tools.sh

# skills.load.extraDirs += <repo>/agent/skills (backs up openclaw.json) + gateway env.
install-agent-skills:
	scripts/ops/install-agent-skills.sh

# Register / update the OpenClaw automations from agent/cron.example.json.
install-agent-cron:
	scripts/ops/install-agent-cron.sh

# OLLAMA_NUM_PARALLEL=1, OLLAMA_MAX_LOADED_MODELS=1 for the native Ollama app (LaunchAgent).
install-ollama-env:
	scripts/ops/install-ollama-env.sh

# One Chromium LaunchAgent per profile in agent/profiles.json (loopback-only CDP).
install-chromium:
	scripts/ops/install-chromium.sh

# 12-month receipt backfill, resumable (MEMBER=name for one member).
backfill:
	scripts/ops/backfill.sh

# Live checks against production; SMOKE_CART=1 / SMOKE_E2E=1 for the opt-in ones (README).
smoke:
	scripts/smoke/run.sh

# Deploy scripts' tests (git/docker/network stubbed) and the backward-compatible-migration check.
deploy-test:
	bats scripts/deploy/tests

MIGRATIONS_BASE ?= origin/main
migrations-check:
	scripts/deploy/check-migrations.sh --base $(MIGRATIONS_BASE)

# Ops scripts lint clean, compose files and plists valid, workflows lint clean, deploy tests pass,
# smoke helpers pass the projects' ruff/mypy (CI: ops).
ops-check: deploy-test migrations-check
	shellcheck -x scripts/ops/*.sh scripts/smoke/*.sh scripts/deploy/*.sh
	actionlint .github/workflows/*.yml
	docker compose config --quiet
	docker compose -f docker-compose.yml -f docker-compose.build.yml config --quiet
	xmllint --noout ops/launchd/*.plist
	python3 -c 'import plistlib, sys; [plistlib.load(open(f, "rb")) for f in sys.argv[1:]]' ops/launchd/*.plist
	$(MAKE) -s -n smoke backfill install-agent-skills update install-update-timer >/dev/null
	cd agent/tools && uv run ruff check --config pyproject.toml ../../scripts/smoke/cart_check.py && \
	  uv run ruff format --check --config pyproject.toml ../../scripts/smoke/cart_check.py && \
	  uv run mypy ../../scripts/smoke/cart_check.py
	cd worker && uv run ruff check --config pyproject.toml ../scripts/smoke/vlm_check.py && \
	  uv run ruff format --check --config pyproject.toml ../scripts/smoke/vlm_check.py && \
	  uv run mypy ../scripts/smoke/vlm_check.py
