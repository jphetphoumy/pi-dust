SHELL := /bin/bash

.DEFAULT_GOAL := help

.PHONY: \
	help \
	install \
	hooks \
	setup-dev \
	lint \
	typecheck \
	test \
	test-watch \
	coverage \
	check \
	prepush \
	changelog \
	commitlint \
	clean

# ====== Colors & Icons ======
_esc  := \033
BLUE  := $(_esc)[34m
CYAN  := $(_esc)[36m
GREEN := $(_esc)[32m
YELL  := $(_esc)[33m
RED   := $(_esc)[31m
BOLD  := $(_esc)[1m
RESET := $(_esc)[0m

OK_ICON   := ✅
RUN_ICON  := ▶️
WARN_ICON := ⚠️
ERR_ICON  := ❌
BOX_H   := ──────────────────────────────────────────────────────────────
BOX_TOP := ╭$(BOX_H)╮
BOX_MID := ├$(BOX_H)┤
BOX_BOT := ╰$(BOX_H)╯

NPM := npm

define print_box
	@printf "$(BOLD)$(BLUE)$(BOX_TOP)\n│ $(RUN_ICON)  $(1)\n$(BOX_BOT)$(RESET)\n"
endef

define print_ok
	@printf "$(GREEN)$(OK_ICON)  $(1)$(RESET)\n"
endef

define print_warn
	@printf "$(YELL)$(WARN_ICON)  $(1)$(RESET)\n"
endef

define print_err
	@printf "$(BOLD)$(RED)$(ERR_ICON)  $(1)$(RESET)\n"
endef

help: ## Display available targets
	@printf "$(BOLD)$(BLUE)$(BOX_TOP)\n│ 📚  Available targets\n$(BOX_MID)$(RESET)\n"
	@grep -E '^[a-zA-Z0-9._-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	| sort \
	| awk 'BEGIN {FS = ":.*?## "}; {printf "$(BOLD)$(BLUE)│$(RESET)  $(CYAN)%-18s$(RESET) %s\n", $$1, $$2}'
	@printf "$(BOLD)$(BLUE)$(BOX_BOT)$(RESET)\n"

install: ## Install npm dependencies
	$(call print_box,Installing project dependencies)
	$(NPM) install
	$(call print_ok,Dependencies installed.)

hooks: ## Install local git hooks
	$(call print_box,Installing local git hooks)
	$(NPM) run prepare
	$(call print_ok,Git hooks installed.)

setup-dev: install hooks ## Setup dependencies and local hooks
	$(call print_ok,Development environment is ready.)

lint: ## Run ESLint
	$(call print_box,Running lint checks)
	$(NPM) run lint
	$(call print_ok,Lint checks passed.)

typecheck: ## Run TypeScript type-checking
	$(call print_box,Running TypeScript checks)
	$(NPM) run typecheck
	$(call print_ok,TypeScript checks passed.)

test: ## Run the Vitest suite
	$(call print_box,Running tests)
	$(NPM) test
	$(call print_ok,Tests passed.)

test-watch: ## Run Vitest in watch mode
	$(call print_box,Starting test watch mode)
	$(NPM) run test:watch

coverage: ## Run coverage reports
	$(call print_box,Running coverage)
	$(NPM) run coverage
	$(call print_ok,Coverage completed.)

check: ## Run the standard quality gate
	$(call print_box,Running standard quality gate)
	$(NPM) run check
	$(call print_ok,Quality gate passed.)

prepush: ## Run the extended pre-push gate
	$(call print_box,Running extended pre-push gate)
	$(NPM) run prepush
	$(call print_ok,Pre-push checks passed.)

changelog: ## Generate CHANGELOG.md
	$(call print_box,Generating changelog)
	$(NPM) run changelog
	$(call print_ok,Changelog generated.)

commitlint: ## Lint the current commit message file
	@if [ ! -f .git/COMMIT_EDITMSG ]; then \
		printf "$(BOLD)$(RED)$(ERR_ICON)  .git/COMMIT_EDITMSG was not found. Create a commit message first.$(RESET)\n"; \
		exit 1; \
	fi
	$(call print_box,Linting current commit message)
	$(NPM) run commitlint -- .git/COMMIT_EDITMSG
	$(call print_ok,Commit message is valid.)

clean: ## Remove generated local artifacts
	$(call print_box,Cleaning generated artifacts)
	rm -rf coverage RELEASE_NOTES.md
	$(call print_warn,Removed coverage/ and RELEASE_NOTES.md if they existed.)
