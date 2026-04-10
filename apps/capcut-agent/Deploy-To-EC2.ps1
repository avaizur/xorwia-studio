# Nova AI Studio - EC2 Deployment Script
# Pushes everything to your server
# Uses Key: Runway_DevOps_Project_Key.pem

$SERVER_IP = "18.175.57.184"
$KEY_PATH = "C:\Users\aahmad56\Downloads\aws-keys\aws-proj-17326.pem"
$LOCAL_FOLDER = "C:\Users\aahmad56\.gemini\antigravity\scratch\nova-ai-studio\apps\capcut-agent\*"
$REMOTE_DEST = "/home/ec2-user/nova-studios/apps/capcut-agent/"

Write-Host "Connecting to Nova Cloud Agent on EC2 (xorwia.com)..." -ForegroundColor Cyan

# This uses SCP with your .pem key to push all files
scp -i "$KEY_PATH" -r "$LOCAL_FOLDER" "ec2-user@${SERVER_IP}:${REMOTE_DEST}"

Write-Host "Deployment Finished! Visit your Dashboard at http://xorwia.com" -ForegroundColor Green
