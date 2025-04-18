const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');

// Initialize AWS services
const dynamoDB = new AWS.DynamoDB.DocumentClient();
const stepFunctions = new AWS.StepFunctions();
const bedrock = new AWS.BedrockRuntime();
const sns = new AWS.SNS();
const ses = new AWS.SES();

// Environment variables
const STEP_FUNCTION_ARN = process.env.STEP_FUNCTION_ARN;
const CUSTOMERS_TABLE = process.env.DYNAMODB_CUSTOMERS_TABLE;
const ONBOARDING_TABLE = process.env.DYNAMODB_ONBOARDING_TABLE;
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID;
const ENVIRONMENT = process.env.ENVIRONMENT;

// Third-party API client initialization
const cdrClient = require('./lib/cdr-client');
const basiqClient = require('./lib/basiq-client');
const illionClient = require('./lib/illion-client');
const yodleeClient = require('./lib/yodlee-client');
const bsbClient = require('./lib/bsb-client');
const nppClient = require('./lib/npp-client');

exports.handler = async (event, context) => {
  console.log('Event:', JSON.stringify(event, null, 2));

  try {
    // Handle different API Gateway routes
    if (event.routeKey) {
      return await handleApiGatewayEvent(event);
    }
    
    // Handle Step Function task actions
    if (event.action) {
      return await handleStepFunctionTask(event);
    }
    
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid request' })
    };
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};

async function handleApiGatewayEvent(event) {
  const routeKey = event.routeKey;
  const body = JSON.parse(event.body || '{}');
  
  switch (routeKey) {
    case 'POST /onboarding/init':
      return await initOnboarding(body);
      
    case 'POST /onboarding/details':
      return await storeCustomerDetails(body);
      
    case 'POST /onboarding/id':
      return await processIdDocument(body);
      
    case 'POST /onboarding/selfie':
      return await processSelfie(body);
      
    case 'POST /onboarding/cdr-consent':
      return await processCdrConsent(body);
      
    default:
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Route not found' })
      };
  }
}

async function handleStepFunctionTask(event) {
  const action = event.action;
  const processId = event.process_id;
  
  switch (action) {
    case 'COLLECT_DETAILS':
      return await collectPersonalDetails(processId);
      
    case 'FINANCIAL_VERIFICATION':
      return await performFinancialVerification(processId);
      
    case 'NOTIFY_FAILURE':
      return await notifyFailure(processId, event.reason);
      
    case 'MANUAL_REVIEW':
      return await triggerManualReview(processId);
      
    case 'COMPLETE_ONBOARDING':
      return await completeOnboarding(processId);
      
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

async function initOnboarding(data) {
  // Generate unique ID for the onboarding process
  const processId = uuidv4();
  
  // Generate welcome message with Bedrock
  const welcomeMessage = await generateWelcomeMessage();
  
  // Create initial record in DynamoDB
  const timestamp = new Date().toISOString();
  const item = {
    process_id: processId,
    status: 'INITIATED',
    created_at: timestamp,
    updated_at: timestamp,
    welcome_message: welcomeMessage,
    // Set TTL for 7 days
    expiry_time: Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60)
  };
  
  await dynamoDB.put({
    TableName: ONBOARDING_TABLE,
    Item: item
  }).promise();
  
  // Start Step Function state machine
  const params = {
    stateMachineArn: STEP_FUNCTION_ARN,
    input: JSON.stringify({ process_id: processId }),
    name: `onboarding-${processId}`
  };
  
  await stepFunctions.startExecution(params).promise();
  
  return {
    statusCode: 200,
    body: JSON.stringify({
      process_id: processId,
      welcome_message: welcomeMessage,
      status: 'INITIATED'
    })
  };
}

async function generateWelcomeMessage() {
  try {
    const prompt = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: "Generate a friendly welcome message for a new customer starting the bank account onboarding process. Keep it concise but warm and encouraging."
        }
      ]
    };
    
    const bedrockParams = {
      modelId: BEDROCK_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(prompt)
    };
    
    const response = await bedrock.invokeModel(bedrockParams).promise();
    const responseBody = JSON.parse(Buffer.from(response.body).toString());
    
    return responseBody.content[0].text;
  } catch (error) {
    console.error('Error generating welcome message:', error);
    return 'Welcome to our bank! We\'re excited to help you open your new account.';
  }
}

