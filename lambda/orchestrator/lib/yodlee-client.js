/**
 * Yodlee API Client
 * 
 * This client handles interactions with the Yodlee API for financial data
 * aggregation and enrichment.
 */

const axios = require('axios');
const AWS = require('aws-sdk');
const secretsManager = new AWS.SecretsManager();

// Environment variables
const YODLEE_API_URL = process.env.YODLEE_API_URL || 'https://api.yodlee.com/ysl';
const YODLEE_API_KEY_SECRET = process.env.YODLEE_API_KEY_SECRET;
const ENVIRONMENT = process.env.ENVIRONMENT;

// Cache for access token
let tokenCache = {
  token: null,
  expiresAt: 0
};

/**
 * Get an access token for Yodlee API
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
      SecretId: YODLEE_API_KEY_SECRET
    }).promise();
    
    const secret = JSON.parse(secretData.SecretString);
    const clientId = secret.clientId;
    const clientSecret = secret.clientSecret;
    const adminUsername = secret.adminUsername;
    const adminPassword = secret.adminPassword;

    // Request new token
    const tokenResponse = await axios.post(`${YODLEE_API_URL}/auth/token`, {
      clientId: clientId,
      secret: clientSecret
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Api-Version': '1.1',
        'loginName': adminUsername
      },
      auth: {
        username: adminUsername,
        password: adminPassword
      }
    });

    // Cache the token
    tokenCache.token = tokenResponse.data.token.accessToken;
    tokenCache.expiresAt = now + (tokenResponse.data.token.expiresIn * 1000);

    return tokenCache.token;
  } catch (error) {
    console.error('Error getting Yodlee access token:', error);
    throw new Error(`Failed to get Yodlee access token: ${error.message}`);
  }
}

/**
 * Create a Yodlee user or get existing user
 * @param {Object} customer - Customer information
 * @returns {Promise<Object>} Yodlee user information
 */
async function getOrCreateUser(customer) {
  try {
    const token = await getAccessToken();
    
    // Try to find existing user by email
    try {
      const searchResponse = await axios.get(`${YODLEE_API_URL}/user/findUser`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Api-Version': '1.1'
        },
        params: {
          loginName: customer.email
        }
      });
      
      if (searchResponse.data && searchResponse.data.user) {
        return {
          id: searchResponse.data.user.id,
          loginName: searchResponse.data.user.loginName
        };
      }
    } catch (error) {
      console.log('User not found, creating new user');
    }
    
    // Create new user
    const createResponse = await axios.post(`${YODLEE_API_URL}/user/register`, {
      user: {
        loginName: customer.email,
        email: customer.email,
        name: {
          first: customer.name.split(' ')[0],
          last: customer.name.split(' ').slice(1).join(' ')
        },
        address: {
          address1: customer.address,
          city: extractCity(customer.address),
          state: extractState(customer.address),
          zip: extractPostcode(customer.address),
          country: 'AUS'
        },
        preferences: {
          currency: 'AUD',
          timeZone: 'Australia/Sydney',
          dateFormat: 'DD/MM/YYYY',
          locale: 'en_AU'
        }
      }
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Api-Version': '1.1'
      }
    });
    
    return {
      id: createResponse.data.user.id,
      loginName: createResponse.data.user.loginName
    };
  } catch (error) {
    console.error('Error creating Yodlee user:', error);
    
    // For development, return a mock user
    if (ENVIRONMENT === 'dev' || ENVIRONMENT === 'test') {
      return {
        id: `mock-user-${Date.now()}`,
        loginName: customer.email
      };
    }
    
    throw new Error(`Failed to create Yodlee user: ${error.message}`);
  }
}

/**
 * Extract city from address
 * @param {string} address - Full address
 * @returns {string} City
 */
function extractCity(address) {
  // Simple extraction - in a real implementation, this would be more sophisticated
  const parts = address.split(',');
  if (parts.length >= 2) {
    return parts[1].trim();
  }
  return 'Sydney'; // Default
}

/**
 * Extract state from address
 * @param {string} address - Full address
 * @returns {string} State
 */
