#!/usr/bin/env bash
# Cài Live View lên VPS Ubuntu chỉ bằng một lệnh:  sudo bash install.sh
# Script chỉ hỏi 4 thông tin, phần còn lại (Node.js, Nginx, SSL, chạy nền) tự làm.
set -euo pipefail

say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$1"; }
fail() { printf '\n\033[1;31mLỗi: %s\033[0m\n' "$1"; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Hãy chạy bằng quyền root: sudo bash install.sh"
command -v apt-get >/dev/null || fail "Script này dành cho Ubuntu/Debian."

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR=/opt/live-view-app

echo "Cài đặt Live View cho WooCommerce"
echo "---------------------------------"
read -rp "1. Địa chỉ web bán hàng (vd: shopcuaban.vn): " SITE
read -rp "2. Tên miền phụ cho Live View (vd: live.shopcuaban.vn): " DOMAIN
read -rp "3. Email của bạn (dùng để cấp chứng chỉ HTTPS): " EMAIL
while true; do
  read -rsp "4. Đặt mật khẩu đăng nhập Live View: " PASS; echo
  [ ${#PASS} -ge 8 ] && break
  echo "   Mật khẩu cần ít nhất 8 ký tự."
done
DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN%%/*}"
[ -n "$SITE" ] && [ -n "$DOMAIN" ] && [ -n "$EMAIL" ] || fail "Cần điền đủ 4 thông tin."

say "Kiểm tra tên miền $DOMAIN"
SERVER_IP="$(curl -4 -fsS https://api.ipify.org || true)"
DOMAIN_IP="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)"
if [ -z "$DOMAIN_IP" ]; then
  fail "Tên miền $DOMAIN chưa trỏ về đâu. Hãy tạo bản ghi A: $DOMAIN → ${SERVER_IP:-IP của VPS}, đợi vài phút rồi chạy lại."
elif [ -n "$SERVER_IP" ] && [ "$DOMAIN_IP" != "$SERVER_IP" ]; then
  echo "Cảnh báo: $DOMAIN đang trỏ về $DOMAIN_IP, còn IP của VPS là $SERVER_IP."
  echo "Nếu bạn dùng Cloudflare với đám mây màu cam, hãy tạm chuyển sang DNS only rồi chạy lại."
  read -rp "Vẫn tiếp tục? (y/N) " OK; [ "${OK:-n}" = "y" ] || exit 1
fi

say "Cài Nginx, Certbot"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx certbot python3-certbot-nginx curl ca-certificates >/dev/null

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  say "Cài Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
command -v pm2 >/dev/null || { say "Cài PM2"; npm install -g pm2 --silent >/dev/null; }

say "Chép app vào $APP_DIR"
mkdir -p "$APP_DIR"
if [ "$SRC_DIR" != "$APP_DIR" ]; then
  cp -r "$SRC_DIR"/server.js "$SRC_DIR"/package.json "$SRC_DIR"/public "$APP_DIR"/
fi

SECRET=""
[ -f "$APP_DIR/.env" ] && SECRET="$(grep -E '^WC_WEBHOOK_SECRET=' "$APP_DIR/.env" | cut -d= -f2- || true)"
[ -n "$SECRET" ] || SECRET="$(openssl rand -hex 24)"
cat > "$APP_DIR/.env" <<ENV
SITE_ORIGIN=$SITE
ADMIN_USER=admin
ADMIN_PASSWORD=$PASS
WC_WEBHOOK_SECRET=$SECRET
PORT=3000
TIMEZONE=Asia/Ho_Chi_Minh
TRUST_PROXY=1
ENV
chmod 600 "$APP_DIR/.env"

say "Chạy app nền bằng PM2"
cd "$APP_DIR"
pm2 delete live-view >/dev/null 2>&1 || true
pm2 start server.js --name live-view >/dev/null
pm2 save >/dev/null
pm2 startup systemd -u root --hp /root >/dev/null
sleep 2
curl -fsS http://127.0.0.1:3000/health >/dev/null || fail "App không khởi động được. Xem lỗi bằng: pm2 logs live-view"

say "Cấu hình Nginx"
cat > /etc/nginx/sites-available/live-view <<NGINX
server {
    listen 80;
    server_name $DOMAIN;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/live-view /etc/nginx/sites-enabled/live-view
nginx -t >/dev/null 2>&1 || fail "Cấu hình Nginx lỗi. Kiểm tra bằng: nginx -t"
systemctl reload nginx

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 'Nginx Full' >/dev/null
fi

say "Cấp chứng chỉ HTTPS"
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect >/dev/null \
  || fail "Không cấp được HTTPS. Kiểm tra tên miền đã trỏ đúng IP chưa, rồi chạy lại script."

printf '\n\033[1;32mXong!\033[0m\n\n'
echo "Mở trang này để kết nối web và xem Live View:"
echo "   https://$DOMAIN"
echo "   Tên đăng nhập: admin"
echo "   Mật khẩu: (mật khẩu bạn vừa đặt)"
echo
echo "Trang đó sẽ hiện sẵn đoạn mã cần dán vào web và thông tin webhook, kèm nút sao chép."
