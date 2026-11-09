#!/usr/bin/env bash
set -euo pipefail
export MSYS_NO_PATHCONV=1

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env.production}"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.prod.yml"

if [ ! -f "${ENV_FILE}" ]; then
  echo "[Backup] LỖI: Không tìm thấy tệp cấu hình ${ENV_FILE}" >&2
  exit 1
fi

mkdir -p "${ROOT_DIR}/backups"

echo "[Backup] Đang thực thi sao lưu qua container backup..."
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" \
  exec -T backup /bin/sh /usr/local/bin/backup-cron.sh

echo "[Backup] Danh sách tệp sao lưu gần nhất trong ${ROOT_DIR}/backups:"
ls -lh "${ROOT_DIR}/backups" | tail -n 5
