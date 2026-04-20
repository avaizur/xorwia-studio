# Nova AI Studio - EC2 Deployment Script
# 🚀 Pushes everything to your server at 35.178.109.32
# Uses Key: Runway_DevOps_Project_Key.pem

$SERVER_IP = "35.178.109.32"
$KEY_PATH = "C:\Users\aahmad56\Downloads\Runway_DevOps_Project_Key.pem"
$LOCAL_FOLDER = "C:\Users\aahmad56\.gemini\antigravity\scratch\nova-ai-studio\apps\capcut-agent\*"
$REMOTE_DEST = "/home/ubuntu/nova-studios/apps/capcut-agent/"

Write-Host "📡 Connecting to Nova Cloud Agent on EC2..." -ForegroundColor Cyan

# This uses SCP with your .pem key to push all files
scp -i $KEY_PATH -r $LOCAL_FOLDER "ubuntu@$SERVER_IP`:$REMOTE_DEST"

Write-Host "✅ Deployment Finished! Please press Ctrl+F5 on your Dashboard at $SERVER_IP`:3000" -ForegroundColor Green
