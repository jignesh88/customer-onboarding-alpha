# Customer Onboarding Solution with AWS

This project implements a serverless customer onboarding system for a bank using AWS services and Terraform. The system automates the entire customer onboarding process, from initial application to account creation, with robust identity verification, biometric authentication, financial data verification, and AML/CTF compliance checks.

## Architecture Overview

```mermaid
flowchart TB
    %% Client Applications
    MobileApp["Mobile App"]
    WebApp["Web App"]
    
    %% AWS Services
    APIGateway["API Gateway\n/onboarding/*"]
    StepFunctions["Step Functions\nCustomer Onboarding Workflow"]
    
    %% Lambda Functions
    OrchestratorLambda["Lambda:\nOrchestrator"]
    IDVerificationLambda["Lambda:\nID Verification"]
    BiometricCheckLambda["Lambda:\nBiometric Check"]
    AMLScreeningLambda["Lambda:\nAML Screening"]
    AccountCreationLambda["Lambda:\nAccount Creation"]
    
    %% Storage
    S3["S3 Bucket\nDocuments"]
    DynamoDB["DynamoDB\nCustomer Data"]
    
    %% AWS AI Services
    Bedrock["Amazon\nBedrock"]
    Textract["Amazon\nTextract"]
    Rekognition["Amazon\nRekognition"]
    
    %% Notifications
    SNS["Amazon\nSNS/SES"]
    
    %% Third-party APIs
    DVS["DVS API"]
    CDR["CDR API"]
    NPP["NPP API"]
    BSB["BSB API"]
    FinancialAPIs["Financial APIs"]
    
    %% Connections
    MobileApp & WebApp --> APIGateway
    APIGateway --> OrchestratorLambda
    OrchestratorLambda --> StepFunctions
    OrchestratorLambda --> Bedrock
    OrchestratorLambda --> S3
    
    StepFunctions --> IDVerificationLambda
    StepFunctions --> BiometricCheckLambda
    StepFunctions --> AMLScreeningLambda
    StepFunctions --> AccountCreationLambda
    
    IDVerificationLambda --> Textract
    IDVerificationLambda --> DVS
    IDVerificationLambda --> S3
    IDVerificationLambda --> DynamoDB
    
    BiometricCheckLambda --> Rekognition
    BiometricCheckLambda --> S3
    BiometricCheckLambda --> DynamoDB
    
    AMLScreeningLambda --> DynamoDB
    
    AccountCreationLambda --> DynamoDB
    AccountCreationLambda --> SNS
    
    OrchestratorLambda --> CDR
    OrchestratorLambda --> NPP
    OrchestratorLambda --> BSB
    OrchestratorLambda --> FinancialAPIs
    
    %% Styling
    classDef aws fill:#E7E7E7,stroke:#FF9900,stroke-width:2px;
    classDef lambda fill:#E7E7E7,stroke:#009900,stroke-width:2px;
    classDef storage fill:#E7E7E7,stroke:#3F8624,stroke-width:2px;
    classDef apiGateway fill:#E7E7E7,stroke:#4D27AA,stroke-width:2px;
    classDef external fill:#E7E7E7,stroke:#333333,stroke-width:2px;
    classDef client fill:#E1E1E1,stroke:#000000,stroke-width:2px;
    
    class MobileApp,WebApp client;
    class APIGateway apiGateway;
    class OrchestratorLambda,IDVerificationLambda,BiometricCheckLambda,AMLScreeningLambda,AccountCreationLambda lambda;
    class StepFunctions,Bedrock,Textract,Rekognition,SNS aws;
    class S3,DynamoDB storage;
    class DVS,CDR,NPP,BSB,FinancialAPIs external;
```

## Components

