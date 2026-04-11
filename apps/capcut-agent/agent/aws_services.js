const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const fs = require('fs');

// Initialize AWS Clients
const REGION = process.env.AWS_REGION || 'us-east-1';
const BUCKET_NAME = process.env.AWS_S3_BUCKET || 'xorwia-studio-clips';

const s3Client = new S3Client({ region: REGION });
const bedrockClient = new BedrockRuntimeClient({ region: REGION });

/**
 * Uploads a local file to S3 and returns a temporary presigned download URL.
 */
async function uploadToS3AndGetUrl(filePath, fileName) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }

    try {
        console.log(`[AWS] Uploading ${fileName} to S3 bucket ${BUCKET_NAME}...`);
        const fileStream = fs.createReadStream(filePath);

        const uploadParams = {
            Bucket: BUCKET_NAME,
            Key: `clips/${fileName}`,
            Body: fileStream,
            ContentType: 'video/mp4'
        };

        const command = new PutObjectCommand(uploadParams);
        await s3Client.send(command);

        console.log(`[AWS] Generating presigned URL for ${fileName}...`);
        const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
        
        return presignedUrl;
    } catch (error) {
        console.error('[AWS S3 Error]', error);
        throw new Error('Failed to upload video: ' + error.message);
    }
}

/**
 * Uses Amazon Bedrock to analyze a video transcript.
 */
async function analyzeTranscriptWithBedrock(transcriptText) {
    console.log(`[AWS] Analyzing transcript with Bedrock...`);
    
    const prompt = `You are an expert social media content analyzer. Read this transcript and identify the 3 best "hooks" for vertical clips.
    
Transcript: ${transcriptText}

Format your response as a JSON array of objects with: "time"(int), "reason", "tag". Return ONLY valid JSON.`;

    try {
        const payload = {
            anthropic_version: "bedrock-2023-05-31",
            max_tokens: 1000,
            temperature: 0.7,
            messages: [{ role: "user", content: prompt }]
        };

        const command = new InvokeModelCommand({
            modelId: "anthropic.claude-3-haiku-20240307-v1:0",
            contentType: "application/json",
            accept: "application/json",
            body: JSON.stringify(payload)
        });

        const response = await bedrockClient.send(command);
        const decodedResponse = new TextDecoder().decode(response.body);
        
        let jsonResponse;
        try {
            jsonResponse = JSON.parse(decodedResponse);
        } catch (parseError) {
            console.error('[AWS Bedrock Parse Error]', decodedResponse);
            throw new Error(`Invalid JSON response from Bedrock: ${decodedResponse.substring(0, 100)}`);
        }

        const contentText = jsonResponse.content[0].text;
        const jsonMatch = contentText.match(/\[[\s\S]*\]/);
        return jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    } catch (error) {
        console.error('[AWS Bedrock Error]', error);
        // Show specific AWS error if possible
        const errorMsg = error.message || error.toString();
        return [{ time: 0, reason: `AWS Error: ${errorMsg}`, tag: "System" }];
    }
}

/**
 * NEW: Uses Amazon Bedrock to analyze code and suggest a fix.
 */
async function debugCodeWithBedrock(errorCode) {
    console.log(`[AWS TraceFix] Debugging code with Bedrock...`);
    
    const prompt = `You are an elite software engineer. Analyze this code, find the bug, and provide a fix.
    
Code:
${errorCode}

Format your response as a JSON object with:
- "issue" (1-sentence description)
- "fix" (complete fixed code)
- "explanation" (what was wrong)
Return ONLY valid JSON.`;

    try {
        const payload = {
            anthropic_version: "bedrock-2023-05-31",
            max_tokens: 2000,
            temperature: 0.2, // Consistent results for code
            messages: [{ role: "user", content: prompt }]
        };

        const command = new InvokeModelCommand({
            modelId: "anthropic.claude-3-haiku-20240307-v1:0",
            contentType: "application/json",
            accept: "application/json",
            body: JSON.stringify(payload)
        });

        const response = await bedrockClient.send(command);
        const decodedResponse = new TextDecoder().decode(response.body);
        
        let jsonResponse;
        try {
            jsonResponse = JSON.parse(decodedResponse);
        } catch (parseError) {
            console.error('[AWS Bedrock Debug Parse Error]', decodedResponse);
            throw new Error(`Invalid JSON response from Bedrock Debug: ${decodedResponse.substring(0, 100)}`);
        }

        const contentText = jsonResponse.content[0].text;
        const jsonMatch = contentText.match(/\{[\s\S]*\}/);
        return jsonMatch ? JSON.parse(jsonMatch[0]) : { issue: "Failed to parse AI output." };
    } catch (error) {
        console.error('[AWS Bedrock Debug Error]', error);
        return { 
            issue: "AI Service Offline", 
            fix: errorCode, 
            explanation: `AWS System Message: ${error.message || 'Unknown Error'}. Ensure Claude 3 Haiku access is enabled in us-east-1.`
        };
    }
}

module.exports = {
    uploadToS3AndGetUrl,
    analyzeTranscriptWithBedrock,
    debugCodeWithBedrock
};
