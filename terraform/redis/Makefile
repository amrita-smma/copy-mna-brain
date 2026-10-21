.PHONY: init-staging init-production

ACCOUNT_ID = $(shell aws sts get-caller-identity --query Account --output text)

init-staging:
	@rm -rf .terraform terraform.tfstate terraform.tfstate.backup
	terraform init -backend-config="bucket=mna-tfstate-staging-$(ACCOUNT_ID)"
	@if terraform workspace list | grep -qw staging; then \
		echo "Selecting existing workspace: staging"; \
		terraform workspace select staging; \
	else \
		echo "Creating new workspace: staging"; \
		terraform workspace new staging; \
	fi

init-production:
	@rm -rf .terraform terraform.tfstate terraform.tfstate.backup
	terraform init -backend-config="bucket=mna-tfstate-production-$(ACCOUNT_ID)"
	@if terraform workspace list | grep -qw production; then \
		echo "Selecting existing workspace: production"; \
		terraform workspace select production; \
	else \
		echo "Creating new workspace: production"; \
		terraform workspace new production; \
	fi

# ------------------------------------------------------------- monitoring ---
# Inspect the live Redis with redis-cli over TLS. Host, password and CA come
# from this workspace's Terraform outputs, so run `make init-staging` (or
# init-production) first: the selected workspace is the environment you see.
# The password reaches redis-cli through REDISCLI_AUTH, never argv, so it stays
# out of `ps` and shell history. See README.md §Monitoring.
.PHONY: help redis-prereqs redis-health redis-ping redis-memory redis-keys \
	redis-stats redis-commands redis-clients redis-pubsub redis-slowlog \
	redis-bigkeys redis-memkeys redis-live redis-monitor redis-cli \
	redis-shell redis-host

AWS_REGION ?= ap-southeast-3

# Under .terraform/ so it is gitignored and wiped by init-* on a workspace
# switch. Delete it by hand after re-issuing the CA.
REDIS_CA := .terraform/redis-ca.pem

# Each recipe resolves the connection once with $(REDIS_CONN), then calls
# $(REDIS_CLI) as often as it likes: every `terraform output` reads remote state.
REDIS_CONN = export REDISCLI_AUTH="$$(terraform output -raw redis_url | sed -E 's|rediss://default:([^@]+)@.*|\1|')"; \
	REDIS_HOST="$$(terraform output -raw public_ip)"
REDIS_CLI = redis-cli --tls --cacert $(REDIS_CA) -h "$$REDIS_HOST" -p 6379

help: ## List the monitoring targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{ printf "  %-16s %s\n", $$1, $$2 }'

$(REDIS_CA):
	@test -d .terraform || { echo "No .terraform/: run make init-staging or init-production first"; exit 1; }
	@terraform output -raw redis_ca_pem > $@

redis-prereqs: $(REDIS_CA)
	@command -v redis-cli >/dev/null || { echo "redis-cli not found: brew install redis"; exit 1; }

redis-health: redis-prereqs ## One-screen summary: memory vs maxmemory, keys, clients, throughput
	@$(REDIS_CONN); $(REDIS_CLI) info everything | tr -d '\r' | awk -F: '\
	  { v[$$1] = $$2 } \
	  END { \
	    pct = v["maxmemory"] > 0 ? 100 * v["used_memory"] / v["maxmemory"] : 0; \
	    printf "version      %s (up %s days)\n", v["redis_version"], v["uptime_in_days"]; \
	    printf "memory       %s of %s (%.1f%%), peak %s\n", v["used_memory_human"], v["maxmemory_human"], pct, v["used_memory_peak_human"]; \
	    printf "keys (db0)   %s\n", (v["db0"] == "" ? "0 (empty)" : v["db0"]); \
	    printf "clients      %s connected, %s blocked, %s rejected since start\n", v["connected_clients"], v["blocked_clients"], v["rejected_connections"]; \
	    printf "keys gone    %s expired, %s evicted since start\n", v["expired_keys"], v["evicted_keys"]; \
	    printf "throughput   %s ops/s now, %s commands since start\n", v["instantaneous_ops_per_sec"], v["total_commands_processed"]; \
	    printf "pub/sub      %s channels, %s patterns\n", v["pubsub_channels"], v["pubsub_patterns"]; \
	    if (pct >= 80) printf "\nWARNING: memory is %.1f%% of maxmemory; with noeviction, writes fail when full.\n", pct; \
	  }'

redis-ping: redis-prereqs ## PING over TLS (expects PONG)
	@$(REDIS_CONN); $(REDIS_CLI) ping

redis-memory: redis-prereqs ## INFO memory: used_memory vs maxmemory
	@$(REDIS_CONN); $(REDIS_CLI) info memory

redis-keys: redis-prereqs ## Current key count and how many carry a TTL
	@$(REDIS_CONN); $(REDIS_CLI) info keyspace

redis-stats: redis-prereqs ## INFO stats: expired/evicted keys, ops, rejected connections
	@$(REDIS_CONN); $(REDIS_CLI) info stats

redis-commands: redis-prereqs ## Calls per command (SET, PUBLISH, ...) since start
	@$(REDIS_CONN); $(REDIS_CLI) info commandstats

redis-clients: redis-prereqs ## Connected clients
	@$(REDIS_CONN); $(REDIS_CLI) info clients && $(REDIS_CLI) client list

redis-pubsub: redis-prereqs ## Active pub/sub channels and their subscriber counts
	@$(REDIS_CONN); for ch in $$($(REDIS_CLI) pubsub channels); do \
	  $(REDIS_CLI) pubsub numsub "$$ch" | paste - -; \
	done

redis-slowlog: redis-prereqs ## The 10 most recent slow commands (>10ms)
	@$(REDIS_CONN); $(REDIS_CLI) slowlog get 10

redis-bigkeys: redis-prereqs ## Largest key per type (SCAN-based, safe on a live server)
	@$(REDIS_CONN); $(REDIS_CLI) --bigkeys

redis-memkeys: redis-prereqs ## Largest keys by memory (SCAN-based)
	@$(REDIS_CONN); $(REDIS_CLI) --memkeys

redis-live: redis-prereqs ## Rolling once-a-second stats (Ctrl-C to stop)
	@$(REDIS_CONN); $(REDIS_CLI) --stat

redis-monitor: redis-prereqs ## Stream every command (heavy: run briefly, Ctrl-C to stop)
	@echo "MONITOR slows the server; stop with Ctrl-C as soon as you have what you need." >&2
	@$(REDIS_CONN); $(REDIS_CLI) monitor

redis-cli: redis-prereqs ## Interactive redis-cli session
	@$(REDIS_CONN); $(REDIS_CLI)

redis-shell: ## SSM shell on the instance (needs session-manager-plugin)
	aws ssm start-session --region $(AWS_REGION) --target "$$(terraform output -raw instance_id)"

redis-host: ## Host health over SSM: memory, disk, container stats, recent unit logs
	aws ssm start-session --region $(AWS_REGION) --target "$$(terraform output -raw instance_id)" \
	  --document-name AWS-StartInteractiveCommand \
	  --parameters '{"command":["free -h && df -h / && sudo docker stats --no-stream && sudo docker ps && sudo journalctl -u redis -n 20 --no-pager"]}'
