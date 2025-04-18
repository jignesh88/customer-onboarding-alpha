variable "aws_region" {
  description = "AWS region for resources"
  type        = string
  default     = "ap-southeast-2"  # Sydney region, often used for Australian banking apps
}

variable "project_prefix" {
  description = "Prefix for all resource names"
  type        = string
  default     = "bank-onboarding"
}

variable "environment" {
  description = "Deployment environment (dev, test, prod)"
  type        = string
  default     = "dev"
}

variable "notification_email" {
  description = "Email for notifications"
  type        = string
  default     = "admin@example.com"
}

variable "bedrock_model_id" {
  description = "Amazon Bedrock model ID"
  type        = string
  default     = "anthropic.claude-3-opus-20240229-v1:0"  # Using Claude 3 Opus for high-quality responses
}

# Third-party API configurations
variable "dvs_api_endpoint" {
  description = "Document Verification Service API endpoint"
  type        = string
  default     = "https://api.dvs.gov.au/verify"  # Example only; use actual endpoint
}

variable "dvs_api_key" {
  description = "Document Verification Service API key"
  type        = string
  sensitive   = true
}

variable "cdr_api_endpoint" {
  description = "Consumer Data Right API endpoint"
  type        = string
  default     = "https://api.cdr.gov.au/banking"  # Example only; use actual endpoint
}

variable "cdr_api_key" {
  description = "Consumer Data Right API key"
  type        = string
  sensitive   = true
}

variable "npp_api_endpoint" {
  description = "New Payments Platform API endpoint"
  type        = string
  default     = "https://api.nppa.com.au"  # Example only; use actual endpoint
}

variable "npp_api_key" {
  description = "New Payments Platform API key"
  type        = string
  sensitive   = true
}

variable "bsb_api_endpoint" {
  description = "BSB Lookup API endpoint"
  type        = string
  default     = "https://api.bsb.com.au/lookup"  # Example only; use actual endpoint
}

variable "bsb_api_key" {
  description = "BSB Lookup API key"
  type        = string
  sensitive   = true
}

variable "yodlee_api_endpoint" {
  description = "Yodlee API endpoint"
  type        = string
  default     = "https://api.yodlee.com.au/v1"  # Example only; use actual endpoint
}

variable "yodlee_api_key" {
  description = "Yodlee API key"
  type        = string
  sensitive   = true
}

variable "illion_api_endpoint" {
  description = "Illion BankStatements API endpoint"
  type        = string
  default     = "https://api.illion.com.au/bankstatements"  # Example only; use actual endpoint
}

variable "illion_api_key" {
  description = "Illion BankStatements API key"
  type        = string
  sensitive   = true
}

variable "basiq_api_endpoint" {
  description = "Basiq API endpoint"
  type        = string
  default     = "https://au-api.basiq.io"  # Example only; use actual endpoint
}

variable "basiq_api_key" {
  description = "Basiq API key"
  type        = string
  sensitive   = true
}