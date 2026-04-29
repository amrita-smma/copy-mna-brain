.PHONY: init-staging init-production

init-staging:
	@rm -rf .terraform terraform.tfstate terraform.tfstate.backup
	terraform init
	@if terraform workspace list | grep -qw staging; then \
		echo "Selecting existing workspace: staging"; \
		terraform workspace select staging; \
	else \
		echo "Creating new workspace: staging"; \
		terraform workspace new staging; \
	fi

init-production:
	@rm -rf .terraform terraform.tfstate terraform.tfstate.backup
	terraform init
	@if terraform workspace list | grep -qw production; then \
		echo "Selecting existing workspace: production"; \
		terraform workspace select production; \
	else \
		echo "Creating new workspace: production"; \
		terraform workspace new production; \
	fi
