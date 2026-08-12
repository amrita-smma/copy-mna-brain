.PHONY: help setup-worktree

.DEFAULT_GOAL := help

help:
	@echo "Available targets:"
	@echo "  setup-worktree  Copy .env.local from the main repo checkout into this worktree"
	@echo "                  (use FORCE=1 to overwrite an existing .env.local)"

# When run from inside a linked git worktree, locate the main checkout and copy
# its .env.local here. No-ops when run from the main checkout itself.
setup-worktree:
	@set -e; \
	git_dir="$$(git rev-parse --absolute-git-dir 2>/dev/null)" || { \
		echo "Not inside a git repository."; exit 1; \
	}; \
	common_dir="$$(cd "$$(git rev-parse --git-common-dir)" && pwd)"; \
	if [ "$$git_dir" = "$$common_dir" ]; then \
		echo "Not in a linked worktree (this is the main checkout) - nothing to do."; \
		exit 0; \
	fi; \
	main_repo="$$(git worktree list --porcelain | sed -n '1s/^worktree //p')"; \
	if [ -z "$$main_repo" ]; then \
		echo "Could not determine the main worktree path."; exit 1; \
	fi; \
	src="$$main_repo/.env.local"; \
	dest="$$(git rev-parse --show-toplevel)/.env.local"; \
	if [ ! -f "$$src" ]; then \
		echo "No .env.local found in the main checkout ($$src)."; exit 1; \
	fi; \
	if [ "$$src" = "$$dest" ]; then \
		echo "Source and destination are the same file - nothing to do."; exit 0; \
	fi; \
	if [ -e "$$dest" ] && [ "$(FORCE)" != "1" ]; then \
		echo ".env.local already exists at $$dest - leaving it untouched (re-run with FORCE=1 to overwrite)."; \
		exit 0; \
	fi; \
	cp "$$src" "$$dest"; \
	echo "Copied $$src -> $$dest"
