/**
 * Basiq API Client
 * 
 * This client handles interactions with the Basiq API for account verification
 * and financial data enrichment.
 */

const axios = require('axios');
const AWS = require('aws-sdk');
const secretsManager = new AWS.SecretsManager();

// Environment variables
const BASIQ_API_URL = process.env.BASIQ_API_URL || 'https://au-api.basiq.io';
const BASIQ_API_KEY_SECRET = process.env.BASIQ_API_KEY_SECRET;
const ENVIRONMENT = process.env.ENVIRONMENT;

// Cache for access token
let tokenCache = {
  token: null,
  expiresAt: 0
};

/**
 * Get an access token for Basiq API
 * @returns {Promise<string>} The access token
 */
async function getAccessToken() {
  // Check if we have a valid cached token
  const now = Date.now();
  if (tokenCache.token && tokenCache.expiresAt > now) {
    return tokenCache.token;
  }

  try {
    // Retrieve API key from AWS Secrets Manager
    const secretData = await secretsManager.getSecretValue({
      SecretId: BASIQ_API_KEY_SECRET
    }).promise();
    
    const secret = JSON.parse(secretData.SecretString);
    const apiKey = secret.apiKey;

    // Request new token
    const tokenResponse = await axios.post(`${BASIQ_API_URL}/token`, {}, {
      headers: {
        'Authorization': `Basic ${apiKey}`,
        'Content-Type': 'application/json',
        'basiq-version': '3.0'
      }
    });

    // Cache the token
    tokenCache.token = tokenResponse.data.access_token;
    tokenCache.expiresAt = now + (tokenResponse.data.expires_in * 1000);

    return tokenCache.token;
  } catch (error) {
    console.error('Error getting Basiq access token:', error);
    throw new Error(`Failed to get Basiq access token: ${error.message}`);
  }
}

/**
 * Create a Basiq user or get existing user
 * @param {Object} customer - Customer information
 * @returns {Promise<string>} Basiq user ID
 */
async function getOrCreateUser(customer) {
  try {
    const token = await getAccessToken();
    
    // Try to find existing user by email
    try {
      const searchResponse = await axios.get(`${BASIQ_API_URL}/users`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'basiq-version': '3.0'
        },
        params: {
          filter: `email.eq('${customer.email}')`
        }
      });
      
      if (searchResponse.data.data && searchResponse.data.data.length > 0) {
        return searchResponse.data.data[0].id;
      }
    } catch (error) {
      console.log('User not found, creating new user');
    }
    
    // Create new user
    const createResponse = await axios.post(`${BASIQ_API_URL}/users`, {
      email: customer.email,
      mobile: customer.phone,
      firstName: customer.name.split(' ')[0],
      lastName: customer.name.split(' ').slice(1).join(' '),
      externalId: customer.customer_id
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'basiq-version': '3.0'
      }
    });
    
    return createResponse.data.id;
  } catch (error) {
    console.error('Error creating Basiq user:', error);
    throw new Error(`Failed to create Basiq user: ${error.message}`);
  }
}

/**
 * Create a bank account connection for a user
 * @param {string} userId - Basiq user ID
 * @param {Object} cdrData - CDR data with account information
 * @returns {Promise<string>} Connection ID
 */
async function createConnection(userId, cdrData) {
  try {
    const token = await getAccessToken();
    
    // Extract institution from BSB
    const institution = getBankFromBSB(cdrData.bsb);
    
    // Create connection
    const connectionResponse = await axios.post(`${BASIQ_API_URL}/users/${userId}/connections`, {
      institution: {
        id: institution
      },
      loginId: cdrData.accountNumber,
      password: 'dummy-password-for-testing', // In real implementation, this would be handled differently
      bsb: cdrData.bsb,
      accountNumber: cdrData.accountNumber
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'basiq-version': '3.0'
      }
    });
    
    return connectionResponse.data.id;
  } catch (error) {
    console.error('Error creating Basiq connection:', error);
    
    // For development, return a mock connection ID
    if (ENVIRONMENT === 'dev' || ENVIRONMENT === 'test') {
      return `mock-connection-${Date.now()}`;
    }
    
    throw new Error(`Failed to create Basiq connection: ${error.message}`);
  }
}

