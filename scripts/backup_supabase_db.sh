#!/usr/bin/env bash
# Supabaseプロジェクト(camera-inventory-app)の日次DBバックアップ(2026-09-13新規)。
#
# 背景: このSupabaseプロジェクトは組織プランがFreeのため、Supabase側の自動バックアップ
# (Daily Backups)・Point-in-Time Recovery(PITR)のいずれも提供されない。誤操作やバグで
# データが失われた場合の復旧手段が無いため、VPS側でpg_dumpによる日次バックアップを構築した。
#
# 保存先: /opt/camera-inventory-app-src/backups/YYYY-MM-DD_HHMMSS.dump (pg_dumpカスタム形式、
# pg_restoreで復元可能)。保持期間はKEEP_DAYS日分(古いものは自動削除)。
#
# 注意: このSupabaseプロジェクトはcamera-inventory-appとebay-automation(マーケティング)の
# 両方が同じデータベースを使っているため、DB全体をダンプするこのスクリプトは両方のデータを
# バックアップ対象に含む(スキーマ・テーブルでの絞り込みは行わない)。
#
# cron実行例(毎日4:00、10分おきの他ジョブと重ならない時間帯):
#   0 4 * * * /opt/camera-inventory-app-src/scripts/backup_supabase_db.sh >> /opt/camera-inventory-app-src/logs/backup_supabase_db.log 2>&1
#
# 復元手順(参考、実行前に必ず内容を確認すること):
#   PGPASSWORD=<SUPABASE_DB_PASSWORD> /usr/lib/postgresql/17/bin/pg_restore \
#     -h <SUPABASE_DB_HOST> -p 5432 -U postgres -d postgres --clean --if-exists <dumpファイル>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$ROOT_DIR/.env"
BACKUP_DIR="$ROOT_DIR/backups"
PG_DUMP="/usr/lib/postgresql/17/bin/pg_dump"
KEEP_DAYS=30

if [ ! -f "$ENV_FILE" ]; then
  echo "[$(date -u +%FT%TZ)] .envが見つかりません: $ENV_FILE" >&2
  exit 1
fi

# .envから必要な値だけ読み込む(他の変数を汚さないよう、シェルにexportせず個別に抽出する)。
get_env() {
  grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2-
}

DB_HOST="$(get_env SUPABASE_DB_HOST)"
DB_PORT="$(get_env SUPABASE_DB_PORT)"
DB_NAME="$(get_env SUPABASE_DB_NAME)"
DB_USER="$(get_env SUPABASE_DB_USER)"
DB_PASSWORD="$(get_env SUPABASE_DB_PASSWORD)"

if [ -z "$DB_HOST" ] || [ -z "$DB_PASSWORD" ]; then
  echo "[$(date -u +%FT%TZ)] SUPABASE_DB_*が.envに設定されていません" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
TIMESTAMP="$(date -u +%Y-%m-%d_%H%M%S)"
OUT_FILE="$BACKUP_DIR/${TIMESTAMP}.dump"

echo "[$(date -u +%FT%TZ)] バックアップ開始: $OUT_FILE"

PGPASSWORD="$DB_PASSWORD" "$PG_DUMP" \
  -h "$DB_HOST" \
  -p "$DB_PORT" \
  -U "$DB_USER" \
  -d "$DB_NAME" \
  -Fc \
  --no-owner \
  --no-privileges \
  -f "$OUT_FILE"

SIZE="$(du -h "$OUT_FILE" | cut -f1)"
echo "[$(date -u +%FT%TZ)] バックアップ完了: $OUT_FILE ($SIZE)"

# 保持期間を過ぎた古いバックアップを削除する。
DELETED_COUNT=0
while IFS= read -r -d '' old_file; do
  rm -f "$old_file"
  DELETED_COUNT=$((DELETED_COUNT + 1))
done < <(find "$BACKUP_DIR" -name "*.dump" -mtime "+${KEEP_DAYS}" -print0)

if [ "$DELETED_COUNT" -gt 0 ]; then
  echo "[$(date -u +%FT%TZ)] ${KEEP_DAYS}日より古いバックアップを${DELETED_COUNT}件削除しました"
fi

echo "[$(date -u +%FT%TZ)] 処理終了"
