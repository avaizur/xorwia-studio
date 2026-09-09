# 🚀 XORWIA STUDIO | CI/CD Unified Deployment Script
# Usage:
#   .\deploy_xorwia.ps1 -Target blue  # Staging: Packages, publishes new version, and updates ONLY alias 'blue'
#   .\deploy_xorwia.ps1 -Target live  # Production: Promotes current version on 'blue' to alias 'live' without publishing new code

param (
    [Parameter(Mandatory=$true)]
    [ValidateSet("blue", "live")]
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

if ($Target -eq "blue") {
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

    if ($LASTEXITCODE -ne 0 -or -not $deployResult) {
        Write-Error "Failed to upload function code and publish new version."
        exit 1
    }

    $deployedVersion = ($deployResult | Out-String | ConvertFrom-Json).Version
    if (-not $deployedVersion) {
        Write-Error "Failed to parse published version from AWS Lambda response."
        exit 1
    }
    Write-Host "✅ Version $deployedVersion Published." -ForegroundColor Green

    # 4. ALIAS MAPPING: Update ONLY blue
    Write-Host "[3/4] Mapping BLUE (Staging) to Version $deployedVersion..."
    aws lambda update-alias --function-name $FUNCTION_NAME --name blue --function-version $deployedVersion --region $REGION
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to update alias 'blue' to version $deployedVersion."
        exit 1
    }

    # 5. CLEANUP
    Write-Host "[4/4] Cleaning up artifacts..."
    # Remove-Item $ZIP_PATH
} else {
    # Target is 'live': Promotion track (no packaging, no new version published)
    Write-Host "[1/2] Fetching active version from alias 'blue'..."
    $blueAliasJson = aws lambda get-alias --function-name $FUNCTION_NAME --name blue --region $REGION
    if ($LASTEXITCODE -ne 0 -or -not $blueAliasJson) {
        Write-Error "Failed to fetch alias 'blue' from AWS Lambda."
        exit 1
    }

    $deployedVersion = ($blueAliasJson | Out-String | ConvertFrom-Json).FunctionVersion
    if (-not $deployedVersion) {
        Write-Error "Failed to resolve FunctionVersion from alias 'blue'."
        exit 1
    }
    Write-Host "ℹ️ Alias 'blue' is currently pointing to Version $deployedVersion." -ForegroundColor Cyan

    # ALIAS MAPPING: Update ONLY live to the exact version tested on blue
    Write-Host "[2/2] Mapping LIVE (Production) to Version $deployedVersion..."
    aws lambda update-alias --function-name $FUNCTION_NAME --name live --function-version $deployedVersion --region $REGION
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to promote alias 'live' to version $deployedVersion."
        exit 1
    }
}

Write-Host "`n🎉 XORWIA STUDIO DEPLOYMENT SUCCESSFUL!" -ForegroundColor Green
Write-Host "Target: $($Target.ToUpper())" -ForegroundColor Cyan
Write-Host "Version: $deployedVersion" -ForegroundColor Cyan
