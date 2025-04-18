# --------------------------------------
# Step Function State Machine
# --------------------------------------
resource "aws_sfn_state_machine" "customer_onboarding" {
  name     = "${var.project_prefix}-onboarding-state-machine"
  role_arn = aws_iam_role.step_function_role.arn

  definition = templatefile("${path.module}/step_functions_definition.json", {
    OrchestratorLambdaArn = aws_lambda_function.orchestrator.arn,
    IdVerificationLambdaArn = aws_lambda_function.id_verification.arn,
    BiometricCheckLambdaArn = aws_lambda_function.biometric_check.arn,
    AmlScreeningLambdaArn = aws_lambda_function.aml_screening.arn,
    AccountCreationLambdaArn = aws_lambda_function.account_creation.arn
  })
}