async function storeCustomerDetails(data) {
  const { process_id, customer_details } = data;
  
  if (!process_id || !customer_details) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing required fields' })
    };
  }
  
  // Validate customer details
  const requiredFields = ['name', 'dob', 'address'];
  for (const field of requiredFields) {
    if (!customer_details[field]) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: `Missing required field: ${field}` })
      };
    }
  }
  
  // Get current process state
  const processResult = await dynamoDB.get({
    TableName: ONBOARDING_TABLE,
    Key: { process_id }
  }).promise();
  
  if (!processResult.Item) {
    return {
      statusCode: 404,
      body: JSON.stringify({ error: 'Onboarding process not found' })
    };
  }
  
  // Create customer record
  const customerId = uuidv4();
  const customerItem = {
    customer_id: customerId,
    name: customer_details.name,
    dob: customer_details.dob,
    address: customer_details.address,
    email: customer_details.email,
    phone: customer_details.phone,
    created_at: new Date().toISOString()
  };
  
  await dynamoDB.put({
    TableName: CUSTOMERS_TABLE,
    Item: customerItem
  }).promise();
  
  // Update onboarding process with customer ID
  await dynamoDB.update({
    TableName: ONBOARDING_TABLE,
    Key: { process_id },
    UpdateExpression: 'SET customer_id = :customerId, customer_details = :details, status = :status, updated_at = :timestamp',
    ExpressionAttributeValues: {
      ':customerId': customerId,
      ':details': customer_details,
      ':status': 'DETAILS_COLLECTED',
      ':timestamp': new Date().toISOString()
    }
  }).promise();
  
  return {
    statusCode: 200,
    body: JSON.stringify({
      process_id,
      customer_id: customerId,
      status: 'DETAILS_COLLECTED'
    })
  };
}

async function processIdDocument(data) {
  const { process_id, document_data } = data;
  
  if (!process_id || !document_data) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing required fields' })
    };
  }
  
  // Update onboarding process with document data
  await dynamoDB.update({
    TableName: ONBOARDING_TABLE,
    Key: { process_id },
    UpdateExpression: 'SET id_document = :document, updated_at = :timestamp',
    ExpressionAttributeValues: {
      ':document': {
        type: document_data.type,
        upload_time: new Date().toISOString()
      },
      ':timestamp': new Date().toISOString()
    }
  }).promise();
  
  return {
    statusCode: 200,
    body: JSON.stringify({
      process_id,
      status: 'ID_DOCUMENT_UPLOADED'
    })
  };
}

async function processSelfie(data) {
  const { process_id, selfie_data } = data;
  
  if (!process_id || !selfie_data) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing required fields' })
    };
  }
  
  // Update onboarding process with selfie data
  await dynamoDB.update({
    TableName: ONBOARDING_TABLE,
    Key: { process_id },
    UpdateExpression: 'SET selfie = :selfie, updated_at = :timestamp',
    ExpressionAttributeValues: {
      ':selfie': {
        upload_time: new Date().toISOString()
      },
      ':timestamp': new Date().toISOString()
    }
  }).promise();
  
  return {
    statusCode: 200,
    body: JSON.stringify({
      process_id,
      status: 'SELFIE_UPLOADED'
    })
  };
}

async function processCdrConsent(data) {
  const { process_id, consent_granted } = data;
  
  if (!process_id || consent_granted === undefined) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing required fields' })
    };
  }
  
  if (!consent_granted) {
    // Update process to indicate consent was declined
    await dynamoDB.update({
      TableName: ONBOARDING_TABLE,
      Key: { process_id },
      UpdateExpression: 'SET cdr_consent = :consent, status = :status, updated_at = :timestamp',
      ExpressionAttributeValues: {
        ':consent': false,
        ':status': 'CDR_CONSENT_DECLINED',
        ':timestamp': new Date().toISOString()
      }
    }).promise();
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        process_id,
        status: 'CDR_CONSENT_DECLINED',
        message: 'Onboarding cannot proceed without financial data verification'
      })
    };
  }
  
  // Update process to indicate consent was granted
  await dynamoDB.update({
    TableName: ONBOARDING_TABLE,
    Key: { process_id },
    UpdateExpression: 'SET cdr_consent = :consent, updated_at = :timestamp',
    ExpressionAttributeValues: {
      ':consent': true,
      ':timestamp': new Date().toISOString()
    }
  }).promise();
  
  return {
    statusCode: 200,
    body: JSON.stringify({
      process_id,
      status: 'CDR_CONSENT_GRANTED'
    })
  };
}

