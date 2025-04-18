const AWS = require('aws-sdk');
const axios = require('axios');

// Initialize AWS services
const s3 = new AWS.S3();
const dynamoDB = new AWS.DynamoDB.DocumentClient();
const textract = new AWS.Textract();

// Environment variables
const S3_BUCKET = process.env.S3_BUCKET;
const ONBOARDING_TABLE = process.env.DYNAMODB_ONBOARDING_TABLE;
const DVS_API_ENDPOINT = process.env.DVS_API_ENDPOINT;
const DVS_API_KEY = process.env.DVS_API_KEY;

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
    
    if (!process.id_document) {
      throw new Error('No ID document has been uploaded for this process');
    }
    
    // The document image should have been uploaded to S3 during the API call
    // The S3 key is typically structured as: {processId}/id/{documentType}
    const s3Key = `${processId}/id/${process.id_document.type}`;
    
    // 1. Process the ID document with Textract
    const extractedData = await extractTextFromDocument(s3Key);
    
    // 2. Validate the extracted data against customer details
    const validationResult = validateExtractedData(extractedData, process.customer_details);
    
    if (!validationResult.valid) {
      await updateProcessStatus(processId, 'ID_VERIFICATION_FAILED', {
        verification_status: 'FAILED',
        failure_reason: validationResult.reason
      });
      
      return {
        process_id: processId,
        verification: {
          id_verified: false
        },
        reason: validationResult.reason
      };
    }
    
    // 3. Verify the ID with Document Verification Service (DVS)
    const dvsVerificationResult = await verifyWithDVS(extractedData, process.customer_details);
    
    if (!dvsVerificationResult.verified) {
      await updateProcessStatus(processId, 'ID_VERIFICATION_FAILED', {
        verification_status: 'FAILED',
        failure_reason: dvsVerificationResult.reason
      });
      
      return {
        process_id: processId,
        verification: {
          id_verified: false
        },
        reason: dvsVerificationResult.reason
      };
    }
    
    // 4. Update process with successful verification
    await updateProcessStatus(processId, 'ID_VERIFICATION_COMPLETE', {
      verification_status: 'VERIFIED',
      extracted_data: extractedData,
      dvs_verification: dvsVerificationResult
    });
    
    return {
      process_id: processId,
      verification: {
        id_verified: true
      },
      status: 'ID_VERIFICATION_COMPLETE'
    };
    
  } catch (error) {
    console.error('Error in ID verification:', error);
    
    // Update process with error if possible
    if (event.process_id) {
      await updateProcessStatus(event.process_id, 'ID_VERIFICATION_ERROR', {
        verification_status: 'ERROR',
        error_message: error.message
      });
    }
    
    return {
      process_id: event.process_id,
      verification: {
        id_verified: false
      },
      reason: error.message
    };
  }
};

async function extractTextFromDocument(s3Key) {
  try {
    // Call Textract to extract text from the document
    const params = {
      Document: {
        S3Object: {
          Bucket: S3_BUCKET,
          Name: s3Key
        }
      },
      FeatureTypes: ['FORMS', 'TABLES']
    };
    
    const textractResponse = await textract.analyzeDocument(params).promise();
    console.log('Textract response received');
    
    // Parse the Textract response to extract relevant ID information
    const extractedData = parseTextractResponse(textractResponse);
    
    return extractedData;
  } catch (error) {
    console.error('Error extracting text from document:', error);
    throw new Error(`Failed to extract text from ID document: ${error.message}`);
  }
}