### Core AWS Resources
- **API Gateway**: HTTP API serving as the entry point for all onboarding operations
- **Step Functions**: State machine orchestrating the end-to-end onboarding workflow
- **Lambda Functions**: Serverless functions processing each step of the onboarding process
- **DynamoDB**: NoSQL database storing customer, account, and onboarding process data
- **S3**: Object storage for identity documents and selfie images
- **Bedrock**: AI service for generating personalized messages and recommendations
- **Textract**: Document analysis for extracting text from ID documents
- **Rekognition**: Facial recognition for biometric verification
- **SNS/SES**: Notification services for alerts and customer communications

### Lambda Functions
- **Orchestrator**: Central function handling API requests and orchestrating the workflow
- **ID Verification**: Processes and verifies government-issued ID documents
- **Biometric Check**: Performs facial recognition and liveness detection
- **AML Screening**: Conducts anti-money laundering and counter-terrorism financing checks
- **Account Creation**: Creates the bank account and sends welcome notifications

### Third-Party API Integrations
- **Document Verification Service (DVS)**: Validates ID documents against government records
- **Consumer Data Right (CDR) API**: Accesses financial data with customer consent
- **New Payments Platform (NPP) API**: Verifies payment capabilities
- **BSB Lookup API**: Validates bank state branch codes
- **Financial Data Aggregators**: Yodlee, Illion BankStatements, and Basiq for financial verification

## Getting Started

### Prerequisites
- AWS Account with appropriate permissions
- Terraform (version 1.2.0 or higher)
- AWS CLI configured with appropriate credentials
- Third-party API access credentials

### Deployment

1. Clone this repository:
   ```
   git clone https://github.com/jignesh88/customer-onboarding-alpha.git
   cd customer-onboarding-alpha
   ```

2. Create a `terraform.tfvars` file with your specific settings:
   ```
   aws_region         = "ap-southeast-2"
   project_prefix     = "your-bank-onboarding"
   environment        = "dev"
   notification_email = "admin@your-bank.com"
   # Add third-party API keys (or use AWS Secrets Manager)
   ```

3. Package the Lambda functions before deployment:
   ```
   # Create zip files for each Lambda function
   mkdir -p lambda
   cd lambda/orchestrator
   npm install
   zip -r ../../lambda/orchestrator.zip .
   cd ../../lambda/id_verification
   # Repeat for other Lambda functions
   ```

4. Initialize and apply Terraform:
   ```
   terraform init
   terraform plan
   terraform apply
   ```

5. Note the outputs, including the API Gateway endpoint URL:
   ```
   API Endpoint: https://xxx.execute-api.ap-southeast-2.amazonaws.com/dev
   ```

## Onboarding Workflow

1. **Initiate Onboarding**: The customer starts the process through the bank's app or website.

2. **Personal Information Collection**: Basic details like name, address, date of birth are collected.

3. **Identity Verification**: Customer uploads an ID document, which is verified using Amazon Textract and a Document Verification Service.

4. **Biometric Authentication**: Customer takes a selfie, which is compared with the ID photo using Amazon Rekognition.

5. **Financial Data Verification**: With the customer's consent, financial data is collected and verified using CDR and other financial APIs.

6. **AML/CTF Screening**: Customer is screened against watchlists and sanctions lists.

7. **Account Creation**: Once all verifications pass, a bank account is created and the customer is notified.

## API Endpoints

- `POST /onboarding/init`: Start a new onboarding process
- `POST /onboarding/details`: Submit customer personal details
- `POST /onboarding/id`: Upload ID document
- `POST /onboarding/selfie`: Upload selfie for biometric verification
- `POST /onboarding/cdr-consent`: Provide consent for financial data access

## Security and Compliance

This implementation is designed to help meet regulatory requirements including:

- Know Your Customer (KYC)
- Anti-Money Laundering (AML)
- Counter-Terrorism Financing (CTF)
- Consumer Data Right (CDR) compliance
- Banking regulations specific to the operating jurisdiction

## License

This project is licensed under the MIT License - see the LICENSE file for details.
