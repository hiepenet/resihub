#!/bin/sh
set -eu

TS=$(date +%Y%m%d_%H%M%S)
DB_FILE="/backups/db_${TS}.dump"
UP_FILE="/backups/uploads_${TS}.tar.gz"
RETENTION="${BACKUP_RETENTION_DAYS:-30}"

mkdir -p /backups
echo "[Backup] Starting PostgreSQL dump -> ${DB_FILE}"
pg_dump -Fc --no-owner --no-acl -f "${DB_FILE}" "${PGDATABASE}"

if [ ! -s "${DB_FILE}" ]; then
  echo "[Backup] ERROR: Dump file is empty!" >&2
  rm -f "${DB_FILE}"
  exit 1
fi

echo "[Backup] Archiving uploads -> ${UP_FILE}"
tar -czf "${UP_FILE}" -C /uploads .

find /backups -type f \( -name "db_*.dump" -o -name "uploads_*.tar.gz" \) -mtime +"${RETENTION}" -delete
echo "[Backup] Completed successfully at $(date -Iseconds)."
