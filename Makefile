.PHONY: help dev test build contract-deploy db db-wait db-migrate db-reset clean dep-graph check-dep-graph watch-contracts watch-contracts-docker

help:
	@echo "Available targets:"
	@echo "  dev             - Start Postgres, Redis, API, and Web dev servers concurrently"
	@echo "  test            - Run npm and cargo tests"
	@echo "  build           - Build npm workspaces and cargo workspace"
	@echo "  watch-contracts - Hot reload contract tests on file changes (cargo watch -x test)"
	@echo "  watch-contracts-docker - Same, fully dockerized (issue #1142, no local Rust needed)"
	@echo "  contract-deploy - Deploy the Soroban contract"
	@echo "  db              - Start Postgres and wait until it is healthy"
	@echo "  db-migrate      - Run database migrations"
	@echo "  db-reset        - Drop/recreate DB, run migrations, and seed data"
	@echo "  dep-graph       - Generate dependency graph and update docs/dep-graph.svg"
	@echo "  check-dep-graph - Fail if docs/dep-graph.svg is stale vs scripts/dep-graph.ts (needs Graphviz)"
	@echo "  clean           - Remove node_modules and build artifacts"

dev:
	npm run setup-env
	docker compose up -d postgres redis
	npm run dev

test:
	npm run build
	npm test
	cd contracts && cargo test

build:
	npm run build
	cd contracts && cargo build --release --target wasm32-unknown-unknown

watch-contracts:
	npm run watch:contracts

watch-contracts-docker:
	docker-compose --profile contracts up contracts

contract-deploy:
	soroban contract deploy \
		--wasm contracts/target/wasm32-unknown-unknown/release/tariff_shield.wasm \
		--rpc-url $${STELLAR_RPC_URL:-https://soroban-testnet.stellar.org} \
		--network-passphrase "$${STELLAR_NETWORK_PASSPHRASE:-Test SDF Network ; September 2015}" \
		--source $${PLATFORM_STELLAR_SECRET}

# Polls the postgres service's pg_isready healthcheck (see docker-compose.yml)
# instead of sleeping a fixed time. Override the budget with
# `make db-wait DB_WAIT_TIMEOUT=120`.
DB_WAIT_TIMEOUT ?= 60

db-wait:
	@echo "Waiting for Postgres to become healthy (timeout: $(DB_WAIT_TIMEOUT)s)..."
	@elapsed=0; \
	until docker compose exec -T postgres pg_isready -U tariffshield -d tariffshield >/dev/null 2>&1; do \
		if [ $$elapsed -ge $(DB_WAIT_TIMEOUT) ]; then \
			echo "ERROR: Postgres did not become healthy within $(DB_WAIT_TIMEOUT)s. Check 'docker compose logs postgres'." >&2; \
			exit 1; \
		fi; \
		sleep 1; elapsed=$$((elapsed + 1)); \
	done; \
	echo "Postgres is ready (after $${elapsed}s)."

db:
	docker compose up -d postgres
	$(MAKE) db-wait

db-migrate: db
	npm run migrate

db-reset:
	docker compose down -v
	$(MAKE) db
	npm run migrate
	npm run seed

dep-graph:
	npm run dep-graph -- --format dot | dot -Tsvg -o docs/dep-graph.svg
	@echo "Dependency graph updated: docs/dep-graph.svg"

check-dep-graph:
	npm run check:dep-graph

clean:
	rm -rf node_modules
	rm -rf apps/*/node_modules
	rm -rf packages/*/node_modules
	cd contracts && cargo clean
	rm -rf apps/*/dist
	rm -rf packages/*/dist
