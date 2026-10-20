# Thin wrappers over pnpm/uv. Targets marked "stub" are filled in by the milestone named.
.PHONY: install dev lint typecheck test check py-check smoke db-reset db-seed contracts

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
check: lint typecheck test py-check
	pnpm --filter web build

db-reset: # stub
	@echo "db-reset: not implemented yet (M2)"; exit 1

db-seed: # stub
	@echo "db-seed: not implemented yet (M2)"; exit 1

contracts: # stub
	@echo "contracts: not implemented yet (M4)"; exit 1

smoke: # stub
	@echo "smoke: not implemented yet (M8)"; exit 1
