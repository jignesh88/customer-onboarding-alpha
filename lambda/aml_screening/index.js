const AWS = require('aws-sdk');
const axios = require('axios');

// Initialize AWS services
const dynamoDB = new AWS.DynamoDB.DocumentClient();

// Environment variables
const CUSTOMERS_TABLE = process.env.DYNAMODB_CUSTOMERS_TABLE;
const ONBOARDING_TABLE = process.env.DYNAMODB_ONBOARDING_TABLE;
const ENVIRONMENT = process.env.ENVIRONMENT;

// AML screening service configuration would typically come from environment variables or parameter store
const AML_SERVICE_CONFIG = {
  endpoint: process.env.AML_SERVICE_ENDPOINT || 'https://api.aml-service.com/v1/screen',
  apiKey: process.env.AML_SERVICE_API_KEY || 'dummy-api-key',
  timeout: 30000
};

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
    
    // Perform AML/CTF screening
    const screeningResult = await performAmlScreening(customer, process);
    
    // Determine if manual review is needed
    const needsManualReview = screeningResult.riskScore > 50 || 
                             screeningResult.alerts.length > 0 || 
                             screeningResult.potentialMatches.length > 0;
    
    if (screeningResult.riskScore > 75) {
      // High risk - fail the screening
      await updateProcessStatus(processId, 'AML_SCREENING_FAILED', {
        screening_result: screeningResult,
        rejection_reason: 'High AML/CTF risk score'
      });
      
      return {
        process_id: processId,
        verification: {
          aml_passed: false,
          manual_review_required: false
        },
        risk_score: screeningResult.riskScore,
        reason: 'High AML/CTF risk score'
      };
    } else if (needsManualReview) {
      // Medium risk - needs manual review
      await updateProcessStatus(processId, 'AML_MANUAL_REVIEW', {
        screening_result: screeningResult,
        manual_review_reason: screeningResult.alerts.length > 0 ? 
          'Alerts detected' : 'Potential watchlist matches'
      });
      
      return {
        process_id: processId,
        verification: {
          aml_passed: false,
          manual_review_required: true
        },
        risk_score: screeningResult.riskScore,
        reason: 'AML screening requires manual review'
      };
    } else {
      // Low risk - pass the screening
      await updateProcessStatus(processId, 'AML_SCREENING_PASSED', {
        screening_result: screeningResult
      });
      
      return {
        process_id: processId,
        verification: {
          aml_passed: true,
          manual_review_required: false
        },
        risk_score: screeningResult.riskScore,
        status: 'AML_SCREENING_PASSED'
      };
    }
    
  } catch (error) {
    console.error('Error in AML screening:', error);
    
    // Update process with error if possible
    if (event.process_id) {
      await updateProcessStatus(event.process_id, 'AML_SCREENING_ERROR', {
        error_message: error.message
      });
    }
    
    return {
      process_id: event.process_id,
      verification: {
        aml_passed: false,
        manual_review_required: true
      },
      reason: error.message
    };
  }
};

async function performAmlScreening(customer, process) {
  try {
    // Extract relevant information
    const screeningData = {
      name: customer.name,
      dateOfBirth: customer.dob,
      address: customer.address,
      nationality: customer.nationality || 'Unknown',
      documentType: process.id_document?.type,
      documentNumber: process.id_verification?.extracted_data?.documentNumber,
      additionalData: {
        email: customer.email,
        phone: customer.phone
      }
    };
    
    console.log('Preparing AML screening for customer:', screeningData);
    
    // In development environment, simulate a screening result
    if (ENVIRONMENT === 'dev') {
      console.log('Development environment - simulating AML screening result');
      return simulateAmlScreeningResult(screeningData);
    }
    
    // Call external AML screening service
    const response = await axios.post(
      AML_SERVICE_CONFIG.endpoint, 
      screeningData, 
      {
        headers: {
          'Authorization': `Bearer ${AML_SERVICE_CONFIG.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: AML_SERVICE_CONFIG.timeout
      }
    );
    
    console.log('AML screening response:', response.data);
    
    return {
      screeningId: response.data.screeningId,
      screeningTime: new Date().toISOString(),
      riskScore: response.data.riskScore,
      riskCategory: getRiskCategory(response.data.riskScore),
      alerts: response.data.alerts || [],
      potentialMatches: response.data.potentialMatches || [],
      watchlists: response.data.watchlistsChecked || []
    };
  } catch (error) {
    console.error('Error calling AML screening service:', error);
    
    // In non-production environments, provide a simulated result rather than failing
    if (ENVIRONMENT !== 'prod') {
      console.log('Non-production environment - providing fallback AML screening result');
      return simulateAmlScreeningResult(customer);
    }
    
    throw new Error(`AML screening service error: ${error.message}`);
  }
}

function simulateAmlScreeningResult(customerData) {
  // Generate a pseudo-random risk score based on customer name length
  // (This is just for simulation - real scoring would be based on actual AML/CTF checks)
  const nameLength = customerData.name ? customerData.name.length : 10;
  const baseRiskScore = (nameLength * 3) % 100;
  
  // For testing different paths, create scenarios based on the name
  const name = customerData.name ? customerData.name.toLowerCase() : '';
  const hasPepIndicator = name.includes('official') || name.includes('minister') || name.includes('diplomat');
  const hasSanctionsIndicator = name.includes('sanction') || name.includes('watch');
  
  let riskScore = baseRiskScore;
  let alerts = [];
  let potentialMatches = [];
  
  if (hasPepIndicator) {
    riskScore += 25;
    alerts.push({
      type: 'PEP',
      description: 'Potential politically exposed person',
      severity: 'MEDIUM'
    });
    
    potentialMatches.push({
      watchlist: 'Global PEP Database',
      name: `${customerData.name} (similar)`,
      score: 85,
      details: 'Potential match with a politically exposed person'
    });
  }
  
  if (hasSanctionsIndicator) {
    riskScore += 40;
    alerts.push({
      type: 'SANCTIONS',
      description: 'Potential match on sanctions list',
      severity: 'HIGH'
    });
    
    potentialMatches.push({
      watchlist: 'OFAC Sanctions List',
      name: `${customerData.name} (similar)`,
      score: 75,
      details: 'Potential match with a sanctioned entity'
    });
  }
  
  // Cap risk score at 100
  riskScore = Math.min(riskScore, 100);
  
  return {
    screeningId: `sim-${Date.now()}`,
    screeningTime: new Date().toISOString(),
    riskScore: riskScore,
    riskCategory: getRiskCategory(riskScore),
    alerts: alerts,
    potentialMatches: potentialMatches,
    watchlists: [
      'Global Sanctions Lists',
      'PEP Database',
      'Adverse Media',
      'Law Enforcement Lists'
    ],
    simulated: true
  };
}

function getRiskCategory(riskScore) {
  if (riskScore < 25) return 'LOW';
  if (riskScore < 50) return 'LOW_MEDIUM';
  if (riskScore < 75) return 'MEDIUM';
  if (riskScore < 90) return 'MEDIUM_HIGH';
  return 'HIGH';
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
      updateExpression += `, aml_screening.${key} = :val${index}`;
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