locals {
  workspace_config = {
    staging = {
      name        = "staging"
      environment = "staging"
      tags = {
        Environment = "staging"
        Project     = "MnA"
        Service     = "MLflow"
        ManagedBy   = "Terraform"
      }
    }
    production = {
      name        = "production"
      environment = "production"
      tags = {
        Environment = "production"
        Project     = "MnA"
        Service     = "MLflow"
        ManagedBy   = "Terraform"
      }
    }
  }

  current_config   = lookup(local.workspace_config, terraform.workspace, local.workspace_config["staging"])
  environment_tags = merge(local.current_config.tags, var.tags)
}

resource "terraform_data" "workspace_guard" {
  lifecycle {
    precondition {
      condition     = contains(["staging", "production"], terraform.workspace)
      error_message = "This module can only be applied in 'staging' or 'production' workspace. Current workspace: '${terraform.workspace}'."
    }
  }
}

variable "aws_region" {
  description = "AWS region to deploy resources"
  type        = string
  default     = "ap-southeast-3"
}

variable "instance_type" {
  description = "EC2 instance type for MLflow server"
  type        = string
  default     = "t3.small"
}

variable "ebs_volume_size" {
  description = "EBS volume size in GB for root and artifact storage"
  type        = number
  default     = 30
}

variable "mlflow_port" {
  description = "Port for MLflow UI"
  type        = number
  default     = 5000

  validation {
    condition     = var.mlflow_port > 0 && var.mlflow_port < 65536
    error_message = "mlflow_port must be a valid TCP port (1-65535)."
  }
}

variable "python_version" {
  description = "Python version to install"
  type        = string
  default     = "3.11"

  validation {
    condition     = contains(["3.10", "3.11", "3.12"], var.python_version)
    error_message = "python_version must be 3.10, 3.11, or 3.12."
  }
}

variable "mlflow_version" {
  description = "MLflow version to install (empty for latest). Must be an exact version like 3.10.1, not 3.10."
  type        = string
  default     = "3.10.1"
}

variable "mlflow_workers" {
  description = "Number of MLflow server workers"
  type        = number
  default     = 1

  validation {
    condition     = var.mlflow_workers >= 1 && var.mlflow_workers <= 8
    error_message = "mlflow_workers must be between 1 and 8."
  }
}

variable "artifact_root_path" {
  description = "Path for MLflow artifact storage"
  type        = string
  default     = "/opt/mlflow/artifacts"
}

variable "backend_store_path" {
  description = "Path for SQLite backend store"
  type        = string
  default     = "/opt/mlflow/data/mlflow.db"
}

variable "tags" {
  description = "Additional tags to apply to resources"
  type        = map(string)
  default = {
    ManagedBy = "Terraform"
  }
}

variable "enable_traces" {
  description = "Enable MLflow trace serving (MLFLOW_SERVE_TRACES)"
  type        = bool
  default     = true
}

variable "otlp_endpoint" {
  description = "OTLP endpoint URL for trace ingestion (e.g., http://localhost:4318)"
  type        = string
  default     = ""
}

variable "otlp_headers" {
  description = "OTLP headers for authentication (e.g., authorization=Bearer token)"
  type        = string
  default     = ""
}

variable "otlp_protocol" {
  description = "OTLP protocol (http or grpc)"
  type        = string
  default     = "http"

  validation {
    condition     = contains(["http", "grpc"], var.otlp_protocol)
    error_message = "otlp_protocol must be 'http' or 'grpc'."
  }
}
