import { supabase } from "../supabaseClient";

/**
 * DBリストア機能(2026-09-13新規、「環境復帰」画面)。
 * このSupabaseプロジェクトは組織プランがFreeのため、Supabase側の自動バックアップ・PITRが
 * 無い。そのためVPS側でpg_dumpによる日次バックアップ(scripts/backup_supabase_db.sh)を
 * 構築し、作成したバックアップをdb_backup_filesテーブルへ登録している。
 * ここでは、その一覧を表示し、選んだバックアップへの復元依頼(db_restore_requests)を
 * 出す処理のみを行う。実際の復元(pg_restore --clean、破壊的操作)はVPS側の
 * scripts/restore_supabase_db.pyが実行する(現状cronでの自動実行は行わず、依頼が
 * 出るたびに手動でスクリプトを実行する運用)。
 */

export interface DbBackupFile {
  id: string;
  filename: string;
  size_bytes: number;
  created_at: string;
}

export interface DbRestoreRequest {
  id: string;
  backup_filename: string;
  status: "pending" | "running" | "done" | "error";
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  error_message: string | null;
}

/** 利用可能なバックアップ一覧を新しい順に取得する。 */
export async function fetchAvailableBackups(): Promise<DbBackupFile[]> {
  const { data, error } = await supabase
    .from("db_backup_files")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as DbBackupFile[];
}

/** 最新のリストア依頼(1件)を取得する。画面上の状態表示用。 */
export async function fetchLatestRestoreRequest(): Promise<DbRestoreRequest | null> {
  const { data, error } = await supabase
    .from("db_restore_requests")
    .select("*")
    .order("requested_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data as DbRestoreRequest[])[0] ?? null;
}

/**
 * 指定したバックアップへの復元依頼を出す。既にpending/runningの依頼がある場合は
 * 新規に作らず、その依頼をそのまま返す(重複依頼防止)。
 */
export async function requestDbRestore(backupFilename: string): Promise<DbRestoreRequest> {
  const existing = await fetchLatestRestoreRequest();
  if (existing && (existing.status === "pending" || existing.status === "running")) {
    return existing;
  }
  const { data, error } = await supabase
    .from("db_restore_requests")
    .insert({ backup_filename: backupFilename, status: "pending" })
    .select("*")
    .single();
  if (error) throw error;
  return data as DbRestoreRequest;
}
