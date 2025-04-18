# --------------------------------------
# Lambda Functions
# --------------------------------------
# Orchestrator Lambda
resource "aws_lambda_function" "orchestrator" {
  function_name    = "${var.project_prefix}-orchestrator"
  filename         = "${path.module}/lambda/orchestrator.zip"
  handler          = "index.handler"
  role             = aws_iam_role.lambda_role.arn
  runtime          = "nodejs18.x"
  timeout          = 30
  memory_size      = 256
  
  environment {
    variables = {
      STEP_FUNCTION_ARN = aws_sfn_state_machine.customer_onboarding.arn
      DYNAMODB_CUSTOMERS_TABLE = aws_dynamodb_table.customers.name
      DYNAMODB_ONBOARDING_TABLE = aws_dynamodb_table.onboarding_process.name
      BEDROCK_MODEL_ID = var.bedrock_model_id
      ENVIRONMENT = var.environment
    }
  }
}

# ID Verification Lambda
resource "aws_lambda_function" "id_verification" {
  function_name    = "${var.project_prefix}-id-verification"
  filename         = "${path.module}/lambda/id_verification.zip"
  handler          = "index.handler"
  role             = aws_iam_role.lambda_role.arn
  runtime          = "nodejs18.x"
  timeout          = 60
  memory_size      = 512
  
  environment {
    variables = {
      S3_BUCKET = aws_s3_bucket.onboarding_documents.id
      DYNAMODB_ONBOARDING_TABLE = aws_dynamodb_table.onboarding_process.name
      DVS_API_ENDPOINT = var.dvs_api_endpoint
      DVS_API_KEY = var.dvs_api_key
      ENVIRONMENT = var.environment
    }
  }
}

# Biometric Check Lambda
resource "aws_lambda_function" "biometric_check" {
  function_name    = "${var.project_prefix}-biometric-check"
  filename         = "${path.module}/lambda/biometric_check.zip"
  handler          = "index.handler"
  role             = aws_iam_role.lambda_role.arn
  runtime          = "nodejs18.x"
  timeout          = 60
  memory_size      = 512
  
  environment {
    variables = {
      S3_BUCKET = aws_s3_bucket.onboarding_documents.id
      DYNAMODB_ONBOARDING_TABLE = aws_dynamodb_table.onboarding_process.name
      ENVIRONMENT = var.environment
    }
  }
}

# AML Screening Lambda
resource "aws_lambda_function" "aml_screening" {
  function_name    = "${var.project_prefix}-aml-screening"
  filename         = "${path.module}/lambda/aml_screening.zip"
  handler          = "index.handler"
  role             = aws_iam_role.lambda_role.arn
  runtime          = "nodejs18.x"
  timeout          = 60
  memory_size      = 256
  
  environment {
    variables = {
      DYNAMODB_CUSTOMERS_TABLE = aws_dynamodb_table.customers.name
      DYNAMODB_ONBOARDING_TABLE = aws_dynamodb_table.onboarding_process.name
      ENVIRONMENT = var.environment
    }
  }
}

# Account Creation Lambda
resource "aws_lambda_function" "account_creation" {
  function_name    = "${var.project_prefix}-account-creation"
  filename         = "${path.module}/lambda/account_creation.zip"
  handler          = "index.handler"
  role             = aws_iam_role.lambda_role.arn
  runtime          = "nodejs18.x"
  timeout          = 60
  memory_size      = 256
  
  environment {
    variables = {
      DYNAMODB_CUSTOMERS_TABLE = aws_dynamodb_table.customers.name
      DYNAMODB_ACCOUNTS_TABLE = aws_dynamodb_table.accounts.name
      DYNAMODB_ONBOARDING_TABLE = aws_dynamodb_table.onboarding_process.name
      SNS_TOPIC_ARN = aws_sns_topic.notifications.arn
      ENVIRONMENT = var.environment
    }
  }
}