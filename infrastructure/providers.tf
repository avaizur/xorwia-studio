# Dedicated Xorwia Terraform provider and isolated remote S3 backend.
# Uses native S3 state locking (use_lockfile = true, Terraform >= 1.11).
# Completely isolated from other projects (never reuses 3 Trading Agents state).
# Supply environment-specific bucket/key via -backend-config=backend-dev.hcl or backend-prod.hcl.
# DO NOT RUN init/import/plan/apply without explicit approval.

terraform {
  required_version = ">= 1.11.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    region       = "eu-west-2"
    encrypt      = true
    use_lockfile = true
  }
}

variable "aws_region" {
  type        = string
  description = "AWS region for Xorwia entitlements resources"
  default     = "eu-west-2"
}

provider "aws" {
  region = var.aws_region
}