function parseTextractResponse(textractResponse) {
  // Initialize extracted data object
  const extractedData = {
    documentType: null,
    documentNumber: null,
    name: null,
    dob: null,
    expiryDate: null,
    address: null
  };
  
  // Helper to find key-value pairs in Textract response
  const findKeyValue = (key) => {
    // Look through form fields
    if (textractResponse.Blocks) {
      const keyBlocks = textractResponse.Blocks.filter(block => 
        block.BlockType === 'KEY_VALUE_SET' && 
        block.EntityTypes && 
        block.EntityTypes.includes('KEY')
      );
      
      for (const keyBlock of keyBlocks) {
        const keyText = getTextFromKeyBlock(keyBlock, textractResponse.Blocks);
        if (keyText.toLowerCase().includes(key.toLowerCase())) {
          const valueText = getValueFromKeyBlock(keyBlock, textractResponse.Blocks);
          return valueText;
        }
      }
    }
    return null;
  };
  
  // Get full text for searching patterns
  const fullText = getFullText(textractResponse.Blocks);
  
  // Try to detect document type based on text content
  if (fullText.match(/driver('s)?\s*licen(s|c)e/i)) {
    extractedData.documentType = 'DRIVERS_LICENSE';
  } else if (fullText.match(/passport/i)) {
    extractedData.documentType = 'PASSPORT';
  } else if (fullText.match(/medicare/i)) {
    extractedData.documentType = 'MEDICARE';
  }
  
  // Extract common fields
  extractedData.name = findKeyValue('name') || findKeyValue('full name');
  extractedData.dob = findKeyValue('date of birth') || findKeyValue('birth date') || findKeyValue('dob');
  extractedData.expiryDate = findKeyValue('expiry') || findKeyValue('expiry date');
  
  // Extract document-specific fields
  if (extractedData.documentType === 'DRIVERS_LICENSE') {
    extractedData.documentNumber = findKeyValue('licence no') || findKeyValue('license number');
    extractedData.address = findKeyValue('address');
  } else if (extractedData.documentType === 'PASSPORT') {
    extractedData.documentNumber = findKeyValue('passport number') || findKeyValue('document number');
  } else if (extractedData.documentType === 'MEDICARE') {
    extractedData.documentNumber = findKeyValue('card number') || findKeyValue('medicare number');
  }
  
  // Try to find document number with regex if not found through key-value
  if (!extractedData.documentNumber) {
    // Driver's license number pattern (varies by country/state)
    const dlNumberMatch = fullText.match(/\b([A-Z0-9]{6,12})\b/);
    if (dlNumberMatch) {
      extractedData.documentNumber = dlNumberMatch[1];
    }
    
    // Passport number pattern
    const passportMatch = fullText.match(/\b([A-Z][0-9]{7,8})\b/);
    if (passportMatch) {
      extractedData.documentNumber = passportMatch[1];
    }
    
    // Medicare number pattern (Australian)
    const medicareMatch = fullText.match(/\b([0-9]{10,11})\b/);
    if (medicareMatch) {
      extractedData.documentNumber = medicareMatch[1];
    }
  }
  
  // Try to find DOB with regex if not found through key-value
  if (!extractedData.dob) {
    const dobMatch = fullText.match(/\b(0[1-9]|[12][0-9]|3[01])[\/\-](0[1-9]|1[012])[\/\-](19|20)\d\d\b/);
    if (dobMatch) {
      extractedData.dob = dobMatch[0];
    }
  }
  
  return extractedData;
}

function getTextFromKeyBlock(keyBlock, blocks) {
  // Get the child block IDs for this key block
  const childIds = keyBlock.Relationships ? 
    keyBlock.Relationships.filter(rel => rel.Type === 'CHILD').flatMap(rel => rel.Ids) : 
    [];
  
  // Get the text blocks for these IDs
  const textBlocks = blocks.filter(block => 
    childIds.includes(block.Id) && block.BlockType === 'WORD'
  );
  
  // Combine the text from all child blocks
  return textBlocks.map(block => block.Text).join(' ');
}

function getValueFromKeyBlock(keyBlock, blocks) {
  // Get the value block ID for this key block
  const valueIds = keyBlock.Relationships ? 
    keyBlock.Relationships.filter(rel => rel.Type === 'VALUE').flatMap(rel => rel.Ids) : 
    [];
  
  if (valueIds.length === 0) {
    return null;
  }
  
  const valueBlock = blocks.find(block => block.Id === valueIds[0]);
  if (!valueBlock || !valueBlock.Relationships) {
    return null;
  }
  
  // Get the child block IDs for this value block
  const childIds = valueBlock.Relationships.filter(rel => rel.Type === 'CHILD').flatMap(rel => rel.Ids);
  
  // Get the text blocks for these IDs
  const textBlocks = blocks.filter(block => 
    childIds.includes(block.Id) && block.BlockType === 'WORD'
  );
  
  // Combine the text from all child blocks
  return textBlocks.map(block => block.Text).join(' ');
}

function getFullText(blocks) {
  if (!blocks) return '';
  
  // Get all WORD blocks
  const textBlocks = blocks.filter(block => block.BlockType === 'WORD');
  
  // Combine their text
  return textBlocks.map(block => block.Text).join(' ');
}

function validateExtractedData(extractedData, customerDetails) {
  if (!customerDetails) {
    return { valid: false, reason: 'No customer details available for validation' };
  }
  
  // Check if we extracted enough data
  if (!extractedData.name || !extractedData.dob || !extractedData.documentNumber) {
    return { 
      valid: false, 
      reason: 'Could not extract all required fields from the ID document' 
    };
  }
  
  // Normalize names for comparison (remove case, extra spaces, punctuation)
  const normalizedExtractedName = normalizeText(extractedData.name);
  const normalizedCustomerName = normalizeText(customerDetails.name);
  
  // Check if name matches
  if (!nameMatch(normalizedExtractedName, normalizedCustomerName)) {
    return { 
      valid: false, 
      reason: 'Name on ID does not match provided customer details' 
    };
  }
  
  // Normalize and compare dates of birth
  const extractedDOB = normalizeDate(extractedData.dob);
  const customerDOB = normalizeDate(customerDetails.dob);
  
  if (extractedDOB !== customerDOB) {
    return { 
      valid: false, 
      reason: 'Date of birth on ID does not match provided customer details' 
    };
  }
  
  // Validation passed
  return { valid: true };
}

function normalizeText(text) {
  if (!text) return '';
  
  // Convert to lowercase, remove punctuation and extra spaces
  return text.toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDate(dateStr) {
  if (!dateStr) return '';
  
  try {
    // Try to parse the date
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      // If standard parsing fails, try to handle common formats
      const parts = dateStr.split(/[\/\-]/);
      if (parts.length === 3) {
        // Assuming day/month/year format
        const day = parts[0].padStart(2, '0');
        const month = parts[1].padStart(2, '0');
        const year = parts[2].length === 2 ? `20${parts[2]}` : parts[2];
        return `${year}-${month}-${day}`;
      }
      return dateStr;
    }
    
    // Format as YYYY-MM-DD
    return date.toISOString().split('T')[0];
  } catch (error) {
    console.error('Error normalizing date:', error);
    return dateStr;
  }
}

function nameMatch(name1, name2) {
  // Split names into parts
  const parts1 = name1.split(' ').filter(p => p.length > 0);
  const parts2 = name2.split(' ').filter(p => p.length > 0);
  
  // Check if first and last parts match
  // This is a simple approach - could be enhanced with fuzzy matching
  if (parts1.length > 0 && parts2.length > 0) {
    const firstName1 = parts1[0];
    const firstName2 = parts2[0];
    
    const lastName1 = parts1[parts1.length - 1];
    const lastName2 = parts2[parts2.length - 1];
    
    return (firstName1 === firstName2 || firstName1.includes(firstName2) || firstName2.includes(firstName1)) && 
           (lastName1 === lastName2 || lastName1.includes(lastName2) || lastName2.includes(lastName1));
  }
  
  return false;
}

async function verifyWithDVS(extractedData, customerDetails) {
  try {
    // Prepare the verification request to the Document Verification Service
    const verificationRequest = {
      documentType: extractedData.documentType,
      documentNumber: extractedData.documentNumber,
      name: {
        familyName: extractFamilyName(extractedData.name || customerDetails.name),
        givenNames: extractGivenNames(extractedData.name || customerDetails.name)
      },
      dateOfBirth: normalizeDate(extractedData.dob || customerDetails.dob)
    };
    
    // Add document-specific fields
    if (extractedData.documentType === 'DRIVERS_LICENSE') {
      verificationRequest.licenseState = extractLicenseState(extractedData.address);
    }
    
    console.log('Sending verification request to DVS');
    
    // Call the DVS API
    const response = await axios.post(DVS_API_ENDPOINT, verificationRequest, {
      headers: {
        'Authorization': `Bearer ${DVS_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    
    // Check the verification result
    if (response.data.verified) {
      return {
        verified: true,
        verificationId: response.data.verificationId,
        timestamp: new Date().toISOString()
      };
    } else {
      return {
        verified: false,
        reason: response.data.reason || 'Document verification failed',
        verificationId: response.data.verificationId,
        timestamp: new Date().toISOString()
      };
    }
  } catch (error) {
    console.error('Error verifying with DVS:', error);
    
    // Simulate success for development environments
    if (process.env.ENVIRONMENT === 'dev') {
      console.log('Development environment - simulating successful verification');
      return {
        verified: true,
        verificationId: 'dev-' + Date.now(),
        timestamp: new Date().toISOString(),
        simulated: true
      };
    }
    
    return {
      verified: false,
      reason: `Document verification service error: ${error.message}`,
      timestamp: new Date().toISOString()
    };
  }
}

function extractFamilyName(fullName) {
  if (!fullName) return '';
  
  const parts = fullName.trim().split(' ');
  return parts.length > 1 ? parts[parts.length - 1] : fullName;
}

function extractGivenNames(fullName) {
  if (!fullName) return '';
  
  const parts = fullName.trim().split(' ');
  return parts.length > 1 ? parts.slice(0, -1).join(' ') : '';
}

function extractLicenseState(address) {
  if (!address) return null;
  
  // Simple pattern matching for Australian states
  const statePatterns = {
    'NSW': /new south wales|nsw/i,
    'VIC': /victoria|vic/i,
    'QLD': /queensland|qld/i,
    'SA': /south australia|sa/i,
    'WA': /western australia|wa/i,
    'TAS': /tasmania|tas/i,
    'NT': /northern territory|nt/i,
    'ACT': /australian capital territory|act/i
  };
  
  for (const [state, pattern] of Object.entries(statePatterns)) {
    if (pattern.test(address)) {
      return state;
    }
  }
  
  return null;
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
      updateExpression += `, id_verification.${key} = :val${index}`;
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