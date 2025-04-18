const AWS = require('aws-sdk');

// Initialize AWS services
const s3 = new AWS.S3();
const dynamoDB = new AWS.DynamoDB.DocumentClient();
const rekognition = new AWS.Rekognition();

// Environment variables
const S3_BUCKET = process.env.S3_BUCKET;
const ONBOARDING_TABLE = process.env.DYNAMODB_ONBOARDING_TABLE;

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
    
    if (!process.selfie) {
      throw new Error('No selfie has been uploaded for this process');
    }
    
    if (!process.id_document) {
      throw new Error('No ID document has been uploaded for this process');
    }
    
    // The selfie should have been uploaded to S3 during the API call
    // The S3 keys are typically structured as: {processId}/selfie and {processId}/id/{documentType}
    const selfieS3Key = `${processId}/selfie`;
    const idImageS3Key = `${processId}/id/${process.id_document.type}`;
    
    // 1. Check if the selfie contains a face
    const selfieAnalysis = await detectFacesInImage(selfieS3Key);
    
    if (!selfieAnalysis.faceDetected) {
      await updateProcessStatus(processId, 'BIOMETRIC_VERIFICATION_FAILED', {
        verification_status: 'FAILED',
        failure_reason: 'No face detected in selfie'
      });
      
      return {
        process_id: processId,
        verification: {
          biometric_verified: false
        },
        reason: 'No face detected in selfie'
      };
    }
    
    // 2. Extract face from ID document (if possible)
    const idFaceAnalysis = await detectFacesInImage(idImageS3Key);
    
    if (!idFaceAnalysis.faceDetected) {
      console.log('No face detected in ID document. Proceeding with additional checks.');
      // We can continue with other checks like liveness detection
    }
    
    // 3. Compare faces if both are available
    let faceMatchResult = { matched: false, similarity: 0 };
    
    if (selfieAnalysis.faceDetected && idFaceAnalysis.faceDetected) {
      faceMatchResult = await compareFaces(selfieS3Key, idImageS3Key);
      
      if (!faceMatchResult.matched) {
        await updateProcessStatus(processId, 'BIOMETRIC_VERIFICATION_FAILED', {
          verification_status: 'FAILED',
          failure_reason: 'Face in selfie does not match face in ID',
          face_match_similarity: faceMatchResult.similarity
        });
        
        return {
          process_id: processId,
          verification: {
            biometric_verified: false
          },
          reason: 'Face in selfie does not match face in ID',
          similarity: faceMatchResult.similarity
        };
      }
    }
    
    // 4. Perform liveness detection on the selfie
    const livenessResult = await performLivenessDetection(selfieS3Key);
    
    if (!livenessResult.isLive) {
      await updateProcessStatus(processId, 'BIOMETRIC_VERIFICATION_FAILED', {
        verification_status: 'FAILED',
        failure_reason: 'Liveness check failed',
        liveness_score: livenessResult.score
      });
      
      return {
        process_id: processId,
        verification: {
          biometric_verified: false
        },
        reason: 'Liveness check failed',
        liveness_score: livenessResult.score
      };
    }
    
    // 5. Update process with successful verification
    await updateProcessStatus(processId, 'BIOMETRIC_VERIFICATION_COMPLETE', {
      verification_status: 'VERIFIED',
      face_detected: selfieAnalysis.faceDetected,
      face_match: faceMatchResult,
      liveness_check: livenessResult
    });
    
    return {
      process_id: processId,
      verification: {
        biometric_verified: true
      },
      status: 'BIOMETRIC_VERIFICATION_COMPLETE'
    };
    
  } catch (error) {
    console.error('Error in biometric check:', error);
    
    // Update process with error if possible
    if (event.process_id) {
      await updateProcessStatus(event.process_id, 'BIOMETRIC_VERIFICATION_ERROR', {
        verification_status: 'ERROR',
        error_message: error.message
      });
    }
    
    return {
      process_id: event.process_id,
      verification: {
        biometric_verified: false
      },
      reason: error.message
    };
  }
};

