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

# --------------------------------------
# API Gateway
# --------------------------------------
resource "aws_apigatewayv2_api" "onboarding_api" {
  name          = "${var.project_prefix}-onboarding-api"
  protocol_type = "HTTP"
  cors_configuration {
    allow_origins = ["*"] # Restrict in production
    allow_methods = ["POST", "GET", "OPTIONS"]
    allow_headers = ["content-type", "authorization"]
    max_age       = 300
  }
}

resource "aws_apigatewayv2_stage" "onboarding_api_stage" {
  api_id      = aws_apigatewayv2_api.onboarding_api.id
  name        = var.environment
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_gw_logs.arn
    format          = jsonencode({
      requestId               = "$context.requestId"
      sourceIp                = "$context.identity.sourceIp"
      requestTime             = "$context.requestTime"
      protocol                = "$context.protocol"
      httpMethod              = "$context.httpMethod"
      resourcePath            = "$context.resourcePath"
      routeKey                = "$context.routeKey"
      status                  = "$context.status"
      responseLength          = "$context.responseLength"
      integrationErrorMessage = "$context.integrationErrorMessage"
    })
  }
}

# Log group for API Gateway
resource "aws_cloudwatch_log_group" "api_gw_logs" {
  name              = "/aws/apigateway/${var.project_prefix}-onboarding-api"
  retention_in_days = 30
}

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

# --------------------------------------
# IAM Roles and Policies
# --------------------------------------
resource "aws_iam_role" "lambda_role" {
  name = "${var.project_prefix}-lambda-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_policy" "lambda_policy" {
  name        = "${var.project_prefix}-lambda-policy"
  description = "Policy for customer onboarding lambdas"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:Query",
          "dynamodb:Scan"
        ]
        Resource = [
          aws_dynamodb_table.customers.arn,
          aws_dynamodb_table.accounts.arn,
          aws_dynamodb_table.onboarding_process.arn,
          "${aws_dynamodb_table.customers.arn}/index/*",
          "${aws_dynamodb_table.accounts.arn}/index/*",
          "${aws_dynamodb_table.onboarding_process.arn}/index/*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.onboarding_documents.arn,
          "${aws_s3_bucket.onboarding_documents.arn}/*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "states:StartExecution",
          "states:DescribeExecution"
        ]
        Resource = [
          aws_sfn_state_machine.customer_onboarding.arn
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "bedrock:InvokeModel"
        ]
        Resource = ["*"]
      },
      {
        Effect = "Allow"
        Action = [
          "textract:AnalyzeDocument",
          "textract:DetectDocumentText"
        ]
        Resource = ["*"]
      },
      {
        Effect = "Allow"
        Action = [
          "rekognition:CompareFaces"
        ]
        Resource = ["*"]
      },
      {
        Effect = "Allow"
        Action = [
          "sns:Publish"
        ]
        Resource = [
          aws_sns_topic.notifications.arn
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "ses:SendEmail",
          "ses:SendRawEmail"
        ]
        Resource = ["*"]
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_policy_attachment" {
  role       = aws_iam_role.lambda_role.name
  policy_arn = aws_iam_policy.lambda_policy.arn
}

# --------------------------------------
# Step Function
# --------------------------------------
resource "aws_iam_role" "step_function_role" {
  name = "${var.project_prefix}-step-function-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "states.amazonaws.com"
        }
      },
    ]
  })
}

resource "aws_iam_policy" "step_function_policy" {
  name        = "${var.project_prefix}-step-function-policy"
  description = "Policy for customer onboarding step function"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "lambda:InvokeFunction"
        ]
        Resource = [
          aws_lambda_function.orchestrator.arn,
          aws_lambda_function.id_verification.arn,
          aws_lambda_function.biometric_check.arn,
          aws_lambda_function.aml_screening.arn,
          aws_lambda_function.account_creation.arn
        ]
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "step_function_policy_attachment" {
  role       = aws_iam_role.step_function_role.name
  policy_arn = aws_iam_policy.step_function_policy.arn
}

