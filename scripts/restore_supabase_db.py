#!/usr/bin/env python3
"""
DBリストア自動処理スクリプト(2026-09-13新規)。

「環境復帰」画面(旧・ログイン情報再設定、AccountSecurityPage.tsx)から出されたDBリストア依頼
(db_restore_requestsテーブル、status='pending')を検知し、指定されたバックアップファイル
(scripts/backup_supabase_db.shが作成したもの)を専用ツールで実際に復元する。

【重要・破壊的操作】既存のテーブル・データを削除してからバックアップの内容で作り直す。
つまりこのスクリプトが実行されると、現在のDBの内容は完全に失われ、選択したバックアップ
時点の状態に戻る。取り消せない。

cron実行例(2分おき、ブラウザ側からの依頼にできるだけ早く反応するため):
  */2 * * * * cd /opt/camera-inventory-app-src && python3 scripts/restore_supabase_db.py >> logs/restore_supabase_db.log 2>&1

必要な環境変数(.envから読み込み):
  VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (依頼の検知・状態更新用)
  SUPABASE_DB_HOST, SUPABASE_DB_PORT, SUPABASE_DB_NAME, SUPABASE_DB_USER, SUPABASE_DB_PASSWORD
  (復元コマンド実行用)
"""
import os
import subprocess
from datetime import datetime, timezone

import requests

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
ENV_PATH = os.path.join(ROOT_DIR, ".env")
BACKUP_DIR = os.path.join(ROOT_DIR, "backups")
RESTORE_BIN = "/usr/lib/postgresql/17/bin/pg_restore"


def load_env() -> dict:
    env = {}
    with open(ENV_PATH, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


ENV = load_env()
SUPABASE_URL = ENV.get("VITE_SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = ENV.get("SUPABASE_SERVICE_ROLE_KEY", "")
REST_URL = f"{SUPABASE_URL}/rest/v1"
HEADERS = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=representation",
}

DB_HOST = ENV.get("SUPABASE_DB_HOST", "")
DB_PORT = ENV.get("SUPABASE_DB_PORT", "5432")
DB_NAME = ENV.get("SUPABASE_DB_NAME", "postgres")
DB_USER = ENV.get("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = ENV.get("SUPABASE_DB_PASSWORD", "")


def log(msg: str) -> None:
    print(f"[{datetime.now(timezone.utc).isoformat()}] {msg}", flush=True)


def fetch_pending_request():
    resp = requests.get(
        f"{REST_URL}/db_restore_requests",
        headers=HEADERS,
        params={"status": "eq.pending", "order": "requested_at.asc", "limit": 1},
        timeout=30,
    )
    resp.raise_for_status()
    rows = resp.json()
    return rows[0] if rows else None


def mark_request(request_id: str, patch: dict) -> None:
    resp = requests.patch(
        f"{REST_URL}/db_restore_requests",
        headers=HEADERS,
        params={"id": f"eq.{request_id}"},
        json=patch,
        timeout=30,
    )
    resp.raise_for_status()


def build_restore_command(backup_path: str) -> list:
    # --clean --if-exists: 復元前に既存オブジェクトを削除してから作り直す(破壊的)。
    return [
        RESTORE_BIN,
        "-h", DB_HOST,
        "-p", str(DB_PORT),
        "-U", DB_USER,
        "-d", DB_NAME,
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-privileges",
        backup_path,
    ]


def main() -> None:
    req = fetch_pending_request()
    if not req:
        log("リストア依頼はありません")
        return

    request_id = req["id"]
    backup_filename = req["backup_filename"]
    log(f"リストア依頼を処理開始: {request_id} (backup={backup_filename})")

    if "/" in backup_filename or ".." in backup_filename or not backup_filename.endswith(".dump"):
        mark_request(
            request_id,
            {
                "status": "error",
                "finished_at": datetime.now(timezone.utc).isoformat(),
                "error_message": f"不正なファイル名です: {backup_filename}",
            },
        )
        log("不正なファイル名のため中止しました")
        return

    backup_path = os.path.join(BACKUP_DIR, backup_filename)
    if not os.path.isfile(backup_path):
        mark_request(
            request_id,
            {
                "status": "error",
                "finished_at": datetime.now(timezone.utc).isoformat(),
                "error_message": f"バックアップファイルが見つかりません: {backup_filename}",
            },
        )
        log("バックアップファイルが見つからないため中止しました")
        return

    mark_request(
        request_id,
        {"status": "running", "started_at": datetime.now(timezone.utc).isoformat()},
    )

    env = os.environ.copy()
    env["PGPASSWORD"] = DB_PASSWORD
    cmd = build_restore_command(backup_path)

    log("復元処理を実行します(この時点でDBの内容が置き換わります)")
    result = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=1800)

    if result.returncode == 0:
        log("リストアが完了しました")
        mark_request(
            request_id,
            {
                "status": "done",
                "finished_at": datetime.now(timezone.utc).isoformat(),
                "error_message": (result.stderr or "")[:2000] or None,
            },
        )
    else:
        log(f"リストアに失敗しました(終了コード{result.returncode}): {result.stderr[:500]}")
        mark_request(
            request_id,
            {
                "status": "error",
                "finished_at": datetime.now(timezone.utc).isoformat(),
                "error_message": (result.stderr or "")[:2000],
            },
        )


if __name__ == "__main__":
    main()
