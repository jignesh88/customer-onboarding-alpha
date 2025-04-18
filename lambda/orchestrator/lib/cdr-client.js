/**
 * CDR (Consumer Data Right) API Client
 * 
 * This client handles interactions with the Consumer Data Right API for accessing
 * customer banking data with their consent.
 */

const axios = require('axios');
const AWS = require('aws-sdk');
const secretsManager = new AWS.SecretsManager();

// Environment variables
const CDR_API_BASE_URL = process.env.CDR_API_BASE_URL;
const CDR_CLIENT_ID = process.env.CDR_CLIENT_ID;
const CDR_SECRET_NAME = process.env.CDR_SECRET_NAME;
const ENVIRONMENT = process.env.ENVIRONMENT;

// Cache for access token
let tokenCache = {
  token: null,
  expiresAt: 0
};

/**
 * Get an access token for CDR API
 * @returns {Promise<string>} The access token
 */
async function getAccessToken() {
  // Check if we have a valid cached token
  const now = Date.now();
  if (tokenCache.token && tokenCache.expiresAt > now) {
    return tokenCache.token;
  }

  try {
    // Retrieve client secret from AWS Secrets Manager
    const secretData = await secretsManager.getSecretValue({
      SecretId: CDR_SECRET_NAME
    }).promise();
    
    const secret = JSON.parse(secretData.SecretString);
    const clientSecret = secret.clientSecret;

    // Request new token
    const tokenResponse = await axios.post(`${CDR_API_BASE_URL}/auth/token`, {
      grant_type: 'client_credentials',
      client_id: CDR_CLIENT_ID,
      client_secret: clientSecret,
      scope: 'bank:accounts.basic:read bank:transactions:read'
    }, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    // Cache the token
    tokenCache.token = tokenResponse.data.access_token;
    tokenCache.expiresAt = now + (tokenResponse.data.expires_in * 1000);

    return tokenCache.token;
  } catch (error) {
    console.error('Error getting CDR access token:', error);
    throw new Error(`Failed to get CDR access token: ${error.message}`);
  }
}

/**
 * Fetch customer financial data from CDR
 * @param {Object} customer - Customer information
 * @returns {Promise<Object>} CDR data including accounts and transactions
 */
async function fetchData(customer) {
  try {
    // For development/testing environments, return mock data
    if (ENVIRONMENT === 'dev' || ENVIRONMENT === 'test') {
      return getMockCdrData(customer);
    }

    const token = await getAccessToken();
    
    // Get customer's consent ID from our database or create a new consent
    const consentId = customer.cdr_consent_id || await createConsent(customer, token);
    
    // Fetch accounts data
    const accountsResponse = await axios.get(`${CDR_API_BASE_URL}/banking/accounts`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'x-v': '3',
        'x-consent-id': consentId
      }
    });
    
    const accounts = accountsResponse.data.data.accounts;
    
    // Fetch transactions for each account
    const accountTransactions = await Promise.all(
      accounts.map(async (account) => {
        const transactionsResponse = await axios.get(
          `${CDR_API_BASE_URL}/banking/accounts/${account.accountId}/transactions`, {
            headers: {
              'Authorization': `Bearer ${token}`,
              'x-v': '3',
              'x-consent-id': consentId
            },
            params: {
              'oldest-time': getLastNinetyDaysDate(),
              'newest-time': getCurrentDate(),
              'page': 1,
              'page-size': 100
            }
          }
        );
        
        return {
          accountId: account.accountId,
          transactions: transactionsResponse.data.data.transactions
        };
      })
    );
    
    // Calculate income, expenses, and savings
    const financialSummary = calculateFinancialSummary(accounts, accountTransactions);
    
    return {
      customerId: customer.customer_id,
      consentId: consentId,
      accounts: accounts,
      transactions: accountTransactions,
      bsb: accounts.length > 0 ? extractBSB(accounts[0].accountNumber) : null,
      accountNumber: accounts.length > 0 ? extractAccountNumber(accounts[0].accountNumber) : null,
      income: financialSummary.income,
      expenses: financialSummary.expenses,
      savings: financialSummary.savings,
      fetchTimestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error('Error fetching CDR data:', error);
    
    // For non-dev environments, propagate the error
    if (ENVIRONMENT !== 'dev' && ENVIRONMENT !== 'test') {
      throw new Error(`Failed to fetch CDR data: ${error.message}`);
    }
    
    // For dev/test, return mock data even on error
    return getMockCdrData(customer);
  }
}

/**
 * Create a new consent for CDR data access
 * @param {Object} customer - Customer information
 * @param {string} token - Access token
 * @returns {Promise<string>} Consent ID
 */