resource "aws_sfn_state_machine" "customer_onboarding" {
  name     = "${var.project_prefix}-onboarding-state-machine"
  role_arn = aws_iam_role.step_function_role.arn

  definition = <<EOF
{
  "Comment": "Customer Onboarding State Machine",
  "StartAt": "Collect Personal Details",
  "States": {
    "Collect Personal Details": {
      "Type": "Task",
      "Resource": "${aws_lambda_function.orchestrator.arn}",
      "Parameters": {
        "action": "COLLECT_DETAILS",
        "process_id.$": "$.process_id"
      },
      "Next": "ID Verification"
    },
    "ID Verification": {
      "Type": "Task",
      "Resource": "${aws_lambda_function.id_verification.arn}",
      "Parameters": {
        "process_id.$": "$.process_id"
      },
      "Next": "ID Verification Check"
    },
    "ID Verification Check": {
      "Type": "Choice",
      "Choices": [
        {
          "Variable": "$.verification.id_verified",
          "BooleanEquals": true,
          "Next": "Biometric Authentication"
        }
      ],
      "Default": "ID Verification Failed"
    },
    "ID Verification Failed": {
      "Type": "Task",
      "Resource": "${aws_lambda_function.orchestrator.arn}",
      "Parameters": {
        "action": "NOTIFY_FAILURE",
        "process_id.$": "$.process_id",
        "reason": "ID verification failed"
      },
      "End": true
    },
    "Biometric Authentication": {
      "Type": "Task",
      "Resource": "${aws_lambda_function.biometric_check.arn}",
      "Parameters": {
        "process_id.$": "$.process_id"
      },
      "Next": "Biometric Check"
    },
    "Biometric Check": {
      "Type": "Choice",
      "Choices": [
        {
          "Variable": "$.verification.biometric_verified",
          "BooleanEquals": true,
          "Next": "Financial Data Verification"
        }
      ],
      "Default": "Biometric Verification Failed"
    },
    "Biometric Verification Failed": {
      "Type": "Task",
      "Resource": "${aws_lambda_function.orchestrator.arn}",
      "Parameters": {
        "action": "NOTIFY_FAILURE",
        "process_id.$": "$.process_id",
        "reason": "Biometric verification failed"
      },
      "End": true
    },
    "Financial Data Verification": {
      "Type": "Task",
      "Resource": "${aws_lambda_function.orchestrator.arn}",
      "Parameters": {
        "action": "FINANCIAL_VERIFICATION",
        "process_id.$": "$.process_id"
      },
      "Next": "Financial Check"
    },
    "Financial Check": {
      "Type": "Choice",
      "Choices": [
        {
          "Variable": "$.verification.financial_verified",
          "BooleanEquals": true,
          "Next": "AML Screening"
        }
      ],
      "Default": "Financial Verification Failed"
    },
    "Financial Verification Failed": {
      "Type": "Task",
      "Resource": "${aws_lambda_function.orchestrator.arn}",
      "Parameters": {
        "action": "NOTIFY_FAILURE",
        "process_id.$": "$.process_id",
        "reason": "Financial verification failed"
      },
      "End": true
    },
    "AML Screening": {
      "Type": "Task",
      "Resource": "${aws_lambda_function.aml_screening.arn}",
      "Parameters": {
        "process_id.$": "$.process_id"
      },
      "Next": "AML Check"
    },
    "AML Check": {
      "Type": "Choice",
      "Choices": [
        {
          "Variable": "$.verification.aml_passed",
          "BooleanEquals": true,
          "Next": "Account Creation"
        },
        {
          "Variable": "$.verification.manual_review_required",
          "BooleanEquals": true,
          "Next": "Manual Review"
        }
      ],
      "Default": "AML Screening Failed"
    },
    "AML Screening Failed": {
      "Type": "Task",
      "Resource": "${aws_lambda_function.orchestrator.arn}",
      "Parameters": {
        "action": "NOTIFY_FAILURE",
        "process_id.$": "$.process_id",
        "reason": "AML screening failed"
      },
      "End": true
    },
    "Manual Review": {
      "Type": "Task",
      "Resource": "${aws_lambda_function.orchestrator.arn}",
      "Parameters": {
        "action": "MANUAL_REVIEW",
        "process_id.$": "$.process_id"
      },
      "End": true
    },
    "Account Creation": {
      "Type": "Task",
      "Resource": "${aws_lambda_function.account_creation.arn}",
      "Parameters": {
        "process_id.$": "$.process_id"
      },
      "Next": "Account Creation Check"
    },
    "Account Creation Check": {
      "Type": "Choice",
      "Choices": [
        {
          "Variable": "$.account.created",
          "BooleanEquals": true,
          "Next": "Onboarding Complete"
        }
      ],
      "Default": "Account Creation Failed"
    },
    "Account Creation Failed": {
      "Type": "Task",
      "Resource": "${aws_lambda_function.orchestrator.arn}",
      "Parameters": {
        "action": "NOTIFY_FAILURE",
        "process_id.$": "$.process_id",
        "reason": "Account creation failed"
      },
      "End": true
    },
    "Onboarding Complete": {
      "Type": "Task",
      "Resource": "${aws_lambda_function.orchestrator.arn}",
      "Parameters": {
        "action": "COMPLETE_ONBOARDING",
        "process_id.$": "$.process_id"
      },
      "End": true
    }
  }
}
EOF
}