function extractState(address) {
  // Look for state abbreviations
  const stateMatch = address.match(/\b(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\b/i);
  if (stateMatch) {
    return stateMatch[0].toUpperCase();
  }
  return 'NSW'; // Default
}

/**
 * Extract postcode from address
 * @param {string} address - Full address
 * @returns {string} Postcode
 */
function extractPostcode(address) {
  // Australian postcodes are 4 digits
  const postcodeMatch = address.match(/\b(\d{4})\b/);
  if (postcodeMatch) {
    return postcodeMatch[0];
  }
  return '2000'; // Default (Sydney CBD)
}

/**
 * Get user access token for a specific Yodlee user
 * @param {string} loginName - User's login name
 * @returns {Promise<string>} User access token
 */
async function getUserAccessToken(loginName) {
  try {
    const adminToken = await getAccessToken();
    
    const userTokenResponse = await axios.post(`${YODLEE_API_URL}/auth/token`, {
      clientId: process.env.YODLEE_CLIENT_ID,
      secret: process.env.YODLEE_CLIENT_SECRET
    }, {
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
        'Api-Version': '1.1',
        'loginName': loginName
      }
    });
    
    return userTokenResponse.data.token.accessToken;
  } catch (error) {
    console.error('Error getting Yodlee user access token:', error);
    throw new Error(`Failed to get Yodlee user access token: ${error.message}`);
  }
}

/**
 * Add bank account to Yodlee
 * @param {string} userToken - User access token
 * @param {Object} cdrData - CDR data with account information
 * @returns {Promise<Object>} Account addition result
 */
async function addBankAccount(userToken, cdrData) {
  try {
    // Extract institution from BSB
    const institution = getBankFromBSB(cdrData.bsb);
    
    // Get provider ID for the institution
    const providerId = await getProviderIdByName(userToken, institution);
    
    // Add account
    const addAccountResponse = await axios.post(`${YODLEE_API_URL}/providers/providerAccounts`, {
      providerAccountInfo: {
        providerId: providerId,
        credentials: [
          {
            name: 'LOGIN',
            value: cdrData.accountNumber
          },
          {
            name: 'PASSWORD',
            value: 'dummy-password-for-testing' // In real implementation, this would be handled differently
          }
        ],
        dataset: [
          {
            name: 'BASIC_AGG_DATA'
          },
          {
            name: 'TRANSACTIONS'
          }
        ]
      }
    }, {
      headers: {
        'Authorization': `Bearer ${userToken}`,
        'Content-Type': 'application/json',
        'Api-Version': '1.1'
      }
    });
    
    return addAccountResponse.data;
  } catch (error) {
    console.error('Error adding bank account to Yodlee:', error);
    
    // For development, return a mock result
    if (ENVIRONMENT === 'dev' || ENVIRONMENT === 'test') {
      return {
        providerAccount: {
          id: `mock-account-${Date.now()}`,
          providerId: 123,
          status: 'SUCCESS'
        }
      };
    }
    
    throw new Error(`Failed to add bank account to Yodlee: ${error.message}`);
  }
}

/**
 * Get provider ID by bank name
 * @param {string} userToken - User access token
 * @param {string} bankName - Bank name
 * @returns {Promise<number>} Provider ID
 */
async function getProviderIdByName(userToken, bankName) {
  try {
    const providersResponse = await axios.get(`${YODLEE_API_URL}/providers`, {
      headers: {
        'Authorization': `Bearer ${userToken}`,
        'Content-Type': 'application/json',
        'Api-Version': '1.1'
      },
      params: {
        name: bankName,
        countryISOCode: 'AUS'
      }
    });
    
    if (providersResponse.data && providersResponse.data.provider && providersResponse.data.provider.length > 0) {
      return providersResponse.data.provider[0].id;
    }
    
    throw new Error(`Provider not found for bank: ${bankName}`);
  } catch (error) {
    console.error('Error getting Yodlee provider ID:', error);
    
    // For development, return a mock provider ID
    if (ENVIRONMENT === 'dev' || ENVIRONMENT === 'test') {
      // Map common Australian banks to mock provider IDs
      const mockProviderIds = {
        'Commonwealth Bank': 16441,
        'Westpac': 16442,
        'ANZ': 16443,
        'NAB': 16444,
        'Bendigo Bank': 16445,
        'ME Bank': 16446,
        'ING': 16447,
        'Macquarie Bank': 16448,
        'St. George Bank': 16449,
        'Suncorp Bank': 16450
      };
      
      return mockProviderIds[bankName] || 16441; // Default to CBA if not found
    }
    
    throw new Error(`Failed to get Yodlee provider ID: ${error.message}`);
  }
}

