# Xorwia Entitlements & IAM Terraform Runbook

Manages the shared `xorwia_entitlements` DynamoDB table and the `XorwiaEntitlementsDynamoDBPolicy` inline policy on `xorwia-nova-lambda-role` using a **dedicated Xorwia-only Terraform backend**, completely isolated from 3 Trading Agents and all other projects.

## Isolated Backend Design
- **Dedicated S3 Bucket:** `xorwia-terraform-state-659705192571-eu-west-2` (region `eu-west-2`, never shared with 3 Trading Agents)
- **Separate State Keys:**
  - Dev (`backend-dev.hcl`): `xorwia-studio/dev/entitlements/terraform.tfstate`
  - Prod (`backend-prod.hcl`): `xorwia-studio/prod/entitlements/terraform.tfstate`
- **Encryption:** `encrypt = true` in backend config; bucket configured with default server-side encryption (SSE-S3 AES256 or KMS), Versioning enabled, all 4 Block Public Access settings enabled, and a bucket policy denying non-TLS (`aws:SecureTransport = false`) requests.
- **State Locking:** Dedicated DynamoDB lock table `xorwia-terraform-locks` (`LockID` String hash key, `PAY_PER_REQUEST`, PITR optional) compatible with Terraform `v1.8.3`. (If upgraded to Terraform `>= 1.10`, native S3 lockfiles via `use_lockfile = true` can replace the DynamoDB lock table.)

## Least-Privilege Backend IAM Policy (Scoped to Xorwia State Only)
Grant the Xorwia Terraform deployer role only the following backend permissions (zero access to any non-Xorwia state bucket):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "XorwiaTerraformStateListBucket",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::xorwia-terraform-state-659705192571-eu-west-2",
      "Condition": {
        "StringLike": {
          "s3:prefix": ["xorwia-studio/*"]
        }
      }
    },
    {
      "Sid": "XorwiaTerraformStateObjectRW",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::xorwia-terraform-state-659705192571-eu-west-2/xorwia-studio/*"
    },
    {
      "Sid": "XorwiaTerraformStateLocking",
      "Effect": "Allow",
      "Action": ["dynamodb:DescribeTable", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"],
      "Resource": "arn:aws:dynamodb:eu-west-2:659705192571:table/xorwia-terraform-locks"
    }
  ]
}
```

## Existing-Resource Import Safeguards
1. **Prerequisite:** Provision the dedicated `xorwia-terraform-state-659705192571-eu-west-2` S3 bucket and `xorwia-terraform-locks` DynamoDB table only after explicit approval.
2. **Import before plan/apply:** Both `xorwia_entitlements` and `xorwia-nova-lambda-role:XorwiaEntitlementsDynamoDBPolicy` already exist in production AWS. Running `apply` without importing would collide with the live table.
3. **Destruction guard:** `aws_dynamodb_table.xorwia_entitlements` sets `lifecycle { prevent_destroy = true }` to block accidental deletion or replacement.
4. **Scope & drift check:** After import, inspect `terraform plan` to confirm zero replacement/destruction on `xorwia_entitlements`, reconcile any `point_in_time_recovery`/`tags` drift first, and verify `XorwiaEntitlementsDynamoDBPolicy` changes only by adding `dynamodb:UpdateItem` on `arn:aws:dynamodb:eu-west-2:659705192571:table/xorwia_entitlements`.
5. **Preserve sibling policies:** Never alter `xorwia-nova-lambda-policy` or `XorwiaUserAccessDynamoDBPolicy`.

## Exact Prod Import Sequence (Run Only After Approval)

```bash
cd /home/ubuntu/projects/xorwia-studio/infrastructure

# 1. Initialize against the dedicated Xorwia prod state key
terraform init -backend-config=backend-prod.hcl

# 2. Import the existing production DynamoDB table
terraform import aws_dynamodb_table.xorwia_entitlements xorwia_entitlements

# 3. Import the existing IAM inline policy on xorwia-nova-lambda-role
terraform import aws_iam_role_policy.xorwia_entitlements_dynamodb xorwia-nova-lambda-role:XorwiaEntitlementsDynamoDBPolicy

# 4. Verify in-place diff only (no destroy/replace) before any approved apply
terraform plan
```

For dev environments, initialize with `-backend-config=backend-dev.hcl` (never import prod resources into dev state).
