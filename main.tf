terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  required_version = ">= 1.2.0"
}

provider "aws" {
  region = var.aws_region
}

# --------------------------------------
# S3 Buckets
# --------------------------------------
resource "aws_s3_bucket" "onboarding_documents" {
  bucket = "${var.project_prefix}-onboarding-documents"
}

resource "aws_s3_bucket_versioning" "onboarding_documents_versioning" {
  bucket = aws_s3_bucket.onboarding_documents.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "onboarding_documents_encryption" {
  bucket = aws_s3_bucket.onboarding_documents.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# --------------------------------------
# DynamoDB Tables
# --------------------------------------
resource "aws_dynamodb_table" "customers" {
  name         = "${var.project_prefix}-customers"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "customer_id"

  attribute {
    name = "customer_id"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  tags = {
    Name = "Customer Data"
  }
}

resource "aws_dynamodb_table" "accounts" {
  name         = "${var.project_prefix}-accounts"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "account_id"

  attribute {
    name = "account_id"
    type = "S"
  }

  attribute {
    name = "customer_id"
    type = "S"
  }

  global_secondary_index {
    name               = "CustomerIdIndex"
    hash_key           = "customer_id"
    projection_type    = "ALL"
    write_capacity     = 0
    read_capacity      = 0
  }

  point_in_time_recovery {
    enabled = true
  }

  tags = {
    Name = "Account Data"
  }
}

resource "aws_dynamodb_table" "onboarding_process" {
  name         = "${var.project_prefix}-onboarding-process"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "process_id"

  attribute {
    name = "process_id"
    type = "S"
  }

  attribute {
    name = "customer_id"
    type = "S"
  }

  global_secondary_index {
    name               = "CustomerIdIndex"
    hash_key           = "customer_id"
    projection_type    = "ALL"
    write_capacity     = 0
    read_capacity      = 0
  }

  ttl {
    attribute_name = "expiry_time"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }

  tags = {
    Name = "Onboarding Process Data"
  }
}