/**
 * Get bank name from BSB
 * @param {string} bsb - BSB number
 * @returns {string} Bank name
 */
function getBankFromBSB(bsb) {
  // This is a simplified mapping - in a real implementation, 
  // you would have a more comprehensive mapping or API lookup
  const bsbPrefix = bsb.substring(0, 3);
  
  const bsbMapping = {
    '062': 'Commonwealth Bank',
    '032': 'Westpac',
    '013': 'ANZ',
    '082': 'NAB',
    '633': 'Bendigo Bank',
    '484': 'ME Bank',
    '942': 'ING',
    '802': 'Macquarie Bank',
    '182': 'St. George Bank',
    '733': 'Suncorp Bank'
  };
  
  return bsbMapping[bsbPrefix] || 'Commonwealth Bank'; // Default to CBA if not found
}

/**
 * Get accounts and transactions from Yodlee
 * @param {string} userToken - User access token
 * @returns {Promise<Object>} Accounts and transactions data
 */
async function getAccountsAndTransactions(userToken) {
  try {
    // Get accounts
    const accountsResponse = await axios.get(`${YODLEE_API_URL}/accounts`, {
      headers: {
        'Authorization': `Bearer ${userToken}`,
        'Content-Type': 'application/json',
        'Api-Version': '1.1'
      },
      params: {
        container: 'bank'
      }
    });
    
    const accounts = accountsResponse.data.account || [];
    
    // Get transactions for each account
    const accountTransactions = await Promise.all(
      accounts.map(async (account) => {
        const fromDate = getLastNinetyDaysDate();
        const toDate = getCurrentDate();
        
        const transactionsResponse = await axios.get(`${YODLEE_API_URL}/transactions`, {
          headers: {
            'Authorization': `Bearer ${userToken}`,
            'Content-Type': 'application/json',
            'Api-Version': '1.1'
          },
          params: {
            accountId: account.id,
            fromDate: fromDate,
            toDate: toDate
          }
        });
        
        return {
          accountId: account.id,
          transactions: transactionsResponse.data.transaction || []
        };
      })
    );
    
    return {
      accounts,
      accountTransactions
    };
  } catch (error) {
    console.error('Error getting Yodlee accounts and transactions:', error);
    
    // For development, return mock data
    if (ENVIRONMENT === 'dev' || ENVIRONMENT === 'test') {
      return getMockAccountsAndTransactions();
    }
    
    throw new Error(`Failed to get Yodlee accounts and transactions: ${error.message}`);
  }
}

/**
 * Get enriched data from Yodlee
 * @param {string} userToken - User access token
 * @returns {Promise<Object>} Enriched financial data
 */
async function getEnrichedData(userToken) {
  try {
    // Get derived transactions (categorized and enriched)
    const derivedResponse = await axios.get(`${YODLEE_API_URL}/derived/transactions`, {
      headers: {
        'Authorization': `Bearer ${userToken}`,
        'Content-Type': 'application/json',
        'Api-Version': '1.1'
      },
      params: {
        groupBy: 'CATEGORY'
      }
    });
    
    // Get holdings (investments)
    const holdingsResponse = await axios.get(`${YODLEE_API_URL}/derived/holdings`, {
      headers: {
        'Authorization': `Bearer ${userToken}`,
        'Content-Type': 'application/json',
        'Api-Version': '1.1'
      }
    });
    
    // Get net worth
    const netWorthResponse = await axios.get(`${YODLEE_API_URL}/derived/networth`, {
      headers: {
        'Authorization': `Bearer ${userToken}`,
        'Content-Type': 'application/json',
        'Api-Version': '1.1'
      }
    });
    
    return {
      categorizedTransactions: derivedResponse.data.derivedTransactions || [],
      holdings: holdingsResponse.data.holding || [],
      netWorth: netWorthResponse.data.networth || {}
    };
  } catch (error) {
    console.error('Error getting Yodlee enriched data:', error);
    
    // For development, return mock data
    if (ENVIRONMENT === 'dev' || ENVIRONMENT === 'test') {
      return getMockEnrichedData();
    }
    
    throw new Error(`Failed to get Yodlee enriched data: ${error.message}`);
  }
}

/**
 * Aggregate financial data with Yodlee
 * @param {Object} customer - Customer information
 * @param {Object} cdrData - CDR data with account information
 * @returns {Promise<Object>} Aggregated and enriched financial data
 */