async function createConsent(customer, token) {
  try {
    const consentResponse = await axios.post(`${CDR_API_BASE_URL}/banking/consents`, {
      data: {
        customerRef: customer.customer_id,
        sharingDuration: 90, // 90 days
        permissions: [
          'bank:accounts.basic:read',
          'bank:transactions:read'
        ]
      }
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-v': '3'
      }
    });
    
    return consentResponse.data.data.consentId;
  } catch (error) {
    console.error('Error creating CDR consent:', error);
    throw new Error(`Failed to create CDR consent: ${error.message}`);
  }
}

/**
 * Calculate financial summary from accounts and transactions
 * @param {Array} accounts - List of accounts
 * @param {Array} accountTransactions - List of transactions per account
 * @returns {Object} Financial summary
 */
function calculateFinancialSummary(accounts, accountTransactions) {
  let totalIncome = 0;
  let totalExpenses = 0;
  let totalSavings = 0;
  
  // Calculate savings from account balances
  accounts.forEach(account => {
    if (account.productCategory === 'TRANS' || account.productCategory === 'SAVINGS') {
      totalSavings += parseFloat(account.balance);
    }
  });
  
  // Calculate income and expenses from transactions
  accountTransactions.forEach(({ transactions }) => {
    transactions.forEach(transaction => {
      const amount = parseFloat(transaction.amount);
      
      if (transaction.creditDebitIndicator === 'CRDT') {
        // Credit transactions (money in) - exclude transfers between own accounts
        if (!transaction.description.toLowerCase().includes('transfer')) {
          totalIncome += amount;
        }
      } else {
        // Debit transactions (money out)
        totalExpenses += amount;
      }
    });
  });
  
  return {
    income: totalIncome.toFixed(2),
    expenses: totalExpenses.toFixed(2),
    savings: totalSavings.toFixed(2)
  };
}

/**
 * Extract BSB from account number
 * @param {string} accountNumber - Full account number
 * @returns {string} BSB number
 */
function extractBSB(accountNumber) {
  // Australian BSB is typically the first 6 digits
  if (accountNumber && accountNumber.length >= 6) {
    return accountNumber.substring(0, 6);
  }
  return null;
}

/**
 * Extract account number without BSB
 * @param {string} fullAccountNumber - Full account number
 * @returns {string} Account number without BSB
 */
function extractAccountNumber(fullAccountNumber) {
  // Account number is typically after the BSB
  if (fullAccountNumber && fullAccountNumber.length > 6) {
    return fullAccountNumber.substring(6);
  }
  return fullAccountNumber;
}

/**
 * Get current date in ISO format
 * @returns {string} Current date
 */
function getCurrentDate() {
  return new Date().toISOString();
}

/**
 * Get date from 90 days ago in ISO format
 * @returns {string} Date from 90 days ago
 */
function getLastNinetyDaysDate() {
  const date = new Date();
  date.setDate(date.getDate() - 90);
  return date.toISOString();
}

/**
 * Get mock CDR data for development/testing
 * @param {Object} customer - Customer information
 * @returns {Object} Mock CDR data
 */
function getMockCdrData(customer) {
  return {
    customerId: customer.customer_id,
    consentId: `mock-consent-${Date.now()}`,
    accounts: [
      {
        accountId: 'acc-001',
        displayName: 'Everyday Spending',
        nickname: 'Spending',
        accountNumber: '062-000123456',
        balance: '5420.28',
        availableBalance: '5420.28',
        productCategory: 'TRANS'
      },
      {
        accountId: 'acc-002',
        displayName: 'Savings Account',
        nickname: 'Savings',
        accountNumber: '062-000789012',
        balance: '24150.75',
        availableBalance: '24150.75',
        productCategory: 'SAVINGS'
      }
    ],
    transactions: [
      {
        accountId: 'acc-001',
        transactions: [
          {
            transactionId: 'tx001',
            description: 'EMPLOYER PTY LTD',
            amount: '3250.00',
            creditDebitIndicator: 'CRDT',
            status: 'POSTED',
            transactionDateTime: '2025-04-01T00:00:00Z'
          },
          {
            transactionId: 'tx002',
            description: 'RENT PAYMENT',
            amount: '1800.00',
            creditDebitIndicator: 'DBIT',
            status: 'POSTED',
            transactionDateTime: '2025-04-05T00:00:00Z'
          },
          {
            transactionId: 'tx003',
            description: 'GROCERY STORE',
            amount: '125.30',
            creditDebitIndicator: 'DBIT',
            status: 'POSTED',
            transactionDateTime: '2025-04-08T00:00:00Z'
          }
        ]
      }
    ],
    bsb: '062-000',
    accountNumber: '123456',
    income: '6500.00',
    expenses: '3200.00',
    savings: '29571.03',
    fetchTimestamp: new Date().toISOString()
  };
}

module.exports = {
  fetchData
};
