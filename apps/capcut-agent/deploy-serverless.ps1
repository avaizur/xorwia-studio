$ACCOUNT_ID = "659705192571"
$REGION = "us-east-1"
$REPO_NAME = "nova-capcut-agent"
$LAMBDA_NAME = "nova-ai-doc-analyzer"
$ROLE_NAME = "NovaLambdaExecutionRole"
$ECR_REGISTRY = "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
$IMAGE_URI = "${ECR_REGISTRY}/${REPO_NAME}:latest"

Write-Host "--- [AI-DOC SERVERLESS DEPLOYMENT] ---" -ForegroundColor Cyan

# 1. Authenticate Podman
Write-Host "[1/6] Authenticating Podman with AWS ECR ($REGION)..."
$password = aws ecr get-login-password --region $REGION
$password | podman login --username AWS --password-stdin $ECR_REGISTRY

# 2. Build & Push
Write-Host "[2/6] Building & Pushing Container Image..."
podman build -t $REPO_NAME .
podman tag "${REPO_NAME}:latest" $IMAGE_URI
podman push $IMAGE_URI

# 3. Ensure IAM Role Exists
Write-Host "[3/6] Checking IAM Role: $ROLE_NAME..."
$roleExists = aws iam get-role --role-name $ROLE_NAME 2>$null
if (-not $roleExists) {
    Write-Host "Creating IAM Role..."
    $trustPolicy = '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
    aws iam create-role --role-name $ROLE_NAME --assume-role-policy-document "$trustPolicy"
    aws iam attach-role-policy --role-name $ROLE_NAME --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
    aws iam attach-role-policy --role-name $ROLE_NAME --policy-arn "arn:aws:iam::aws:policy/AmazonS3FullAccess"
    aws iam attach-role-policy --role-name $ROLE_NAME --policy-arn "arn:aws:iam::aws:policy/AmazonBedrockFullAccess"
    Start-Sleep -Seconds 10 # Wait for IAM replication
}

# 4. Create or Update Lambda Function
Write-Host "[4/6] Updating Lambda Function: $LAMBDA_NAME..."
$fnExists = aws lambda get-function --function-name $LAMBDA_NAME --region $REGION 2>$null
if (-not $fnExists) {
    Write-Host "Creating new Lambda function..."
    aws lambda create-function `
        --function-name $LAMBDA_NAME `
        --package-type Image `
        --code ImageUri=$IMAGE_URI `
        --role "arn:aws:iam::$ACCOUNT_ID:role/$ROLE_NAME" `
        --timeout 60 `
        --memory-size 1024 `
        --region $REGION
} else {
    Write-Host "Updating existing Lambda function code..."
    aws lambda update-function-code `
        --function-name $LAMBDA_NAME `
        --image-uri $IMAGE_URI `
        --region $REGION
}

# 5. Enable Lambda Function URL (Cost-effective alternative to API Gateway)
Write-Host "[5/6] Ensuring Function URL is enabled..."
aws lambda create-function-url-config `
    --function-name $LAMBDA_NAME `
    --auth-type NONE `
    --region $REGION 2>$null

aws lambda add-permission `
    --function-name $LAMBDA_NAME `
    --action lambda:InvokeFunctionUrl `
    --principal "*" `
    --function-url-auth-type NONE `
    --statement-id PublicAccess 2>$null

# 6. Final Status
$url = aws lambda get-function-url-config --function-name $LAMBDA_NAME --region $REGION --query "FunctionUrl" --output text
Write-Host "✅ DEPLOYMENT SUCCESSFUL!" -ForegroundColor Green
Write-Host "Your Serverless AI-Doc Analyzer is LIVE at:" -ForegroundColor Cyan
Write-Host $url
