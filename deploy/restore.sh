#!/usr/bin/env bash
set -euo pipefail
export MSYS_NO_PATHCONV=1

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"
ENV_FILE="${ENV_FILE:-.env.production}"
COMPOSE_FILE="docker-compose.prod.yml"
DRILL_DB="resihub_restore_drill"

usage() {
  cat <<EOF
Cách dùng:
  $0 --verify-only [duong_dan_db_dump]
      Diễn tập khôi phục an toàn trên CSDL nháp '${DRILL_DB}', kiểm đếm dữ liệu rồi tự dọn sạch.

  $0 --apply <duong_dan_db_dump> [duong_dan_uploads_tar_gz]
      Khôi phục thực tế vào CSDL Production (yêu cầu xác nhận 'KHOI_PHUC_PRODUCTION').
EOF
}

if [ $# -lt 1 ]; then
  usage
  exit 1
fi

if [ ! -f "${ENV_FILE}" ]; then
  echo "[Restore] LỖI: Không tìm thấy tệp cấu hình ${ENV_FILE}" >&2
  exit 1
fi

MODE="$1"
shift

compose_cmd() {
  docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" "$@"
}

if [ "${MODE}" = "--verify-only" ]; then
  DUMP_FILE="${1:-}"
  if [ -z "${DUMP_FILE}" ]; then
    DUMP_FILE="$(ls -1t backups/db_*.dump 2>/dev/null | head -n 1 || true)"
  fi

  if [ -z "${DUMP_FILE}" ] || [ ! -s "${DUMP_FILE}" ]; then
    echo "[Restore Drill] LỖI: Không tìm thấy bản sao lưu db_*.dump hợp lệ." >&2
    exit 1
  fi

  cleanup_drill() {
    compose_cmd exec -T backup psql -v ON_ERROR_STOP=1 -d postgres \
      -c "DROP DATABASE IF EXISTS ${DRILL_DB} WITH (FORCE);" >/dev/null 2>&1 || true
  }
  trap cleanup_drill EXIT

  echo "[Restore Drill] Bắt đầu diễn tập khôi phục từ: ${DUMP_FILE}"
  compose_cmd exec -T backup psql -v ON_ERROR_STOP=1 -d postgres \
    -c "DROP DATABASE IF EXISTS ${DRILL_DB} WITH (FORCE);" >/dev/null
  compose_cmd exec -T backup psql -v ON_ERROR_STOP=1 -d postgres \
    -c "CREATE DATABASE ${DRILL_DB};" >/dev/null

  compose_cmd exec -T backup pg_restore --no-owner --no-privileges -d "${DRILL_DB}" < "${DUMP_FILE}"

  echo "=================================================================="
  echo "  BIÊN BẢN DIỄN TẬP KHÔI PHỤC (NFR-006) — $(date -Iseconds)"
  echo "  Tệp kiểm tra: $(basename "${DUMP_FILE}")"
  echo "=================================================================="
  compose_cmd exec -T backup psql -v ON_ERROR_STOP=1 -d "${DRILL_DB}" -c "
    SELECT 'organization' AS table_name, COUNT(*)::bigint AS row_count FROM organization
    UNION ALL SELECT 'role', COUNT(*)::bigint FROM role
    UNION ALL SELECT 'app_user', COUNT(*)::bigint FROM app_user
    UNION ALL SELECT 'building', COUNT(*)::bigint FROM building
    UNION ALL SELECT 'apartment', COUNT(*)::bigint FROM apartment
    UNION ALL SELECT 'contract', COUNT(*)::bigint FROM contract
    UNION ALL SELECT 'invoice', COUNT(*)::bigint FROM invoice;
  "
  echo "[Restore Drill] Hoàn tất kiểm chứng và tự động dọn CSDL nháp '${DRILL_DB}'."
  exit 0
fi

if [ "${MODE}" = "--apply" ]; then
  DUMP_FILE="${1:-}"
  UPLOADS_TAR="${2:-}"

  if [ -z "${DUMP_FILE}" ] || [ ! -s "${DUMP_FILE}" ]; then
    echo "[Restore Apply] LỖI: Vui lòng truyền đường dẫn tệp db_*.dump hợp lệ." >&2
    usage
    exit 1
  fi

  if [ -n "${UPLOADS_TAR}" ] && [ ! -f "${UPLOADS_TAR}" ]; then
    echo "[Restore Apply] LỖI: Không tìm thấy tệp đính kèm ${UPLOADS_TAR}." >&2
    exit 1
  fi

  echo "=================================================================="
  echo "  CẢNH BÁO ĐỎ: KHÔI PHỤC DỮ LIỆU TRỰC TIẾP LÊN PRODUCTION"
  echo "  Tệp CSDL   : ${DUMP_FILE}"
  echo "  Tệp Uploads: ${UPLOADS_TAR:-(giữ nguyên)}"
  echo "=================================================================="
  read -r -p "Gõ chính xác KHOI_PHUC_PRODUCTION để xác nhận: " CONFIRM
  if [ "${CONFIRM}" != "KHOI_PHUC_PRODUCTION" ]; then
    echo "[Restore Apply] Đã hủy thao tác khôi phục."
    exit 1
  fi

  echo "[Restore Apply] Tạm dừng api và worker..."
  compose_cmd stop api worker

  TARGET_DB="$(compose_cmd exec -T backup sh -c 'printf "%s" "$PGDATABASE"')"
  echo "[Restore Apply] Ngắt các kết nối cũ tới CSDL '${TARGET_DB}'..."
  compose_cmd exec -T backup psql -v ON_ERROR_STOP=1 -d postgres \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TARGET_DB}' AND pid <> pg_backend_pid();" >/dev/null

  echo "[Restore Apply] Đang nạp lại CSDL từ bản sao lưu..."
  compose_cmd exec -T backup pg_restore --clean --if-exists --no-owner --no-privileges -d "${TARGET_DB}" < "${DUMP_FILE}"

  # Đánh dấu chạy lại phân quyền RLS (005, 007) vì pg_dump dùng --no-acl
  compose_cmd exec -T backup psql -v ON_ERROR_STOP=1 -d "${TARGET_DB}" \
    -c "DELETE FROM schema_migrations WHERE version IN ('005_rls_enable_and_policies.sql', '007_grants.sql');" >/dev/null 2>&1 || true

  if [ -n "${UPLOADS_TAR}" ]; then
    echo "[Restore Apply] Đang khôi phục tệp đính kèm vào volume api_uploads..."
    compose_cmd run --rm --no-deps --entrypoint /bin/sh api \
      -c "mkdir -p /app/uploads && find /app/uploads -mindepth 1 -delete && tar -xzf - -C /app/uploads && chown -R node:node /app/uploads" < "${UPLOADS_TAR}"
  fi

  echo "[Restore Apply] Khởi động lại api và worker (tự động đồng bộ RLS & mật khẩu resihub_app)..."
  compose_cmd start api worker
  echo "[Restore Apply] Khôi phục hoàn tất thành công!"
  exit 0
fi

usage
exit 1

