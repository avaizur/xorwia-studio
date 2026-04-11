# XORWIA STUDIO - AWS EC2 Deployment Script
# 🚀 Pushes everything to your live server at 18.169.74.216

$SERVER_IP = "18.169.74.216"
$KEY_PATH = "C:\Users\aahmad56\Downloads\Runway_DevOps_Project_Key.pem"
$LOCAL_ROOT = "C:\Users\aahmad56\.gemini\antigravity\scratch\nova-ai-studio\"
$REMOTE_DEST = "/home/ubuntu/xorwia-studio/"

Write-Host "📡 Connecting to XORWIA CLOUD on AWS..." -ForegroundColor Cyan

# 1. Push Apps (Backend)
scp -i $KEY_PATH -r "${LOCAL_ROOT}apps" "ubuntu@$SERVER_IP`:$REMOTE_DEST"

# 2. Push Web (Frontend)
scp -i $KEY_PATH -r "${LOCAL_ROOT}web" "ubuntu@$SERVER_IP`:$REMOTE_DEST"

Write-Host "✅ Deployment Finished! Visit https://xorwia.com and refresh." -ForegroundColor Green
