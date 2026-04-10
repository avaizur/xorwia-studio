#!/bin/bash
# 🚀 Nova AI Studio - EC2 Setup Script
# Run this once on your Ubuntu EC2 at 3.8.206.166

echo "📡 Updating server and installing dependencies..."
sudo apt update && sudo apt upgrade -y
sudo apt install -y nodejs npm ffmpeg nginx git

# 1. Install Global dependencies (pm2 for process management)
echo "🚀 Installing pm2 for process management..."
sudo npm install -g pm2

# 2. Configure Nginx Reverse Proxy
echo "🎨 Configuring Nginx for xorwia.com..."
NGINX_CONF="/etc/nginx/sites-available/nova-studio"
cat <<EOF | sudo tee $NGINX_CONF
server {
    listen 80;
    server_name xorwia.com www.xorwia.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
    }
}
EOF

# Enable Nginx config and restart
sudo ln -sf $NGINX_CONF /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl restart nginx

# 3. Finalize
echo "✅ Nginx is now proxying port 80 to 3000."
echo "✅ Note: Root domain xorwia.com must point to 3.8.206.166 in Route 53."
echo "✅ FFmpeg, Node.js and PM2 are ready. Now run '.\Deploy-To-EC2.ps1' locally."
echo "--------------------------------------------------------"
echo "💡 PRO TIP: To enable SSL (HTTPS) later, run:"
echo "   sudo apt install -y certbot python3-certbot-nginx"
echo "   sudo certbot --nginx -d xorwia.com -d www.xorwia.com"
echo "--------------------------------------------------------"
