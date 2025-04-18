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