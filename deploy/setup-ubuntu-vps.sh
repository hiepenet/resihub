#!/usr/bin/env bash
# ==============================================================================
# ResiHub — Script Chuẩn Hóa Máy Chủ Ubuntu VPS (22.04 / 24.04 LTS)
# Chạy với quyền root: sudo bash deploy/setup-ubuntu-vps.sh
# An toàn 100% khi chạy lặp lại nhiều lần (Idempotent)
# ==============================================================================
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "[LỖI] Vui lòng chạy script bằng sudo hoặc user root: sudo bash deploy/setup-ubuntu-vps.sh" >&2
  exit 1
fi

if [ ! -f /etc/os-release ]; then
  echo "[LỖI] Không nhận diện được hệ điều hành (/etc/os-release không tồn tại)." >&2
  exit 1
fi

# shellcheck disable=SC1091
. /etc/os-release
if [ "${ID:-}" != "ubuntu" ]; then
  echo "[LỖI] Script này được thiết kế cho Ubuntu LTS (phát hiện: ${ID:-unknown})." >&2
  exit 1
fi

case "${VERSION_ID:-}" in
  22.04|24.04)
    echo "[1/5] Xác nhận hệ điều hành: Ubuntu ${VERSION_ID} LTS"
    ;;
  *)
    echo "[CẢNH BÁO] Phiên bản Ubuntu hiện tại là ${VERSION_ID:-unknown} (khuyến nghị 22.04 hoặc 24.04 LTS)."
    ;;
esac

echo "[2/5] Thiết lập múi giờ chuẩn Việt Nam (Asia/Ho_Chi_Minh)..."
timedatectl set-timezone Asia/Ho_Chi_Minh

echo "[3/5] Kiểm tra và cấu hình bộ nhớ ảo Swap (2GB chống tràn RAM khi build)..."
TOTAL_SWAP_MB="$(free -m | awk '/^Swap:/ {print $2}')"
if [ "${TOTAL_SWAP_MB:-0}" -lt 1024 ] && [ ! -f /swapfile ]; then
  echo "  -> Đang khởi tạo /swapfile dung lượng 2GB..."
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=progress
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  if ! grep -qE '^[[:space:]]*/swapfile[[:space:]]' /etc/fstab; then
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi
  echo "  -> Đã bật Swap 2GB thành công."
else
  echo "  -> Swap hiện tại (${TOTAL_SWAP_MB}MB) đã đạt yêu cầu, bỏ qua tạo mới."
fi

echo "[4/5] Cài đặt gói nền tảng và Docker Engine + Docker Compose v2 chính thức..."
apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates curl gnupg git ufw openssl

if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc

  ARCH="$(dpkg --print-architecture)"
  echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list

  apt-get update -y
  DEBIAN_FRONTEND=noninteractive apt-get install -y \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

systemctl enable --now docker

if [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != "root" ]; then
  usermod -aG docker "${SUDO_USER}" || true
  echo "  -> Đã thêm tài khoản '${SUDO_USER}' vào nhóm docker."
fi

echo "[5/5] Cấu hình tường lửa UFW (mở SSH, HTTP 80, HTTPS/HTTP3 443)..."
SSH_PORTS="22"
if command -v sshd >/dev/null 2>&1; then
  DETECTED_PORTS="$(sshd -T 2>/dev/null | awk '/^port / {print $2}' | tr '\n' ' ' || true)"
  if [ -n "${DETECTED_PORTS}" ]; then
    SSH_PORTS="22 ${DETECTED_PORTS}"
  fi
fi

ufw default deny incoming
ufw default allow outgoing
for p in ${SSH_PORTS}; do
  ufw allow "${p}/tcp" comment 'SSH access'
done
ufw allow 80/tcp comment 'HTTP Caddy'
ufw allow 443/tcp comment 'HTTPS Caddy'
ufw allow 443/udp comment 'HTTP3 QUIC Caddy'
ufw --force enable

echo ""
echo "=================================================================="
echo "  HOÀN TẤT CHUẨN HÓA MÁY CHỦ UBUNTU VPS CHO RESIHUB"
echo "=================================================================="
echo "  Docker      : $(docker --version)"
echo "  Compose     : $(docker compose version)"
echo "  Múi giờ     : $(timedatectl show -p Timezone --value)"
echo "  Bộ nhớ/Swap : $(free -h | awk '/^Mem:/ {printf "RAM %s", $2}') | $(free -h | awk '/^Swap:/ {printf "Swap %s", $2}')"
echo "------------------------------------------------------------------"
ufw status
echo "=================================================================="
echo "Bước tiếp theo:"
echo "  1. cp .env.production.example .env.production"
echo "  2. Điền các khóa mật khẩu (sinh bằng: openssl rand -hex 32)"
echo "  3. docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build"
