# 🛰️ Xorwia Blue-Green Deployment Strategy

This policy ensures that the live production site (**Live**) is never touched directly and remains 100% stable while new features and fixes are tested in the **Blue** environment.

## 🏗️ The Infrastructure
- **Live (Production)**:
    - **URL**: `https://www.xorwia.com`
    - **Lambda Alias**: `live`
    - **Environment Variable**: `DEPLOY_ENV=green`
- **Blue (Staging/Check)**:
    - **URL**: `https://blue.xorwia.com` (or Lambda Test URL)
    - **Lambda Alias**: `blue`
    - **Environment Variable**: `DEPLOY_ENV=blue`

## 🔄 Deployment Policy

### 1. Development & Packaging
- All code changes are committed and packaged into a ZIP locally.
- Dependencies must be verified using `npm install` before zipping.
- Filesystem operations must use `/tmp` (already implemented in the 1.6.0 release).

### 2. Deploy to BLUE First
- **Action**: Upload the new ZIP to the AWS Lambda function and publish a new version via `.\scripts\deploy_xorwia.ps1 -Target blue`.
- **Pointer**: Update ONLY the `blue` alias to point to the new version.
- **Verification**: 
    - Check `/api/status` (verify it says `environment: blue`).
    - Test PayPal & Stripe checkout in Blue.
    - Test Clip Generation in Blue.

### 3. The Switchover (Blue ➡️ Live)
- Once Blue is confirmed 100% working:
- **Action**: Promote the tested version to production via `.\scripts\deploy_xorwia.ps1 -Target live`, which updates the `live` alias on AWS Lambda to point to the exact same version number currently identified as `blue` without publishing new code.
- **Result**: `www.xorwia.com` is now running the new code with zero downtime.

### 4. Rollback Plan
- If an issue is detected on Live after switchover:
- **Action**: Immediately update the `live` alias to point back to the previous stable version number.

## 🛡️ Stability Rules
1. **Never Deploy Directly to Live**: No manual "Copy-Paste" of code into the Lambda console for the production alias, and no publishing new code directly to `live`. All new code must be deployed to `blue` first and verified before promoting to `live`.
2. **Environment Isolation**: Live and Blue should ideally use separate API keys for Stripe/PayPal (Live vs Sandbox) controlled by environment variables.
3. **Stateless Logic**: All uploads and clips must be handled in `/tmp` or uploaded to S3 immediately to ensure Lambdas are interchangeable.

---
**Status**: 🟢 Policy Adopted | **Current Version**: 1.6.0 (Multi-Payment Edition)
