# Xorwia Entitlements & IAM Terraform Runbook

Manages the shared `xorwia_entitlements` DynamoDB table and the `XorwiaEntitlementsDynamoDBPolicy` inline policy on `xorwia-nova-lambda-role` using a **dedicated Xorwia-only S3 backend with native S3 locking**, completely isolated from 3 Trading Agents and all other projects.

## Isolated Backend Design
- **Minimum Terraform Version:** `>= 1.11.0` (required for GA native S3 `.tflock` locking)
- **Dedicated S3 Bucket:** `xorwia-terraform-state-659705192571-eu-west-2` (`eu-west-2`, never shared with 3 Trading Agents)
- **Separate State Keys:**
  - Dev (`backend-dev.hcl`): `xorwia-studio/dev/entitlements/terraform.tfstate` (lock: `...terraform.tfstate.tflock`)
  - Prod (`backend-prod.hcl`): `xorwia-studio/prod/entitlements/terraform.tfstate` (lock: `...terraform.tfstate.tflock`)
- **Encryption & Hardening:** `encrypt = true`; bucket configured with SSE-S3 (`AES256`), Versioning enabled, all 4 Block Public Access controls enabled, and a bucket policy denying non-TLS (`aws:SecureTransport = false`) requests.
- **Native S3 State Locking:** `use_lockfile = true` creates a `.tflock` object alongside the state key using S3 conditional writes (`If-None-Match: *`) and deletes it on unlock. No DynamoDB lock table is required.

## Least-Privilege S3 & `.tflock` IAM Policy (Scoped to Xorwia State Only)
Grant the Xorwia Terraform deployer role only these backend permissions (zero access to non-Xorwia buckets; `s3:DeleteObject` restricted strictly to `*.tflock` lock files so state objects cannot be deleted):

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
      "Sid": "XorwiaTerraformStateAndLockRW",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::xorwia-terraform-state-659705192571-eu-west-2/xorwia-studio/*"
    },
    {
      "Sid": "XorwiaTerraformLockFileDeleteOnly",
      "Effect": "Allow",
      "Action": ["s3:DeleteObject"],
      "Resource": "arn:aws:s3:::xorwia-terraform-state-659705192571-eu-west-2/xorwia-studio/*.tflock"
    }
  ]
}
```

## Safe Terraform CLI Upgrade on EC2 (Zero Impact to 3 Trading Agents)
The EC2 host currently runs `/usr/local/bin/terraform` (`v1.8.3`). To avoid changing the binary used by 3 Trading Agents, install Terraform `1.11.x` **side-by-side** as `/usr/local/bin/terraform-1.11` (leave `/usr/local/bin/terraform` untouched):

```bash
# Run ONLY after explicit approval (check disk space first: df -h /)
TF_VER="1.11.4"
TMP=$(mktemp -d)
curl -fsSL "https://releases.hashicorp.com/terraform/${TF_VER}/terraform_${TF_VER}_linux_amd64.zip" -o "$TMP/terraform_${TF_VER}_linux_amd64.zip"
curl -fsSL "https://releases.hashicorp.com/terraform/${TF_VER}/terraform_${TF_VER}_SHA256SUMS" -o "$TMP/SHA256SUMS"
(cd "$TMP" && grep "terraform_${TF_VER}_linux_amd64.zip" SHA256SUMS | sha256sum -c -)
unzip -o "$TMP/terraform_${TF_VER}_linux_amd64.zip" terraform -d "$TMP"
sudo install -m 0755 "$TMP/terraform" /usr/local/bin/terraform-1.11
rm -rf "$TMP"

# Verify isolation: default binary unchanged, new binary ready for Xorwia
/usr/local/bin/terraform version      # remains v1.8.3 (3 Trading Agents unaffected)
/usr/local/bin/terraform-1.11 version # v1.11.4 (used for Xorwia)
```

Rollback of CLI install: `sudo rm -f /usr/local/bin/terraform-1.11`.

## Existing-Resource Import Safeguards
1. **Import before plan/apply:** Both `xorwia_entitlements` and `xorwia-nova-lambda-role:XorwiaEntitlementsDynamoDBPolicy` already exist in production AWS. Running `apply` without importing would collide with the live table.
2. **Destruction guard:** `aws_dynamodb_table.xorwia_entitlements` sets `lifecycle { prevent_destroy = true }`.
3. **Scope & drift check:** After import, inspect `terraform-1.11 plan` to confirm zero replacement/destruction on `xorwia_entitlements`, reconcile any `point_in_time_recovery`/`tags` drift first, and verify `XorwiaEntitlementsDynamoDBPolicy` changes only by adding `dynamodb:UpdateItem` on `arn:aws:dynamodb:eu-west-2:659705192571:table/xorwia_entitlements`.
4. **Preserve sibling policies:** Never alter `xorwia-nova-lambda-policy` or `XorwiaUserAccessDynamoDBPolicy`.

## Exact Prod Import Sequence (Run Only After Approval)

```bash
cd /home/ubuntu/projects/xorwia-studio/infrastructure

# 1. Initialize against the dedicated Xorwia prod state key with native S3 locking
terraform-1.11 init -backend-config=backend-prod.hcl

# 2. Import the existing production DynamoDB table
terraform-1.11 import aws_dynamodb_table.xorwia_entitlements xorwia_entitlements

# 3. Import the existing IAM inline policy on xorwia-nova-lambda-role
terraform-1.11 import aws_iam_role_policy.xorwia_entitlements_dynamodb xorwia-nova-lambda-role:XorwiaEntitlementsDynamoDBPolicy

# 4. Verify in-place diff only (no destroy/replace) before any approved apply
terraform-1.11 plan
```

For dev environments, initialize with `-backend-config=backend-dev.hcl` (never import prod resources into dev state).