async function aggregateData(customer, cdrData) {
  try {
    // For development/testing environments, return mock data
    if (ENVIRONMENT === 'dev' || ENVIRONMENT === 'test') {
      return getMockAggregatedData(customer, cdrData);
    }
    
    // Create or get Yodlee user
    const user = await getOrCreateUser(customer);
    
    // Get user access token
    const userToken = await getUserAccessToken(user.loginName);
    
    // Add bank account
    await addBankAccount(userToken, cdrData);
    
    // Get accounts and transactions
    const { accounts, accountTransactions } = await getAccountsAndTransactions(userToken);
    
    // Get enriched data
    const enrichedData = await getEnrichedData(userToken);
    
    // Generate insights
    const insights = generateInsights(accounts, accountTransactions, enrichedData);
    
    // Generate spending pattern
    const spendingPattern = analyzeSpendingPattern(enrichedData.categorizedTransactions);
    
    return {
      userId: user.id,
      accounts: accounts,
      transactions: accountTransactions,
      enrichedData: enrichedData,
      insights: insights,
      spending_pattern: spendingPattern,
      summary: {
        accountCount: accounts.length,
        totalBalance: calculateTotalBalance(accounts),
        categorizedSpending: summarizeSpendingByCategory(enrichedData.categorizedTransactions),
        netWorth: enrichedData.netWorth.amount || 'Unknown'
      },
      aggregationTimestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error('Error aggregating data with Yodlee:', error);
    
    // For non-dev environments, propagate the error
    if (ENVIRONMENT !== 'dev' && ENVIRONMENT !== 'test') {
      throw new Error(`Failed to aggregate data with Yodlee: ${error.message}`);
    }
    
    // For dev/test, return mock data even on error
    return getMockAggregatedData(customer, cdrData);
  }
}

/**
 * Calculate total balance from accounts
 * @param {Array} accounts - List of accounts
 * @returns {string} Total balance
 */
function calculateTotalBalance(accounts) {
  let total = 0;
  accounts.forEach(account => {
    if (account.balance && account.balance.amount) {
      total += parseFloat(account.balance.amount);
    }
  });
  return total.toFixed(2);
}

/**
 * Summarize spending by category
 * @param {Array} categorizedTransactions - Categorized transactions
 * @returns {Array} Spending by category
 */
function summarizeSpendingByCategory(categorizedTransactions) {
  const categories = {};
  
  categorizedTransactions.forEach(transaction => {
    if (transaction.category && transaction.amount && transaction.amount.amount) {
      const category = transaction.category;
      const amount = parseFloat(transaction.amount.amount);
      
      if (amount < 0) { // Spending is negative
        const absAmount = Math.abs(amount);
        if (categories[category]) {
          categories[category] += absAmount;
        } else {
          categories[category] = absAmount;
        }
      }
    }
  });
  
  // Convert to array and sort by amount
  return Object.entries(categories)
    .map(([category, amount]) => ({
      category,
      amount: amount.toFixed(2)
    }))
    .sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount));
}

/**
 * Generate insights from financial data
 * @param {Array} accounts - List of accounts
 * @param {Array} accountTransactions - List of transactions per account
 * @param {Object} enrichedData - Enriched data from Yodlee
 * @returns {Array} Financial insights
 */
function generateInsights(accounts, accountTransactions, enrichedData) {
  const insights = [];
  
  // Check for low balance
  accounts.forEach(account => {
    if (account.balance && account.balance.amount && parseFloat(account.balance.amount) < 500) {
      insights.push({
        type: 'LOW_BALANCE',
        description: `Your ${account.accountName} balance is low (${account.balance.amount} ${account.balance.currency})`,
        severity: 'WARNING'
      });
    }
  });
  
  // Check for large expenses
  accountTransactions.forEach(({ transactions }) => {
    transactions.forEach(transaction => {
      if (transaction.amount && transaction.amount.amount && parseFloat(transaction.amount.amount) < -500) {
        insights.push({
          type: 'LARGE_EXPENSE',
          description: `Large expense of ${Math.abs(parseFloat(transaction.amount.amount)).toFixed(2)} ${transaction.amount.currency} for ${transaction.description}`,
          severity: 'INFO',
          date: transaction.date
        });
      }
    });
  });
  
  // Check for recurring payments
  if (enrichedData.categorizedTransactions) {
    const subscriptions = enrichedData.categorizedTransactions.filter(
      transaction => transaction.category === 'Subscriptions' || transaction.category === 'Bills & Utilities'
    );
    
    if (subscriptions.length > 0) {
      const totalSubscriptions = subscriptions.reduce((total, transaction) => {
        return total + Math.abs(parseFloat(transaction.amount.amount || 0));
      }, 0);
      
      insights.push({
        type: 'SUBSCRIPTION_SUMMARY',
        description: `You spent ${totalSubscriptions.toFixed(2)} AUD on subscriptions and bills in the last 90 days`,
        severity: 'INFO'
      });
    }
  }
  
  return insights;
}

