# Quire — root command interface
#
# One entry point for developers; native tooling per ecosystem:
#   pnpm   -> JavaScript workspace (canonical scripts live in package.json)
#   cargo  -> Rust workspace (canonical invocations live HERE, not in pnpm)
#   make   -> cross-ecosystem orchestration (this file)
#
# CI (.github/workflows/ci.yml) calls these same targets — keep them in
# sync by never redefining a workflow in two places. New workflows start
# as a make target; promote nothing to pnpm unless it is JS-native.

.DEFAULT_GOAL := help
SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c

PNPM  ?= pnpm
CARGO ?= cargo

.PHONY: help setup dev dev-landing lint lint-js lint-rust \
        format format-js format-rust format-check format-check-js format-check-rust \
        typecheck test test-js test-rust build build-js build-landing build-rust \
        check clean

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

setup: ## Install dependencies (pnpm + cargo fetch)
	$(PNPM) install
	$(CARGO) fetch --locked

dev: ## Run the desktop app (Tauri + Vite dev servers)
	$(PNPM) --filter md-app tauri dev

dev-landing: ## Run the landing page dev server
	$(PNPM) --filter md-landing dev

lint: lint-js lint-rust ## Lint JS and Rust

lint-js: ## ESLint over the JS workspace
	$(PNPM) lint

lint-rust: ## Clippy over the Rust workspace (warnings are errors)
	$(CARGO) clippy --workspace --all-targets -- -D warnings

format: format-js format-rust ## Apply formatters (Prettier + rustfmt)

format-js:
	$(PNPM) format

format-rust:
	$(CARGO) fmt --all

format-check: format-check-js format-check-rust ## Verify formatting only (no writes)

format-check-js:
	$(PNPM) format:check

format-check-rust:
	$(CARGO) fmt --all -- --check

typecheck: ## TypeScript check, no emit
	$(PNPM) typecheck

test: test-js test-rust ## Run all tests (Vitest + cargo)

test-js: ## Vitest, single run
	$(PNPM) test

test-rust: ## cargo test over the workspace
	$(CARGO) test --workspace

build: build-js build-rust ## Build everything

build-js: ## Frontend production build
	$(PNPM) build

build-landing: ## Build the landing page (static site in landing/dist)
	$(PNPM) build:landing

build-rust: ## Compile the Rust workspace
	$(CARGO) build --workspace

check: lint format-check typecheck test build ## Full verification suite (mirrors CI)

clean: ## Remove build artifacts
	$(CARGO) clean
	rm -rf md-app/dist landing/dist
