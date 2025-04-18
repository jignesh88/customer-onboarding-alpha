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