# Thin wrappers over pnpm/uv. Targets marked "stub" are filled in by the milestone named.
.PHONY: install dev lint typecheck test check py-check db-reset db-seed db-check contracts contracts-check \
	secrets vercel-env up down logs update install-agent-tools install-agent-skills install-agent-cron \
	install-chromium install-ollama-env backfill smoke ops-check

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

# Everything CI runs.
check: lint typecheck test py-check db-check contracts-check ops-check
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

up:
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f --tail=200 worker

# Manual update: git pull --ff-only, uv sync, docker compose up -d --build (M9 wraps this).
update:
	scripts/ops/update.sh

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

# Ops scripts lint clean, compose file valid, smoke helpers pass the projects' ruff/mypy (CI: ops).
ops-check:
	shellcheck -x scripts/ops/*.sh scripts/smoke/*.sh
	docker compose config --quiet
	$(MAKE) -s -n smoke backfill install-agent-skills update >/dev/null
	cd agent/tools && uv run ruff check --config pyproject.toml ../../scripts/smoke/cart_check.py && \
	  uv run ruff format --check --config pyproject.toml ../../scripts/smoke/cart_check.py && \
	  uv run mypy ../../scripts/smoke/cart_check.py
	cd worker && uv run ruff check --config pyproject.toml ../scripts/smoke/vlm_check.py && \
	  uv run ruff format --check --config pyproject.toml ../scripts/smoke/vlm_check.py && \
	  uv run mypy ../scripts/smoke/vlm_check.py
