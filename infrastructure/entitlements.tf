# Shared Product Entitlements Store (DynamoDB)
# Table design supports multi-product entitlements per external user identity.
# DO NOT APPLY until planned deployment.

resource "aws_dynamodb_table" "xorwia_entitlements" {
  name         = "xorwia_entitlements"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "external_user_id"
  range_key    = "product"

  attribute {
    name = "external_user_id"
    type = "S"
  }

  attribute {
    name = "product"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  tags = {
    Project     = "xorwia-studio"
    Environment = "production"
    ManagedBy   = "terraform"
    Purpose     = "shared-entitlements"
  }
}