/**
 * Analyze spending pattern from categorized transactions
 * @param {Array} categorizedTransactions - Categorized transactions
 * @returns {string} Spending pattern description
 */
function analyzeSpendingPattern(categorizedTransactions) {
  if (!categorizedTransactions || categorizedTransactions.length === 0) {
    return 'Insufficient data to determine spending pattern';
  }
  
  // Group transactions by category
  const categorySpending = {};
  let totalSpending = 0;
  
  categorizedTransactions.forEach(transaction => {
    if (transaction.amount && transaction.amount.amount) {
      const amount = parseFloat(transaction.amount.amount);
      if (amount < 0) { // Spending is negative
        const absAmount = Math.abs(amount);
        totalSpending += absAmount;
        
        if (transaction.category) {
          if (categorySpending[transaction.category]) {
            categorySpending[transaction.category] += absAmount;
          } else {
            categorySpending[transaction.category] = absAmount;
          }
        }
      }
    }
  });
  
  // Calculate percentage for each category
  const categoryPercentages = {};
  Object.entries(categorySpending).forEach(([category, amount]) => {
    categoryPercentages[category] = (amount / totalSpending) * 100;
  });
  
  // Determine top categories
  const sortedCategories = Object.entries(categoryPercentages)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  
  // Generate pattern description
  if (sortedCategories.length === 0) {
    return 'Insufficient categorized data to determine spending pattern';
  }
  
  const topCategory = sortedCategories[0][0];
  const topPercentage = sortedCategories[0][1].toFixed(0);
  
  if (topPercentage > 40) {
    return `High spending in ${topCategory} (${topPercentage}% of expenses)`;
  } else if (sortedCategories.length >= 2) {
    return `Balanced spending across ${topCategory} (${topPercentage}%) and ${sortedCategories[1][0]} (${sortedCategories[1][1].toFixed(0)}%)`;
  } else {
    return `Diverse spending pattern with ${topCategory} as the largest category (${topPercentage}%)`;
  }
}

/**
 * Get current date in YYYY-MM-DD format
 * @returns {string} Current date
 */
function getCurrentDate() {
  const date = new Date();
  return date.toISOString().split('T')[0];
}

/**
 * Get date from 90 days ago in YYYY-MM-DD format
 * @returns {string} Date from 90 days ago
 */
function getLastNinetyDaysDate() {
  const date = new Date();
  date.setDate(date.getDate() - 90);
  return date.toISOString().split('T')[0];
}

/**
 * Get mock accounts and transactions for development/testing
 * @returns {Object} Mock accounts and transactions
 */
function getMockAccountsAndTransactions() {
  return {
    accounts: [
      {
        id: 'acc-001',
        accountName: 'Everyday Spending',
        accountNumber: '123456',
        accountType: 'CHECKING',
        balance: {
          amount: '5420.28',
          currency: 'AUD'
        },
        CONTAINER: 'bank'
      },
      {
        id: 'acc-002',
        accountName: 'Savings Account',
        accountNumber: '789012',
        accountType: 'SAVINGS',
        balance: {
          amount: '24150.75',
          currency: 'AUD'
        },
        CONTAINER: 'bank'
      }
    ],
    accountTransactions: [
      {
        accountId: 'acc-001',
        transactions: [
          {
            id: 'tx001',
            description: 'EMPLOYER PTY LTD',
            amount: {
              amount: '3250.00',
              currency: 'AUD'
            },
            baseType: 'CREDIT',
            status: 'POSTED',
            date: '2025-02-15'
          },
          {
            id: 'tx002',
            description: 'RENT PAYMENT',
            amount: {
              amount: '-1800.00',
              currency: 'AUD'
            },
            baseType: 'DEBIT',
            status: 'POSTED',
            date: '2025-02-20'
          },
          {
            id: 'tx003',
            description: 'GROCERY STORE',
            amount: {
              amount: '-125.30',
              currency: 'AUD'
            },
            baseType: 'DEBIT',
            status: 'POSTED',
            date: '2025-03-01'
          }
        ]
      },
      {
        accountId: 'acc-002',
        transactions: [
          {
            id: 'tx004',
            description: 'TRANSFER FROM EVERYDAY',
            amount: {
              amount: '1500.00',
              currency: 'AUD'
            },
            baseType: 'CREDIT',
            status: 'POSTED',
            date: '2025-02-15'
          },
          {
            id: 'tx005',
            description: 'INTEREST PAYMENT',
            amount: {
              amount: '150.50',
              currency: 'AUD'
            },
            baseType: 'CREDIT',
            status: 'POSTED',
            date: '2025-03-01'
          }
        ]
      }
    ]
  };
}

