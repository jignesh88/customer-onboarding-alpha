output "api_endpoint" {
  description = "API Gateway endpoint URL"
  value       = "${aws_apigatewayv2_api.onboarding_api.api_endpoint}/${aws_apigatewayv2_stage.onboarding_api_stage.name}"
}

output "s3_bucket_name" {
  description = "S3 bucket for storing onboarding documents"
  value       = aws_s3_bucket.onboarding_documents.id
}

output "dynamodb_customers_table" {
  description = "DynamoDB table for customer data"
  value       = aws_dynamodb_table.customers.name
}

output "dynamodb_accounts_table" {
  description = "DynamoDB table for account data"
  value       = aws_dynamodb_table.accounts.name
}

output "dynamodb_onboarding_table" {
  description = "DynamoDB table for onboarding process data"
  value       = aws_dynamodb_table.onboarding_process.name
}

output "step_function_arn" {
  description = "ARN of the Step Functions state machine"
  value       = aws_sfn_state_machine.customer_onboarding.arn
}

output "sns_topic_arn" {
  description = "ARN of the SNS topic for notifications"
  value       = aws_sns_topic.notifications.arn
}