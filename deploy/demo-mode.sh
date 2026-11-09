#!/usr/bin/env bash
# ==============================================================================
# ResiHub — Bật / Tắt tức thì Giao diện Demo & OTP Demo trên VPS (~2 giây)
# Không cần build lại Frontend (web)
# Cách dùng:
#   ./deploy/demo-mode.sh on [--seed]
#   ./deploy/demo-mode.sh off
#   ./deploy/demo-mode.sh status
# ==============================================================================
set -euo pipefail
export MSYS_NO_PATHCONV=1

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env.production}"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.prod.yml"

usage() {
  cat <<EOF
Cách dùng:
  $0 on [--seed]   Bật khung Tài khoản Demo trên trang /login & OTP_DEMO_MODE (~2 giây).
                   Thêm --seed nếu muốn nạp bộ dữ liệu mẫu Vinhomes Ocean Park (xóa dữ liệu hiện tại).
  $0 off           Tắt khung Tài khoản Demo & OTP_DEMO_MODE ngay lập tức (~2 giây).
  $0 status        Kiểm tra trạng thái cấu hình Demo hiện tại trên máy chủ.
EOF
}

if [ $# -lt 1 ]; then
  usage
  exit 1
fi

if [ ! -f "${ENV_FILE}" ]; then
  echo "[Demo Mode] LỖI: Không tìm thấy tệp cấu hình ${ENV_FILE}" >&2
  exit 1
fi

ACTION="$1"
shift

compose_cmd() {
  docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" "$@"
}

set_env_var() {
  local key="$1"
  local val="$2"
  local file="$3"
  local tmp="${file}.tmp.$$"
  awk -v k="${key}" -v v="${val}" '
    BEGIN { found = 0 }
    $0 ~ ("^[[:space:]]*" k "=") {
      print k "=" v
      found = 1
      next
    }
    { print }
    END {
      if (!found) print k "=" v
    }
  ' "${file}" | tr -d '\r' > "${tmp}"
  mv "${tmp}" "${file}"
}

get_env_var() {
  local key="$1"
  local default_val="$2"
  local val
  val="$(grep -E "^[[:space:]]*${key}=" "${ENV_FILE}" | tail -n 1 | cut -d'=' -f2- | tr -d '\r"' || true)"
  if [ -z "${val}" ]; then
    printf "%s" "${default_val}"
  else
    printf "%s" "${val}"
  fi
}

wait_for_api_ready() {
  for _ in $(seq 1 20); do
    if compose_cmd exec -T api wget -qO- http://127.0.0.1:5000/api/health >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

case "${ACTION}" in
  on)
    DO_SEED="false"
    AUTO_YES="false"
    for arg in "$@"; do
      case "${arg}" in
        --seed) DO_SEED="true" ;;
        --yes|-y) AUTO_YES="true" ;;
        *)
          echo "[Demo Mode] Tham số không hợp lệ: ${arg}" >&2
          usage
          exit 1
          ;;
      esac
    done

    set_env_var "SHOW_DEMO_ACCOUNTS" "true" "${ENV_FILE}"
    set_env_var "OTP_DEMO_MODE" "true" "${ENV_FILE}"

    echo "[Demo Mode] Đang cập nhật container api (không cần build lại web)..."
    compose_cmd up -d api
    wait_for_api_ready || true

    if [ "${DO_SEED}" = "true" ]; then
      if [ "${AUTO_YES}" != "true" ]; then
        echo "=================================================================="
        echo "  CẢNH BÁO: --seed sẽ XÓA TOÀN BỘ dữ liệu hiện có trong CSDL"
        echo "  để nạp bộ dữ liệu mẫu Vinhomes Ocean Park 1, 2, 3 (240 căn hộ)."
        echo "=================================================================="
        read -r -p "Gõ XAC_NHAN_SEED_DEMO để tiếp tục: " CONFIRM
        if [ "${CONFIRM}" != "XAC_NHAN_SEED_DEMO" ]; then
          echo "[Demo Mode] Đã bỏ qua nạp dữ liệu mẫu (giao diện Demo vẫn được bật)."
          exit 0
        fi
      fi
      echo "[Demo Mode] Đang nạp dữ liệu mẫu Vinhomes Ocean Park..."
      compose_cmd exec -T api node src/db/seed_vinhomes.js
      echo "[Demo Mode] Đồng bộ lại quyền và mật khẩu resihub_app..."
      compose_cmd exec -T api node src/db/bootstrapProd.js
    fi

    echo "[Demo Mode] ĐÃ BẬT chế độ Demo thành công:"
    compose_cmd exec -T api wget -qO- http://127.0.0.1:5000/api/v1/auth/public-config || true
    echo ""
    ;;

  off)
    set_env_var "SHOW_DEMO_ACCOUNTS" "false" "${ENV_FILE}"
    set_env_var "OTP_DEMO_MODE" "false" "${ENV_FILE}"

    echo "[Demo Mode] Đang tắt giao diện Demo trên container api..."
    compose_cmd up -d api
    wait_for_api_ready || true

    echo "[Demo Mode] ĐÃ TẮT chế độ Demo thành công:"
    compose_cmd exec -T api wget -qO- http://127.0.0.1:5000/api/v1/auth/public-config || true
    echo ""
    ;;

  status)
    echo "=================================================================="
    echo "  TRẠNG THÁI CHẾ ĐỘ DEMO TRÊN VPS"
    echo "=================================================================="
    echo "  SHOW_DEMO_ACCOUNTS      = $(get_env_var SHOW_DEMO_ACCOUNTS false)"
    echo "  OTP_DEMO_MODE           = $(get_env_var OTP_DEMO_MODE false)"
    echo "  SEED_DEMO_ON_FIRST_BOOT = $(get_env_var SEED_DEMO_ON_FIRST_BOOT false)"
    echo -n "  API /public-config      = "
    compose_cmd exec -T api wget -qO- http://127.0.0.1:5000/api/v1/auth/public-config 2>/dev/null || echo "(container api chưa chạy)"
    echo ""
    ;;

  *)
    usage
    exit 1
    ;;
esac