/**
 * Get mock enriched data for development/testing
 * @returns {Object} Mock enriched data
 */
function getMockEnrichedData() {
  return {
    categorizedTransactions: [
      {
        id: 'tx002',
        description: 'RENT PAYMENT',
        amount: {
          amount: '-1800.00',
          currency: 'AUD'
        },
        category: 'Housing',
        date: '2025-02-20'
      },
      {
        id: 'tx003',
        description: 'GROCERY STORE',
        amount: {
          amount: '-125.30',
          currency: 'AUD'
        },
        category: 'Groceries',
        date: '2025-03-01'
      },
      {
        id: 'tx006',
        description: 'NETFLIX',
        amount: {
          amount: '-15.99',
          currency: 'AUD'
        },
        category: 'Subscriptions',
        date: '2025-02-10'
      },
      {
        id: 'tx007',
        description: 'ELECTRICITY BILL',
        amount: {
          amount: '-180.50',
          currency: 'AUD'
        },
        category: 'Bills & Utilities',
        date: '2025-02-25'
      },
      {
        id: 'tx008',
        description: 'MOBILE PHONE',
        amount: {
          amount: '-65.00',
          currency: 'AUD'
        },
        category: 'Bills & Utilities',
        date: '2025-03-05'
      },
      {
        id: 'tx009',
        description: 'RESTAURANT',
        amount: {
          amount: '-85.75',
          currency: 'AUD'
        },
        category: 'Food & Dining',
        date: '2025-03-10'
      }
    ],
    holdings: [],
    netWorth: {
      amount: '29571.03',
      currency: 'AUD'
    }
  };
}

/**
 * Get mock aggregated data for development/testing
 * @param {Object} customer - Customer information
 * @param {Object} cdrData - CDR data
 * @returns {Object} Mock aggregated data
 */
function getMockAggregatedData(customer, cdrData) {
  const mockAccounts = getMockAccountsAndTransactions().accounts;
  const mockTransactions = getMockAccountsAndTransactions().accountTransactions;
  const mockEnriched = getMockEnrichedData();
  
  return {
    userId: `yodlee-user-${customer.customer_id}`,
    accounts: mockAccounts,
    transactions: mockTransactions,
    enrichedData: mockEnriched,
    insights: [
      {
        type: 'SUBSCRIPTION_SUMMARY',
        description: 'You spent 261.49 AUD on subscriptions and bills in the last 90 days',
        severity: 'INFO'
      },
      {
        type: 'LARGE_EXPENSE',
        description: 'Large expense of 1800.00 AUD for RENT PAYMENT',
        severity: 'INFO',
        date: '2025-02-20'
      }
    ],
    spending_pattern: 'High spending in Housing (79% of expenses)',
    summary: {
      accountCount: mockAccounts.length,
      totalBalance: '29571.03',
      categorizedSpending: [
        {
          category: 'Housing',
          amount: '1800.00'
        },
        {
          category: 'Groceries',
          amount: '125.30'
        },
        {
          category: 'Subscriptions',
          amount: '15.99'
        },
        {
          category: 'Bills & Utilities',
          amount: '246.50'
        },
        {
          category: 'Food & Dining',
          amount: '85.75'
        }
      ],
      netWorth: '29571.03'
    },
    aggregationTimestamp: new Date().toISOString()
  };
}
/**
 * Export Yodlee client functions
 */
module.exports = {
  getAccessToken,
  getOrCreateUser,
  addBankAccount,
  getAccountsAndTransactions,
  getEnrichedData,
  aggregateData,
  getUserAccessToken,
  getProviderIdByName
};
