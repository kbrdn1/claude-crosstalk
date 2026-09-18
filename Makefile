.PHONY: help dev types typecheck validate test ci install enable-mods update uninstall version

SHELL := /bin/bash
CLAUDE ?= claude
TS_VERSION ?= 5.9.3

MARKETPLACE := claude-crosstalk
PLUGIN := crosstalk@$(MARKETPLACE)
# Where `make install` takes crosstalk from: this checkout by default,
# `SOURCE=kbrdn1/claude-crosstalk` for the published copy.
SOURCE ?= $(CURDIR)
SETTINGS ?= $(HOME)/.claude/settings.json
MODS_FLAG := CLAUDE_CODE_ENABLE_FUNCTION_HOOKS
WITH_MODS := $(MODS_FLAG)=1

.DEFAULT_GOAL := help

# Colors
GREEN = \033[0;32m
YELLOW = \033[0;33m
RED = \033[0;31m
BOLD = \033[1m
NC = \033[0m # No Color

help: ## Show this help
	@printf "${YELLOW}${BOLD}Available commands:${NC}\n"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' Makefile | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "${GREEN}make %-14s${NC} %s\n", $$1, $$2}'

# =============================================================================
# Development
# =============================================================================

dev: ## Start Claude Code with this checkout loaded as a mod (nothing installed)
	$(WITH_MODS) $(CLAUDE) --plugin-dir .

types: ## Regenerate types/claude-code.d.ts from the installed Claude Code
	@printf "${YELLOW}Writing the plugin API declarations...${NC}\n"
	$(WITH_MODS) $(CLAUDE) -p "/plugin-types" > /dev/null
	cp .claude/types/claude-code.d.ts types/claude-code.d.ts
	@printf "${GREEN}types/claude-code.d.ts: $$(head -1 types/claude-code.d.ts)${NC}\n"

# =============================================================================
# Code Quality
# =============================================================================

typecheck: ## Typecheck hooks and tests against types/
	@printf "${YELLOW}Typechecking...${NC}\n"
	bunx -p typescript@$(TS_VERSION) tsc -p tsconfig.json
	@printf "${GREEN}Typecheck clean.${NC}\n"

validate: ## Read the plugin the way the engine will (manifest, hooks, calls)
	$(WITH_MODS) $(CLAUDE) plugin validate .claude-plugin/plugin.json
	$(WITH_MODS) $(CLAUDE) plugin validate .

test: ## Run the mod's tests (claude plugin test)
	$(WITH_MODS) $(CLAUDE) plugin test .

ci: typecheck validate test ## Run local CI checks
	@printf "${GREEN}${BOLD}Local CI checks completed.${NC}\n"

# =============================================================================
# Install into Claude Code
# =============================================================================

install: ## Install crosstalk into Claude Code and turn mods on (SOURCE=kbrdn1/claude-crosstalk for GitHub)
	@printf "${YELLOW}Adding the $(MARKETPLACE) marketplace from $(SOURCE)...${NC}\n"
	@$(CLAUDE) plugin marketplace add "$(SOURCE)" || $(CLAUDE) plugin marketplace update $(MARKETPLACE)
	$(CLAUDE) plugin install $(PLUGIN)
	@$(MAKE) --no-print-directory enable-mods
	@printf "${GREEN}${BOLD}crosstalk installed: /crosstalk in any new session.${NC}\n"

enable-mods: ## Set CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 in settings.json env (merged, idempotent)
	@test -f "$(SETTINGS)" || echo '{}' > "$(SETTINGS)"
	@tmp=$$(mktemp) && jq '.env = ((.env // {}) + {"$(MODS_FLAG)": "1"})' "$(SETTINGS)" > "$$tmp" && mv "$$tmp" "$(SETTINGS)"
	@printf "${GREEN}$(MODS_FLAG)=1 set in $(SETTINGS).${NC}\n"

update: ## Pull the latest crosstalk into the installed copy
	$(CLAUDE) plugin marketplace update $(MARKETPLACE)
	$(CLAUDE) plugin update $(PLUGIN)

uninstall: ## Remove crosstalk and its marketplace (the mods flag stays)
	-$(CLAUDE) plugin uninstall $(PLUGIN)
	-$(CLAUDE) plugin marketplace remove $(MARKETPLACE)
	@printf "${YELLOW}$(MODS_FLAG) left in $(SETTINGS): other mods may use it.${NC}\n"

version: ## Print the plugin version and the Claude Code build the types come from
	@printf "crosstalk %s · types from %s\n" \
		"$$(jq -r .version .claude-plugin/plugin.json)" \
		"$$(head -1 types/claude-code.d.ts | sed 's/.*Claude Code //; s/\.$$//')"
