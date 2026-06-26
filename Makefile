.PHONY: help dev test build contract-deploy db-migrate db-reset clean dep-graph

help:
	@echo "Available targets:"
	@echo "  dev             - Start Postgres, API, and Web dev servers concurrently"
	@echo "  test            - Run npm and cargo tests"
	@echo "  build           - Build npm workspaces and cargo workspace"
	@echo "  contract-deploy - Deploy the Soroban contract"
	@echo "  db-migrate      - Run database migrations"
	@echo "  db-reset        - Drop/recreate DB, run migrations, and seed data"
	@echo "  dep-graph       - Generate dependency graph and update docs/dep-graph.svg"
	@echo "  clean           - Remove node_modules and build artifacts"

dev:
	npm run setup-env
	docker compose up -d postgres
	npm run dev:api & npm run dev:web

test:
	npm run build
	npm test
	cd contracts && cargo test

build:
	npm run build
	cd contracts && cargo build --release --target wasm32-unknown-unknown

contract-deploy:
	soroban contract deploy \
		--wasm contracts/target/wasm32-unknown-unknown/release/tariff_shield.wasm \
		--rpc-url $${STELLAR_RPC_URL:-https://soroban-testnet.stellar.org} \
		--network-passphrase "$${STELLAR_NETWORK_PASSPHRASE:-Test SDF Network ; September 2015}" \
		--source $${PLATFORM_STELLAR_SECRET}

db-migrate:
	docker compose up -d postgres
	npm run migrate

db-reset:
	docker compose down -v
	docker compose up -d postgres
	sleep 3
	npm run migrate
	npm run seed

dep-graph:
	npm run dep-graph -- --format dot | dot -Tsvg -o docs/dep-graph.svg
	@echo "Dependency graph updated: docs/dep-graph.svg"

clean:
	rm -rf node_modules
	rm -rf apps/*/node_modules
	rm -rf packages/*/node_modules
	cd contracts && cargo clean
	rm -rf apps/*/dist
	rm -rf packages/*/dist