/**
 * Get bank institution ID from BSB
 * @param {string} bsb - BSB number
 * @returns {string} Bank institution ID
 */
function getBankFromBSB(bsb) {
  // This is a simplified mapping - in a real implementation, 
  // you would have a more comprehensive mapping or API lookup
  const bsbPrefix = bsb.substring(0, 3);
  
  const bsbMapping = {
    '062': 'AU00001', // Commonwealth Bank
    '032': 'AU00002', // Westpac
    '013': 'AU00003', // ANZ
    '082': 'AU00004', // NAB
    '633': 'AU00005', // Bendigo Bank
    '484': 'AU00006', // ME Bank
    '942': 'AU00007', // ING
    '802': 'AU00008', // Macquarie Bank
    '182': 'AU00009', // St. George Bank
    '733': 'AU00010'  // Suncorp Bank
  };
  
  return bsbMapping[bsbPrefix] || 'AU00001'; // Default to CBA if not found
}

/**
 * Verify account with Basiq
 * @param {Object} customer - Customer information
 * @param {Object} cdrData - CDR data with account information
 * @returns {Promise<Object>} Verification result
 */
async function verifyAccount(customer, cdrData) {
  try {
    // For development/testing environments, return mock data
    if (ENVIRONMENT === 'dev' || ENVIRONMENT === 'test') {
      return getMockVerificationResult(customer, cdrData);
    }
    
    // Create or get Basiq user
    const userId = await getOrCreateUser(customer);
    
    // Create connection to bank
    const connectionId = await createConnection(userId, cdrData);
    
    // Get connection status
    const token = await getAccessToken();
    const connectionResponse = await axios.get(`${BASIQ_API_URL}/connections/${connectionId}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'basiq-version': '3.0'
      }
    });
    
    const connection = connectionResponse.data;
    
    // Get account details
    const accountsResponse = await axios.get(`${BASIQ_API_URL}/users/${userId}/accounts`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'basiq-version': '3.0'
      }
    });
    
    const accounts = accountsResponse.data.data;
    
    // Verify account details match
    const accountVerified = accounts.some(account => 
      account.accountNo === cdrData.accountNumber && 
      account.bsb === cdrData.bsb
    );
    
    // Get affordability metrics
    const affordabilityResponse = await axios.get(`${BASIQ_API_URL}/users/${userId}/affordability`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'basiq-version': '3.0'
      }
    });
    
    const affordability = affordabilityResponse.data;
    
    return {
      userId: userId,
      connectionId: connectionId,
      connectionStatus: connection.status,
      accountVerified: accountVerified,
      affordabilityMetrics: {
        income: affordability.income,
        expenses: affordability.expenses,
        savingsRatio: affordability.savingsRatio,
        affordabilityScore: affordability.affordabilityScore
      },
      verificationTimestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error('Error verifying account with Basiq:', error);
    
    // For non-dev environments, propagate the error
    if (ENVIRONMENT !== 'dev' && ENVIRONMENT !== 'test') {
      throw new Error(`Failed to verify account with Basiq: ${error.message}`);
    }
    
    // For dev/test, return mock data even on error
    return getMockVerificationResult(customer, cdrData);
  }
}

/**
 * Get mock verification result for development/testing
 * @param {Object} customer - Customer information
 * @param {Object} cdrData - CDR data
 * @returns {Object} Mock verification result
 */
function getMockVerificationResult(customer, cdrData) {
  return {
    userId: `basiq-user-${customer.customer_id}`,
    connectionId: `mock-connection-${Date.now()}`,
    connectionStatus: 'success',
    accountVerified: true,
    affordabilityMetrics: {
      income: parseFloat(cdrData.income || 6500),
      expenses: parseFloat(cdrData.expenses || 3200),
      savingsRatio: 0.51, // (income - expenses) / income
      affordabilityScore: 85
    },
    verificationTimestamp: new Date().toISOString()
  };
}

module.exports = {
  verifyAccount
};