# --------------------------------------
# API Gateway Routes and Integrations
# --------------------------------------
resource "aws_apigatewayv2_integration" "orchestrator_integration" {
  api_id           = aws_apigatewayv2_api.onboarding_api.id
  integration_type = "AWS_PROXY"
  
  integration_uri    = aws_lambda_function.orchestrator.invoke_arn
  integration_method = "POST"
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "init_onboarding_route" {
  api_id    = aws_apigatewayv2_api.onboarding_api.id
  route_key = "POST /onboarding/init"
  
  target = "integrations/${aws_apigatewayv2_integration.orchestrator_integration.id}"
}

resource "aws_apigatewayv2_route" "details_route" {
  api_id    = aws_apigatewayv2_api.onboarding_api.id
  route_key = "POST /onboarding/details"
  
  target = "integrations/${aws_apigatewayv2_integration.orchestrator_integration.id}"
}

resource "aws_apigatewayv2_route" "id_route" {
  api_id    = aws_apigatewayv2_api.onboarding_api.id
  route_key = "POST /onboarding/id"
  
  target = "integrations/${aws_apigatewayv2_integration.orchestrator_integration.id}"
}

resource "aws_apigatewayv2_route" "selfie_route" {
  api_id    = aws_apigatewayv2_api.onboarding_api.id
  route_key = "POST /onboarding/selfie"
  
  target = "integrations/${aws_apigatewayv2_integration.orchestrator_integration.id}"
}

resource "aws_apigatewayv2_route" "cdr_consent_route" {
  api_id    = aws_apigatewayv2_api.onboarding_api.id
  route_key = "POST /onboarding/cdr-consent"
  
  target = "integrations/${aws_apigatewayv2_integration.orchestrator_integration.id}"
}

resource "aws_lambda_permission" "api_gw_orchestrator" {
  statement_id  = "AllowExecutionFromAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.orchestrator.function_name
  principal     = "apigateway.amazonaws.com"
  
  source_arn = "${aws_apigatewayv2_api.onboarding_api.execution_arn}/*/*"
}

# --------------------------------------
# SNS for Notifications
# --------------------------------------
resource "aws_sns_topic" "notifications" {
  name = "${var.project_prefix}-notifications"
}

resource "aws_sns_topic_subscription" "email_subscription" {
  topic_arn = aws_sns_topic.notifications.arn
  protocol  = "email"
  endpoint  = var.notification_email
}

# --------------------------------------
# SES Configuration
# --------------------------------------
resource "aws_ses_email_identity" "notification_email" {
  email = var.notification_email
}

# --------------------------------------
# CloudWatch Alarm for Failed Onboarding
# --------------------------------------
resource "aws_cloudwatch_metric_alarm" "failed_onboarding_alarm" {
  alarm_name          = "${var.project_prefix}-failed-onboarding"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = "1"
  metric_name         = "FailedOnboardingCount"
  namespace           = "CustomerOnboarding"
  period              = "300"
  statistic           = "Sum"
  threshold           = "5"
  alarm_description   = "This alarm monitors failed customer onboarding attempts"
  
  alarm_actions = [aws_sns_topic.notifications.arn]
  
  dimensions = {
    Environment = var.environment
  }
}