async function collectPersonalDetails(processId) {
  // This function is called by the Step Function to retrieve collected details
  const result = await dynamoDB.get({
    TableName: ONBOARDING_TABLE,
    Key: { process_id: processId }
  }).promise();
  
  if (!result.Item) {
    throw new Error(`Onboarding process ${processId} not found`);
  }
  
  return {
    process_id: processId,
    customer_details: result.Item.customer_details || {},
    status: result.Item.status
  };
}

async function performFinancialVerification(processId) {
  // Get onboarding process data
  const processResult = await dynamoDB.get({
    TableName: ONBOARDING_TABLE,
    Key: { process_id: processId }
  }).promise();
  
  if (!processResult.Item) {
    throw new Error(`Onboarding process ${processId} not found`);
  }
  
  const process = processResult.Item;
  
  if (!process.cdr_consent) {
    return {
      process_id: processId,
      verification: {
        financial_verified: false
      },
      status: 'FINANCIAL_VERIFICATION_FAILED',
      reason: 'CDR consent not granted'
    };
  }
  
  try {
    // Get customer details
    const customerResult = await dynamoDB.get({
      TableName: CUSTOMERS_TABLE,
      Key: { customer_id: process.customer_id }
    }).promise();
    
    if (!customerResult.Item) {
      throw new Error(`Customer ${process.customer_id} not found`);
    }
    
    const customer = customerResult.Item;
    
    // Make calls to various financial services APIs
    // These would be implemented in the imported client libraries
    
    // 1. Fetch CDR data
    const cdrData = await cdrClient.fetchData(customer);
    
    // 2. Verify account with Basiq
    const basiqVerification = await basiqClient.verifyAccount(customer, cdrData);
    
    // 3. Get bank statements from Illion
    const bankStatements = await illionClient.getBankStatements(customer, cdrData);
    
    // 4. Aggregate data with Yodlee
    const enrichedData = await yodleeClient.aggregateData(customer, cdrData);
    
    // 5. Validate BSB
    const bsbValidation = await bsbClient.validateBSB(cdrData.bsb);
    
    // 6. Check NPP capability
    const nppStatus = await nppClient.checkPaymentCapability(cdrData.accountNumber, cdrData.bsb);
    
    // Store all verification results
    const financialData = {
      cdr_data: cdrData,
      basiq_verification: basiqVerification,
      bank_statements: bankStatements.summary,
      enriched_data: enrichedData.summary,
      bsb_validation: bsbValidation,
      npp_status: nppStatus,
      verified: true,
      verification_time: new Date().toISOString()
    };
    
    await dynamoDB.update({
      TableName: ONBOARDING_TABLE,
      Key: { process_id: processId },
      UpdateExpression: 'SET financial_data = :financialData, updated_at = :timestamp',
      ExpressionAttributeValues: {
        ':financialData': financialData,
        ':timestamp': new Date().toISOString()
      }
    }).promise();
    
    return {
      process_id: processId,
      verification: {
        financial_verified: true
      },
      status: 'FINANCIAL_VERIFICATION_COMPLETE'
    };
  } catch (error) {
    console.error('Financial verification error:', error);
    
    // Update process status with error
    await dynamoDB.update({
      TableName: ONBOARDING_TABLE,
      Key: { process_id: processId },
      UpdateExpression: 'SET status = :status, verification_error = :error, updated_at = :timestamp',
      ExpressionAttributeValues: {
        ':status': 'FINANCIAL_VERIFICATION_FAILED',
        ':error': error.message,
        ':timestamp': new Date().toISOString()
      }
    }).promise();
    
    return {
      process_id: processId,
      verification: {
        financial_verified: false
      },
      status: 'FINANCIAL_VERIFICATION_FAILED',
      reason: error.message
    };
  }
}

