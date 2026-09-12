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
# 2026-09-13追加: 「環境復帰」画面(旧ログイン情報再設定)からバックアップ一覧を選んで
# リストア依頼できるようにするため、作成した各バックアップをdb_backup_filesテーブルへ
# 登録する(REST API経由、SUPABASE_SERVICE_ROLE_KEYを使用)。古いバックアップを削除する際は
# 対応するdb_backup_files行も削除する。
#
# cron実行例(毎日4:00、10分おきの他ジョブと重ならない時間帯):
#   0 4 * * * /opt/camera-inventory-app-src/scripts/backup_supabase_db.sh >> /opt/camera-inventory-app-src/logs/backup_supabase_db.log 2>&1
#
# 復元は手動でpg_restoreを直接実行することもできるが、通常は「環境復帰」画面の
# リストア機能(scripts/restore_supabase_db.pyがcronで処理)を使うこと。

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

get_env() {
  grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2-
}

DB_HOST="$(get_env SUPABASE_DB_HOST)"
DB_PORT="$(get_env SUPABASE_DB_PORT)"
DB_NAME="$(get_env SUPABASE_DB_NAME)"
DB_USER="$(get_env SUPABASE_DB_USER)"
DB_PASSWORD="$(get_env SUPABASE_DB_PASSWORD)"
SUPABASE_URL="$(get_env VITE_SUPABASE_URL)"
SERVICE_KEY="$(get_env SUPABASE_SERVICE_ROLE_KEY)"

if [ -z "$DB_HOST" ] || [ -z "$DB_PASSWORD" ]; then
  echo "[$(date -u +%FT%TZ)] SUPABASE_DB_*が.envに設定されていません" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
TIMESTAMP="$(date -u +%Y-%m-%d_%H%M%S)"
FILENAME="${TIMESTAMP}.dump"
OUT_FILE="$BACKUP_DIR/$FILENAME"

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

SIZE_BYTES="$(stat -c%s "$OUT_FILE")"
SIZE_HUMAN="$(du -h "$OUT_FILE" | cut -f1)"
echo "[$(date -u +%FT%TZ)] バックアップ完了: $OUT_FILE ($SIZE_HUMAN)"

if [ -n "$SUPABASE_URL" ] && [ -n "$SERVICE_KEY" ]; then
  curl -s -o /dev/null -w "" -X POST "$SUPABASE_URL/rest/v1/db_backup_files" \
    -H "apikey: $SERVICE_KEY" \
    -H "Authorization: Bearer $SERVICE_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"filename\": \"$FILENAME\", \"size_bytes\": $SIZE_BYTES}" \
    || echo "[$(date -u +%FT%TZ)] db_backup_filesへの登録に失敗しました(バックアップ自体は成功)" >&2
else
  echo "[$(date -u +%FT%TZ)] VITE_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEYが未設定のため、db_backup_filesへの登録をスキップしました" >&2
fi

# 保持期間を過ぎた古いバックアップを削除する(ファイル本体+db_backup_files行の両方)。
DELETED_COUNT=0
while IFS= read -r -d '' old_file; do
  old_filename="$(basename "$old_file")"
  rm -f "$old_file"
  if [ -n "$SUPABASE_URL" ] && [ -n "$SERVICE_KEY" ]; then
    curl -s -o /dev/null -X DELETE "$SUPABASE_URL/rest/v1/db_backup_files?filename=eq.$old_filename" \
      -H "apikey: $SERVICE_KEY" \
      -H "Authorization: Bearer $SERVICE_KEY" \
      || true
  fi
  DELETED_COUNT=$((DELETED_COUNT + 1))
done < <(find "$BACKUP_DIR" -name "*.dump" -mtime "+${KEEP_DAYS}" -print0)

if [ "$DELETED_COUNT" -gt 0 ]; then
  echo "[$(date -u +%FT%TZ)] ${KEEP_DAYS}日より古いバックアップを${DELETED_COUNT}件削除しました"
fi

echo "[$(date -u +%FT%TZ)] 処理終了"
