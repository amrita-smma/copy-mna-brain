.PHONY: init-staging init-production

ACCOUNT_ID := $(shell aws sts get-caller-identity --query Account --output text)

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
