#!/bin/bash
# 🛠️ Fix Nginx Routing and SSL for Nova Studio

echo "🚀 Removing default Nginx config..."
sudo rm -f /etc/nginx/sites-enabled/default

echo "🎨 Creating Nova Studio config..."
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

echo "🔗 Enabling config..."
sudo ln -sf $NGINX_CONF /etc/nginx/sites-enabled/

echo "🧪 Testing Nginx config..."
sudo nginx -t

if [ $? -eq 0 ]; then
    echo "✅ Success! Restarting Nginx..."
    sudo systemctl restart nginx
else
    echo "❌ Nginx test failed. Check the config."
    exit 1
fi

# Try to install SSL (Certbot) if not already active
if ! command -v certbot &> /dev/null; then
    echo "🔒 Installing Certbot..."
    sudo apt update
    sudo apt install -y certbot python3-certbot-nginx
fi

echo "🛡️ Requesting SSL Certificate (HTTPS) via Certbot..."
# Non-interactive mode (requires email)
# Note: This might fail if the user's domain isn't fully propagated yet
sudo certbot --nginx -d xorwia.com -d www.xorwia.com --non-interactive --agree-tos --register-unsafely-without-email || true

echo "✨ All Done! Check http://xorwia.com (and https if Certbot succeeded)"