async function notifyFailure(processId, reason) {
  try {
    // Get process details
    const processResult = await dynamoDB.get({
      TableName: ONBOARDING_TABLE,
      Key: { process_id: processId }
    }).promise();
    
    if (!processResult.Item) {
      throw new Error(`Onboarding process ${processId} not found`);
    }
    
    const process = processResult.Item;
    
    // Update process status
    await dynamoDB.update({
      TableName: ONBOARDING_TABLE,
      Key: { process_id: processId },
      UpdateExpression: 'SET status = :status, failure_reason = :reason, updated_at = :timestamp',
      ExpressionAttributeValues: {
        ':status': 'FAILED',
        ':reason': reason,
        ':timestamp': new Date().toISOString()
      }
    }).promise();
    
    // Send notification via SNS
    const message = `Onboarding process ${processId} failed: ${reason}`;
    
    await sns.publish({
      TopicArn: process.env.SNS_TOPIC_ARN,
      Subject: `Onboarding Failure - ${ENVIRONMENT}`,
      Message: message
    }).promise();
    
    // If customer email is available, notify them
    if (process.customer_details && process.customer_details.email) {
      await ses.sendEmail({
        Destination: {
          ToAddresses: [process.customer_details.email]
        },
        Message: {
          Body: {
            Text: {
              Data: `We're sorry, but we encountered an issue with your account application. Please contact our support team for assistance.`
            }
          },
          Subject: {
            Data: 'Important: Your Account Application Status'
          }
        },
        Source: 'onboarding@yourbank.com'
      }).promise();
    }
    
    return {
      process_id: processId,
      status: 'FAILED',
      reason
    };
  } catch (error) {
    console.error('Error notifying failure:', error);
    throw error;
  }
}

async function triggerManualReview(processId) {
  try {
    // Update process status
    await dynamoDB.update({
      TableName: ONBOARDING_TABLE,
      Key: { process_id: processId },
      UpdateExpression: 'SET status = :status, manual_review_timestamp = :timestamp, updated_at = :timestamp',
      ExpressionAttributeValues: {
        ':status': 'MANUAL_REVIEW',
        ':timestamp': new Date().toISOString()
      }
    }).promise();
    
    // Send notification to review team
    await sns.publish({
      TopicArn: process.env.SNS_TOPIC_ARN,
      Subject: `Manual Review Required - ${ENVIRONMENT}`,
      Message: `Onboarding process ${processId} requires manual review. Please check the admin dashboard.`
    }).promise();
    
    return {
      process_id: processId,
      status: 'MANUAL_REVIEW'
    };
  } catch (error) {
    console.error('Error triggering manual review:', error);
    throw error;
  }
}

async function completeOnboarding(processId) {
  try {
    // Get process details
    const processResult = await dynamoDB.get({
      TableName: ONBOARDING_TABLE,
      Key: { process_id: processId }
    }).promise();
    
    if (!processResult.Item) {
      throw new Error(`Onboarding process ${processId} not found`);
    }
    
    const process = processResult.Item;
    
    // Update status
    await dynamoDB.update({
      TableName: ONBOARDING_TABLE,
      Key: { process_id: processId },
      UpdateExpression: 'SET status = :status, completed_at = :timestamp, updated_at = :timestamp',
      ExpressionAttributeValues: {
        ':status': 'COMPLETED',
        ':timestamp': new Date().toISOString()
      }
    }).promise();
    
    // Generate personalized product recommendations
    const recommendations = await generateRecommendations(process);
    
    return {
      process_id: processId,
      status: 'COMPLETED',
      recommendations
    };
  } catch (error) {
    console.error('Error completing onboarding:', error);
    throw error;
  }
}

async function generateRecommendations(processData) {
  try {
    // Extract relevant data for recommendation generation
    const customerDetails = processData.customer_details || {};
    const financialData = processData.financial_data || {};
    
    // Use Bedrock to generate personalized recommendations
    const prompt = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: `Generate personalized banking product recommendations based on the following customer profile:\n\nName: ${customerDetails.name || 'N/A'}\nAge: ${calculateAge(customerDetails.dob) || 'N/A'}\nIncome: ${financialData.cdr_data?.income || 'Unknown'}\nSpending Pattern: ${financialData.enriched_data?.spending_pattern || 'Unknown'}\nSavings: ${financialData.cdr_data?.savings || 'Unknown'}\n\nProvide 2-3 specific product recommendations with brief explanations why they would be suitable.`
        }
      ]
    };
    
    const bedrockParams = {
      modelId: BEDROCK_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(prompt)
    };
    
    const response = await bedrock.invokeModel(bedrockParams).promise();
    const responseBody = JSON.parse(Buffer.from(response.body).toString());
    
    return {
      generated_recommendations: responseBody.content[0].text,
      generation_time: new Date().toISOString()
    };
  } catch (error) {
    console.error('Error generating recommendations:', error);
    return {
      error: 'Failed to generate recommendations',
      recommendations: [
        'Everyday Banking Account',
        'Savings Account',
        'Debit Card'
      ]
    };
  }
}

function calculateAge(dob) {
  if (!dob) return null;
  
  const birthDate = new Date(dob);
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  
  return age;
}