variable "aws_region" {
  description = "The AWS region to deploy resources into"
  type        = string
  default     = "eu-west-2"
}

variable "lambda_function_name" {
  description = "The exact name of the existing base Lambda function"
  type        = string
  default     = "xorwia-nova-backend"
}

variable "account_id" {
  description = "The AWS Account ID" 
  type        = string
}