async function detectFacesInImage(s3Key) {
  try {
    const params = {
      Image: {
        S3Object: {
          Bucket: S3_BUCKET,
          Name: s3Key
        }
      },
      Attributes: ['ALL']
    };
    
    const response = await rekognition.detectFaces(params).promise();
    console.log(`Detected ${response.FaceDetails.length} faces in image`);
    
    if (response.FaceDetails.length === 0) {
      return {
        faceDetected: false
      };
    }
    
    // Get details of the largest face (likely the main subject)
    const faceDetails = response.FaceDetails.sort((a, b) => 
      (b.BoundingBox.Width * b.BoundingBox.Height) - 
      (a.BoundingBox.Width * a.BoundingBox.Height)
    )[0];
    
    return {
      faceDetected: true,
      confidence: faceDetails.Confidence,
      boundingBox: faceDetails.BoundingBox,
      ageRange: faceDetails.AgeRange,
      gender: faceDetails.Gender,
      emotions: faceDetails.Emotions,
      quality: faceDetails.Quality
    };
  } catch (error) {
    console.error('Error detecting faces:', error);
    throw new Error(`Failed to detect faces in image: ${error.message}`);
  }
}

async function compareFaces(sourceImageS3Key, targetImageS3Key) {
  try {
    const params = {
      SourceImage: {
        S3Object: {
          Bucket: S3_BUCKET,
          Name: sourceImageS3Key
        }
      },
      TargetImage: {
        S3Object: {
          Bucket: S3_BUCKET,
          Name: targetImageS3Key
        }
      },
      SimilarityThreshold: 80.0 // Adjust threshold as needed
    };
    
    const response = await rekognition.compareFaces(params).promise();
    console.log('Face comparison response:', JSON.stringify(response, null, 2));
    
    if (response.FaceMatches.length === 0) {
      return {
        matched: false,
        similarity: 0
      };
    }
    
    // Get the highest similarity match
    const bestMatch = response.FaceMatches.sort((a, b) => 
      b.Similarity - a.Similarity
    )[0];
    
    return {
      matched: bestMatch.Similarity >= 80.0, // Same threshold as above
      similarity: bestMatch.Similarity,
      boundingBox: bestMatch.Face.BoundingBox,
      confidence: bestMatch.Face.Confidence
    };
  } catch (error) {
    console.error('Error comparing faces:', error);
    
    // For development environments, simulate a successful match
    if (process.env.ENVIRONMENT === 'dev') {
      console.log('Development environment - simulating successful face match');
      return {
        matched: true,
        similarity: 95.5,
        simulated: true
      };
    }
    
    throw new Error(`Failed to compare faces: ${error.message}`);
  }
}

async function performLivenessDetection(s3Key) {
  try {
    // Liveness detection would typically involve a specialized service
    // Here we're simulating it with basic face analysis from Rekognition
    const params = {
      Image: {
        S3Object: {
          Bucket: S3_BUCKET,
          Name: s3Key
        }
      },
      Attributes: ['ALL']
    };
    
    const response = await rekognition.detectFaces(params).promise();
    
    if (response.FaceDetails.length === 0) {
      return {
        isLive: false,
        score: 0
      };
    }
    
    const faceDetails = response.FaceDetails[0];
    
    // For a real implementation, you would use specialized liveness detection
    // Here we're using face quality metrics as a simple approximation
    const sharpness = faceDetails.Quality.Sharpness;
    const brightness = faceDetails.Quality.Brightness;
    
    // Calculate a simple "liveness score" based on image quality
    // This is a placeholder - real liveness detection is more sophisticated
    const livenessScore = (sharpness + brightness) / 2;
    
    // For development environments, always return success
    if (process.env.ENVIRONMENT === 'dev') {
      return {
        isLive: true,
        score: 90.0,
        simulated: true
      };
    }
    
    return {
      isLive: livenessScore >= 70.0, // Adjust threshold as needed
      score: livenessScore
    };
  } catch (error) {
    console.error('Error performing liveness detection:', error);
    
    // For development environments, simulate a successful liveness check
    if (process.env.ENVIRONMENT === 'dev') {
      console.log('Development environment - simulating successful liveness detection');
      return {
        isLive: true,
        score: 85.0,
        simulated: true
      };
    }
    
    throw new Error(`Failed to perform liveness detection: ${error.message}`);
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
      updateExpression += `, biometric_verification.${key} = :val${index}`;
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