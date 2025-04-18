/**
 * Illion API Client
 * 
 * This client handles interactions with the Illion API for retrieving
 * bank statements and financial data.
 */

const axios = require('axios');
const AWS = require('aws-sdk');
const secretsManager = new AWS.SecretsManager();

// Environment variables
const ILLION_API_URL = process.env.ILLION_API_URL || 'https://api.illion.com.au';
const ILLION_API_KEY_SECRET = process.env.ILLION_API_KEY_SECRET;
const ENVIRONMENT = process.env.ENVIRONMENT;

// Cache for access token
let tokenCache = {
  token: null,
  expiresAt: 0
};

/**
 * Get an access token for Illion API
 * @returns {Promise<string>} The access token
 */
async function getAccessToken() {
  // Check if we have a valid cached token
  const now = Date.now();
  if (tokenCache.token && tokenCache.expiresAt > now) {
    return tokenCache.token;
  }

  try {
    // Retrieve API credentials from AWS Secrets Manager
    const secretData = await secretsManager.getSecretValue({
      SecretId: ILLION_API_KEY_SECRET
    }).promise();
    
    const secret = JSON.parse(secretData.SecretString);
    const clientId = secret.clientId;
    const clientSecret = secret.clientSecret;

    // Request new token
    const tokenResponse = await axios.post(`${ILLION_API_URL}/oauth/token`, {
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'bankstatements'
    }, {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    // Cache the token
    tokenCache.token = tokenResponse.data.access_token;
    tokenCache.expiresAt = now + (tokenResponse.data.expires_in * 1000);

    return tokenCache.token;
  } catch (error) {
    console.error('Error getting Illion access token:', error);
    throw new Error(`Failed to get Illion access token: ${error.message}`);
  }
}

/**
 * Create a session for bank statement retrieval
 * @param {Object} customer - Customer information
 * @returns {Promise<string>} Session ID
 */
async function createSession(customer) {
  try {
    const token = await getAccessToken();
    
    // Create session
    const sessionResponse = await axios.post(`${ILLION_API_URL}/bankstatements/v1/sessions`, {
      reference: customer.customer_id,
      firstName: customer.name.split(' ')[0],
      lastName: customer.name.split(' ').slice(1).join(' '),
      email: customer.email,
      mobile: customer.phone,
      callbackUrl: process.env.ILLION_CALLBACK_URL || 'https://api.yourbank.com/callbacks/illion'
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    
    return sessionResponse.data.sessionId;
  } catch (error) {
    console.error('Error creating Illion session:', error);
    
    // For development, return a mock session ID
    if (ENVIRONMENT === 'dev' || ENVIRONMENT === 'test') {
      return `mock-session-${Date.now()}`;
    }
    
    throw new Error(`Failed to create Illion session: ${error.message}`);
  }
}

/**
 * Submit bank account details for statement retrieval
 * @param {string} sessionId - Illion session ID
 * @param {Object} cdrData - CDR data with account information
 * @returns {Promise<string>} Job ID
 */
async function submitBankDetails(sessionId, cdrData) {
  try {
    const token = await getAccessToken();
    
    // Extract institution from BSB
    const institution = getBankFromBSB(cdrData.bsb);
    
    // Submit bank details
    const submitResponse = await axios.post(`${ILLION_API_URL}/bankstatements/v1/sessions/${sessionId}/submit`, {
      institution: institution,
      loginId: cdrData.accountNumber,
      password: 'dummy-password-for-testing', // In real implementation, this would be handled differently
      accountDetails: {
        bsb: cdrData.bsb,
        accountNumber: cdrData.accountNumber
      }
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    
    return submitResponse.data.jobId;
  } catch (error) {
    console.error('Error submitting bank details to Illion:', error);
    
    // For development, return a mock job ID
    if (ENVIRONMENT === 'dev' || ENVIRONMENT === 'test') {
      return `mock-job-${Date.now()}`;
    }
    
    throw new Error(`Failed to submit bank details to Illion: ${error.message}`);
  }
}

/**
 * Get bank institution code from BSB
 * @param {string} bsb - BSB number
 * @returns {string} Bank institution code
 */
function getBankFromBSB(bsb) {
  // This is a simplified mapping - in a real implementation, 
  // you would have a more comprehensive mapping or API lookup
  const bsbPrefix = bsb.substring(0, 3);
  
  const bsbMapping = {
    '062': 'CBA', // Commonwealth Bank
    '032': 'WBC', // Westpac
    '013': 'ANZ', // ANZ
    '082': 'NAB', // NAB
    '633': 'BEN', // Bendigo Bank
    '484': 'MEB', // ME Bank
    '942': 'ING', // ING
    '802': 'MCQ', // Macquarie Bank
    '182': 'STG', // St. George Bank
    '733': 'SUN'  // Suncorp Bank
  };
  
  return bsbMapping[bsbPrefix] || 'CBA'; // Default to CBA if not found
}

/**
 * Check job status and retrieve bank statements
 * @param {string} jobId - Illion job ID
 * @returns {Promise<Object>} Bank statements and analysis
 */
async function getJobResults(jobId) {
  try {
    const token = await getAccessToken();
    
    // Check job status
    const statusResponse = await axios.get(`${ILLION_API_URL}/bankstatements/v1/jobs/${jobId}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    
    const status = statusResponse.data.status;
    
    if (status !== 'COMPLETED') {
      throw new Error(`Job not completed. Current status: ${status}`);
    }
    
    // Get bank statements
    const statementsResponse = await axios.get(`${ILLION_API_URL}/bankstatements/v1/jobs/${jobId}/statements`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    
    // Get financial analysis
    const analysisResponse = await axios.get(`${ILLION_API_URL}/bankstatements/v1/jobs/${jobId}/analysis`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    
    return {
      statements: statementsResponse.data.statements,
      analysis: analysisResponse.data,
      retrievalTimestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error('Error retrieving Illion job results:', error);
    
    // For non-dev environments, propagate the error
    if (ENVIRONMENT !== 'dev' && ENVIRONMENT !== 'test') {
      throw new Error(`Failed to retrieve Illion job results: ${error.message}`);
    }
    
    // For dev/test, return mock data
    return getMockBankStatements();
  }
}

/**
 * Get bank statements from Illion
 * @param {Object} customer - Customer information
 * @param {Object} cdrData - CDR data with account information
 * @returns {Promise<Object>} Bank statements and analysis
 */
async function getBankStatements(customer, cdrData) {
  try {
    // For development/testing environments, return mock data
    if (ENVIRONMENT === 'dev' || ENVIRONMENT === 'test') {
      return getMockBankStatements();
    }
    
    // Create session
    const sessionId = await createSession(customer);
    
    // Submit bank details
    const jobId = await submitBankDetails(sessionId, cdrData);
    
    // Poll for job completion (in a real implementation, this would use a callback)
    let attempts = 0;
    const maxAttempts = 10;
    const delay = 5000; // 5 seconds
    
    while (attempts < maxAttempts) {
      try {
        // Try to get results
        const results = await getJobResults(jobId);
        return {
          sessionId,
          jobId,
          ...results,
          summary: generateStatementSummary(results)
        };
      } catch (error) {
        if (error.message.includes('Job not completed')) {
          // Wait and retry
          await new Promise(resolve => setTimeout(resolve, delay));
          attempts++;
        } else {
          throw error;
        }
      }
    }
    
    throw new Error('Timed out waiting for bank statement retrieval');
  } catch (error) {
    console.error('Error getting bank statements from Illion:', error);
    
    // For non-dev environments, propagate the error
    if (ENVIRONMENT !== 'dev' && ENVIRONMENT !== 'test') {
      throw new Error(`Failed to get bank statements from Illion: ${error.message}`);
    }
    
    // For dev/test, return mock data even on error
    return getMockBankStatements();
  }
}

/**
 * Generate a summary of bank statements
 * @param {Object} results - Bank statement results
 * @returns {Object} Summary of bank statements
 */
function generateStatementSummary(results) {
  // In a real implementation, this would analyze the statements and analysis
  // to generate a meaningful summary
  
  const statements = results.statements || [];
  const analysis = results.analysis || {};
  
  // Calculate total balance
  let totalBalance = 0;
  statements.forEach(statement => {
    if (statement.closingBalance) {
      totalBalance += parseFloat(statement.closingBalance);
    }
  });
  
  // Extract income and expense categories
  const incomeCategories = analysis.incomeCategories || [];
  const expenseCategories = analysis.expenseCategories || [];
  
  // Calculate total income and expenses
  let totalIncome = 0;
  let totalExpenses = 0;
  
  incomeCategories.forEach(category => {
    totalIncome += parseFloat(category.amount || 0);
  });
  
  expenseCategories.forEach(category => {
    totalExpenses += parseFloat(category.amount || 0);
  });
  
  return {
    periodCovered: statements.length > 0 ? 
      `${statements[0].fromDate} to ${statements[statements.length - 1].toDate}` : 
      'Unknown',
    statementCount: statements.length,
    totalBalance: totalBalance.toFixed(2),
    totalIncome: totalIncome.toFixed(2),
    totalExpenses: totalExpenses.toFixed(2),
    netCashflow: (totalIncome - totalExpenses).toFixed(2),
    topIncomeSource: incomeCategories.length > 0 ? 
      incomeCategories.sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount))[0].name : 
      'Unknown',
    topExpenseCategory: expenseCategories.length > 0 ? 
      expenseCategories.sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount))[0].name : 
      'Unknown'
  };
}

/**
 * Get mock bank statements for development/testing
 * @returns {Object} Mock bank statements and analysis
 */
function getMockBankStatements() {
  const currentDate = new Date();
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(currentDate.getMonth() - 3);
  
  const formatDate = (date) => {
    return date.toISOString().split('T')[0];
  };
  
  return {
    sessionId: `mock-session-${Date.now()}`,
    jobId: `mock-job-${Date.now()}`,
    statements: [
      {
        accountName: 'Everyday Spending',
        accountNumber: '123456',
        bsb: '062-000',
        fromDate: formatDate(threeMonthsAgo),
        toDate: formatDate(currentDate),
        openingBalance: '4200.50',
        closingBalance: '5420.28',
        transactions: [
          {
            date: '2025-02-15',
            description: 'EMPLOYER PTY LTD',
            amount: '3250.00',
            type: 'CREDIT',
            balance: '7450.50'
          },
          {
            date: '2025-02-20',
            description: 'RENT PAYMENT',
            amount: '1800.00',
            type: 'DEBIT',
            balance: '5650.50'
          },
          {
            date: '2025-03-01',
            description: 'GROCERY STORE',
            amount: '230.22',
            type: 'DEBIT',
            balance: '5420.28'
          }
        ]
      },
      {
        accountName: 'Savings Account',
        accountNumber: '789012',
        bsb: '062-000',
        fromDate: formatDate(threeMonthsAgo),
        toDate: formatDate(currentDate),
        openingBalance: '18500.25',
        closingBalance: '24150.75',
        transactions: [
          {
            date: '2025-02-15',
            description: 'TRANSFER FROM EVERYDAY',
            amount: '1500.00',
            type: 'CREDIT',
            balance: '20000.25'
          },
          {
            date: '2025-03-01',
            description: 'INTEREST PAYMENT',
            amount: '150.50',
            type: 'CREDIT',
            balance: '20150.75'
          },
          {
            date: '2025-03-15',
            description: 'TRANSFER FROM EVERYDAY',
            amount: '4000.00',
            type: 'CREDIT',
            balance: '24150.75'
          }
        ]
      }
    ],
    analysis: {
      incomeCategories: [
        {
          name: 'Salary',
          amount: '6500.00',
          frequency: 'MONTHLY'
        },
        {
          name: 'Interest',
          amount: '150.50',
          frequency: 'MONTHLY'
        }
      ],
      expenseCategories: [
        {
          name: 'Housing',
          amount: '1800.00',
          frequency: 'MONTHLY'
        },
        {
          name: 'Groceries',
          amount: '950.00',
          frequency: 'MONTHLY'
        },
        {
          name: 'Transportation',
          amount: '250.00',
          frequency: 'MONTHLY'
        },
        {
          name: 'Utilities',
          amount: '200.00',
          frequency: 'MONTHLY'
        }
      ],
      regularIncome: {
        total: '6650.50',
        frequency: 'MONTHLY'
      },
      regularExpenses: {
        total: '3200.00',
        frequency: 'MONTHLY'
      }
    },
    summary: {
      periodCovered: `${formatDate(threeMonthsAgo)} to ${formatDate(currentDate)}`,
      statementCount: 2,
      totalBalance: '29571.03',
      totalIncome: '6650.50',
      totalExpenses: '3200.00',
      netCashflow: '3450.50',
      topIncomeSource: 'Salary',
      topExpenseCategory: 'Housing'
    },
    retrievalTimestamp: new Date().toISOString()
  };
}

module.exports = {
  getBankStatements
};
