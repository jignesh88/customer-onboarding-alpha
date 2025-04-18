# Deployment Guide

This document provides detailed instructions for deploying the Bank Customer Onboarding System to AWS using Terraform.

## Prerequisites

Before beginning deployment, ensure you have:

1. **AWS Account** with appropriate permissions to create all required resources
2. **Terraform** installed (version 1.2.0 or higher)
3. **AWS CLI** installed and configured with appropriate credentials
4. **Third-party API credentials** for each integration:
   - Document Verification Service (DVS)
   - Consumer Data Right (CDR)
   - New Payments Platform (NPP)
   - BSB Lookup
   - Yodlee, Illion, and Basiq financial services

## Deployment Steps

### 1. Prepare Terraform Variables

Create a `terraform.tfvars` file with your specific configuration:

```hcl
aws_region         = "ap-southeast-2"  # Choose your preferred region
project_prefix     = "your-bank-name"   # Used to prefix all resources
environment        = "dev"              # dev, test, or prod
notification_email = "admin@your-bank.com"

# Third-party API configurations (or use AWS Secrets Manager)
dvs_api_endpoint   = "https://api.dvs.gov.au/verify"
dvs_api_key        = "your-dvs-api-key"
cdr_api_endpoint   = "https://api.cdr.gov.au/banking"
cdr_api_key        = "your-cdr-api-key"
# ... Additional API configurations
```

### 2. Prepare Lambda Function Code

Each Lambda function should be packaged as a ZIP file before deployment:

```bash
# Create lambda directory if it doesn't exist
mkdir -p lambda

# For each Lambda function
cd lambda/orchestrator
npm install
zip -r ../../../lambda/orchestrator.zip .
cd ../../..

# Repeat for other Lambda functions
cd lambda/id_verification
npm install
zip -r ../../../lambda/id_verification.zip .
cd ../../..

# ... and so on for other functions
```

### 3. Initialize Terraform

```bash
terraform init
```

### 4. Plan the Deployment

```bash
terraform plan -out=onboarding.tfplan
```

Review the plan carefully to ensure it matches your expectations.

### 5. Apply the Configuration

```bash
terraform apply "onboarding.tfplan"
```

This will create all the required AWS resources according to the Terraform configuration.

### 6. Note the Outputs

After successful deployment, Terraform will output important information:

- API Gateway endpoint URL
- S3 bucket name
- DynamoDB table names
- Step Functions ARN
- SNS topic ARN

Save these outputs for future reference and for configuring your client applications.

## Post-Deployment Configuration

### API Gateway CORS Configuration

If your client applications will be hosted on different domains, you may need to configure CORS settings for the API Gateway:

```bash
aws apigatewayv2 update-api \
  --api-id <your-api-id> \
  --cors-configuration AllowOrigins="https://your-app-domain.com",AllowMethods="POST,GET,OPTIONS",AllowHeaders="content-type,authorization",MaxAge=300
```

### Create Test Users

For development and testing, you can create test customer records in DynamoDB:

```bash
aws dynamodb put-item \
  --table-name <your-customers-table-name> \
  --item '{
    "customer_id": {"S": "test-customer-001"},
    "name": {"S": "Test Customer"},
    "dob": {"S": "1990-01-01"},
    "address": {"S": "123 Test St, Sydney NSW 2000"},
    "email": {"S": "test@example.com"},
    "created_at": {"S": "'$(date -u +"%Y-%m-%dT%H:%M:%SZ")'"}
  }'
```

### Configure CloudWatch Alarms

Set up additional CloudWatch alarms for monitoring the system:

```bash
aws cloudwatch put-metric-alarm \
  --alarm-name "HighErrorRate-Onboarding-API" \
  --metric-name "5XXError" \
  --namespace "AWS/ApiGateway" \
  --statistic "Sum" \
  --period 300 \
  --threshold 5 \
  --comparison-operator "GreaterThanOrEqualToThreshold" \
  --evaluation-periods 1 \
  --dimensions "Name=ApiId,Value=<your-api-id>" \
  --alarm-actions "<your-sns-topic-arn>"
```

## Environment-Specific Considerations

### Development Environment

- Set Lambda environment variables to use simulated responses for third-party APIs
- Reduce costs by using smaller Lambda memory allocations
- Consider shorter retention periods for logs and data

### Production Environment

- Ensure all sensitive data is encrypted
- Implement WAF for API Gateway to protect against common attacks
- Configure more strict IAM permissions
- Implement enhanced logging and monitoring
- Set up automated backups for DynamoDB tables
- Deploy across multiple availability zones

## Troubleshooting

### Common Issues

1. **Lambda Deployment Package Size:**
   If you encounter issues with Lambda deployment package size limits, consider:
   - Removing development dependencies
   - Using Lambda Layers for shared libraries
   - Optimizing code and dependencies

2. **Step Functions Execution Issues:**
   - Check CloudWatch Logs for each Lambda function
   - Verify IAM permissions for Step Functions to invoke Lambda
   - Examine Step Functions execution history for failure points

3. **API Gateway Integration Problems:**
   - Verify Lambda proxy integration configuration
   - Check for correct CORS settings
   - Examine CloudWatch Logs for API Gateway

## Clean Up

To remove all deployed resources when they are no longer needed:

```bash
terraform destroy
```

**CAUTION**: This will delete all resources created by Terraform, including all data in DynamoDB tables and objects in S3 buckets. Make sure to back up any important data before running this command.
