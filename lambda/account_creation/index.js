const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');

// Initialize AWS services
const dynamoDB = new AWS.DynamoDB.DocumentClient();
const sns = new AWS.SNS();
const ses = new AWS.SES();

// Environment variables
const CUSTOMERS_TABLE = process.env.DYNAMODB_CUSTOMERS_TABLE;
const ACCOUNTS_TABLE = process.env.DYNAMODB_ACCOUNTS_TABLE;
const ONBOARDING_TABLE = process.env.DYNAMODB_ONBOARDING_TABLE;
const SNS_TOPIC_ARN = process.env.SNS_TOPIC_ARN;
const ENVIRONMENT = process.env.ENVIRONMENT;

exports.handler = async (event, context) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  try {
    const processId = event.process_id;
    
    if (!processId) {
      throw new Error('Missing process_id parameter');
    }
    
    // Get onboarding process data
    const processResult = await dynamoDB.get({
      TableName: ONBOARDING_TABLE,
      Key: { process_id: processId }
    }).promise();
    
    if (!processResult.Item) {
      throw new Error(`Onboarding process ${processId} not found`);
    }
    
    const process = processResult.Item;
    
    if (!process.customer_id) {
      throw new Error('No customer ID associated with this process');
    }
    
    // Get customer details
    const customerResult = await dynamoDB.get({
      TableName: CUSTOMERS_TABLE,
      Key: { customer_id: process.customer_id }
    }).promise();
    
    if (!customerResult.Item) {
      throw new Error(`Customer ${process.customer_id} not found`);
    }
    
    const customer = customerResult.Item;
    
    // Create bank account
    const accountDetails = await createBankAccount(customer, process);
    
    // Send notifications
    await sendAccountCreationNotifications(customer, accountDetails);
    
    // Update onboarding process with account details
    await dynamoDB.update({
      TableName: ONBOARDING_TABLE,
      Key: { process_id: processId },
      UpdateExpression: 'SET status = :status, account_id = :accountId, updated_at = :timestamp',
      ExpressionAttributeValues: {
        ':status': 'ACCOUNT_CREATED',
        ':accountId': accountDetails.account_id,
        ':timestamp': new Date().toISOString()
      }
    }).promise();
    
    return {
      process_id: processId,
      account: {
        created: true,
        account_id: accountDetails.account_id,
        account_number: accountDetails.account_number,
        bsb: accountDetails.bsb,
        account_type: accountDetails.account_type
      },
      status: 'ACCOUNT_CREATED'
    };
    
  } catch (error) {
    console.error('Error in account creation:', error);
    
    // Update process with error if possible
    if (event.process_id) {
      await updateProcessStatus(event.process_id, 'ACCOUNT_CREATION_ERROR', {
        error_message: error.message
      });
    }
    
    return {
      process_id: event.process_id,
      account: {
        created: false
      },
      reason: error.message
    };
  }
};

