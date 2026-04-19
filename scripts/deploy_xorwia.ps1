# 🚀 XORWIA STUDIO | CI/CD Unified Deployment Script
# Usage: .\deploy_xorwia.ps1 -Target [green|blue]

param (
    [Parameter(Mandatory=$true)]
    [ValidateSet("green", "blue")]
    [string]$Target
)

$FUNCTION_NAME = "xorwia-nova-backend"
$REGION = "eu-west-2"
$APPS_DIR = "apps"
$ZIP_NAME = "xorwia_studio_final.zip"
$ZIP_PATH = Join-Path $APPS_DIR $ZIP_NAME

Write-Host "--- [XORWIA CI/CD GOVERNANCE CHECK] ---" -ForegroundColor Cyan

# 1. DRIFT PROTECTION: Check for forbidden root-level web directory
if (Test-Path "web") {
    Write-Error "CRITICAL ERROR: Forbidden root-level 'web/' directory detected. Please delete it and use 'apps/web/' as the single source of truth."
    exit 1
}

# 2. PACKAGING: Ensure only 'apps' is included
Write-Host "[1/4] Packaging apps/ content into $ZIP_NAME..."
if (Test-Path $ZIP_PATH) { Remove-Item $ZIP_PATH }

# Use tar for speed and precision
tar -ac -f $ZIP_PATH -C $APPS_DIR server.js package.json agent web node_modules

if (-not (Test-Path $ZIP_PATH)) {
    Write-Error "Packaging failed."
    exit 1
}

# 3. AWS UPLOAD & PUBLISH
Write-Host "[2/4] Uploading to AWS Lambda & Publishing New Version..."
$deployResult = aws lambda update-function-code `
    --function-name $FUNCTION_NAME `
    --zip-file "fileb://$ZIP_PATH" `
    --region $REGION `
    --publish

$newVersion = ($deployResult | ConvertFrom-Json).Version
Write-Host "✅ Version $newVersion Published." -ForegroundColor Green

# 4. ALIAS MAPPING
if ($Target -eq "green") {
    Write-Host "[3/4] Mapping GREEN (Staging) to Version $newVersion..."
    aws lambda update-alias --function-name $FUNCTION_NAME --name green --function-version $newVersion --region $REGION
} else {
    Write-Host "[3/4] Mapping BLUE/LIVE (Production) to Version $newVersion..."
    # Atomic switch for all production aliases
    aws lambda update-alias --function-name $FUNCTION_NAME --name live --function-version $newVersion --region $REGION
    aws lambda update-alias --function-name $FUNCTION_NAME --name blue --function-version $newVersion --region $REGION
}

# 5. CLEANUP
Write-Host "[4/4] Cleaning up artifacts..."
# Remove-Item $ZIP_PATH

Write-Host "`n🎉 XORWIA STUDIO DEPLOYMENT SUCCESSFUL!" -ForegroundColor Green
Write-Host "Target: $($Target.ToUpper())" -ForegroundColor Cyan
Write-Host "Version: $newVersion" -ForegroundColor Cyan
