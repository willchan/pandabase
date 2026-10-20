# Thin wrappers over pnpm/uv. Targets marked "stub" are filled in by the milestone named.
.PHONY: install dev lint typecheck test check py-check smoke db-reset db-seed db-check contracts contracts-check

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
check: lint typecheck test py-check db-check contracts-check
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

smoke: # stub
	@echo "smoke: not implemented yet (M8)"; exit 1