async function createBankAccount(customer, process) {
  try {
    // Generate account details
    const accountId = uuidv4();
    const accountNumber = generateAccountNumber();
    const bsb = '123-456'; // Example BSB, would come from configuration in real implementation
    
    // Determine account type based on financial data if available
    const accountType = determineAccountType(process);
    
    // Create account record in DynamoDB
    const accountItem = {
      account_id: accountId,
      customer_id: customer.customer_id,
      account_number: accountNumber,
      bsb: bsb,
      account_type: accountType,
      status: 'ACTIVE',
      balance: 0.00,
      currency: 'AUD',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    await dynamoDB.put({
      TableName: ACCOUNTS_TABLE,
      Item: accountItem
    }).promise();
    
    console.log(`Created account ${accountId} for customer ${customer.customer_id}`);
    
    return accountItem;
  } catch (error) {
    console.error('Error creating bank account:', error);
    throw new Error(`Failed to create bank account: ${error.message}`);
  }
}

function generateAccountNumber() {
  // Generate a random 9-digit account number
  // In a real implementation, you would use a more sophisticated algorithm
  // and check for uniqueness
  let accountNumber = '';
  for (let i = 0; i < 9; i++) {
    accountNumber += Math.floor(Math.random() * 10);
  }
  return accountNumber;
}

function determineAccountType(process) {
  // Default account type
  let accountType = 'EVERYDAY';
  
  // If financial data is available, customize the account type
  if (process.financial_data) {
    const financialData = process.financial_data;
    
    // Example logic based on financial data
    if (financialData.cdr_data && financialData.cdr_data.income > 150000) {
      accountType = 'PREMIUM';
    } else if (financialData.cdr_data && financialData.cdr_data.savings > 50000) {
      accountType = 'SAVINGS_PLUS';
    }
  }
  
  return accountType;
}

async function sendAccountCreationNotifications(customer, accountDetails) {
  try {
    // 1. Send SNS notification
    const snsMessage = {
      event: 'ACCOUNT_CREATED',
      customer_id: customer.customer_id,
      account_id: accountDetails.account_id,
      account_type: accountDetails.account_type,
      timestamp: new Date().toISOString(),
      environment: ENVIRONMENT
    };
    
    await sns.publish({
      TopicArn: SNS_TOPIC_ARN,
      Subject: `New Account Created - ${ENVIRONMENT}`,
      Message: JSON.stringify(snsMessage, null, 2)
    }).promise();
    
    // 2. Send email to customer if email is available
    if (customer.email) {
      const emailParams = {
        Destination: {
          ToAddresses: [customer.email]
        },
        Message: {
          Body: {
            Html: {
              Data: `
                <html>
                <head>
                  <style>
                    body { font-family: Arial, sans-serif; line-height: 1.6; }
                    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                    .header { background-color: #0052cc; color: white; padding: 20px; text-align: center; }
                    .content { padding: 20px; }
                    .footer { font-size: 12px; color: #666; text-align: center; margin-top: 20px; }
                  </style>
                </head>
                <body>
                  <div class="container">
                    <div class="header">
                      <h1>Your New Bank Account</h1>
                    </div>
                    <div class="content">
                      <p>Dear ${customer.name},</p>
                      <p>Congratulations! Your new bank account has been successfully created.</p>
                      <p>Here are your account details:</p>
                      <ul>
                        <li><strong>Account Type:</strong> ${accountDetails.account_type}</li>
                        <li><strong>BSB:</strong> ${accountDetails.bsb}</li>
                        <li><strong>Account Number:</strong> ${accountDetails.account_number}</li>
                      </ul>
                      <p>You can now access your account through our mobile app or online banking.</p>
                      <p>If you have any questions, please contact our customer service team.</p>
                      <p>Thank you for choosing to bank with us!</p>
                    </div>
                    <div class="footer">
                      <p>This is an automated email. Please do not reply to this message.</p>
                      <p>© 2025 Your Bank. All rights reserved.</p>
                    </div>
                  </div>
                </body>
                </html>
              `
            },
            Text: {
              Data: `
                Dear ${customer.name},
                
                Congratulations! Your new bank account has been successfully created.
                
                Here are your account details:
                Account Type: ${accountDetails.account_type}
                BSB: ${accountDetails.bsb}
                Account Number: ${accountDetails.account_number}
                
                You can now access your account through our mobile app or online banking.
                
                If you have any questions, please contact our customer service team.
                
                Thank you for choosing to bank with us!
              `
            }
          },
          Subject: {
            Data: 'Welcome to Your Bank - Your Account is Ready!'
          }
        },
        Source: 'notifications@yourbank.com'
      };
      
      await ses.sendEmail(emailParams).promise();
      console.log(`Sent account creation email to ${customer.email}`);
    }
    
    // 3. Send SMS if phone number is available (simplified example)
    if (customer.phone) {
      const smsParams = {
        Message: `Welcome to Your Bank! Your new ${accountDetails.account_type} account has been created. BSB: ${accountDetails.bsb}, Account: ${accountDetails.account_number}`,
        PhoneNumber: customer.phone
      };
      
      await sns.publish(smsParams).promise();
      console.log(`Sent account creation SMS to ${customer.phone}`);
    }
    
    return true;
  } catch (error) {
    console.error('Error sending account creation notifications:', error);
    // We'll still consider the account creation successful even if notifications fail
    return false;
  }
}

async function updateProcessStatus(processId, status, data) {
  // Prepare update expression and attribute values
  let updateExpression = 'SET status = :status, updated_at = :timestamp';
  const expressionAttributeValues = {
    ':status': status,
    ':timestamp': new Date().toISOString()
  };
  
  // Add any additional data to the update
  if (data) {
    Object.entries(data).forEach(([key, value], index) => {
      updateExpression += `, account_creation.${key} = :val${index}`;
      expressionAttributeValues[`:val${index}`] = value;
    });
  }
  
  // Update the process in DynamoDB
  await dynamoDB.update({
    TableName: ONBOARDING_TABLE,
    Key: { process_id: processId },
    UpdateExpression: updateExpression,
    ExpressionAttributeValues: expressionAttributeValues
  }).promise();
}