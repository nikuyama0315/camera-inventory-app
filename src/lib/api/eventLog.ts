import { supabase } from "../supabaseClient";

/**
 * 「イベントログ」タブ(2026-09-10追加、ユーザー指示)。
 * 通知メール(フォルダ移動完了/失敗・在庫アラート・パスワード変更)を送信するのと同じトリガーで、
 * 各Edge Function(move-drive-folder・check-stock-alerts・notify-password-changed)がevent_log
 * テーブルへ書き込む行をそのまま表示する(メール本文と同じ内容)。
 */
export interface EventLogEntry {
  id: string;
  source: string;
  subject: string;
  body: string;
  created_at: string;
}

const SOURCE_LABELS: Record<string, string> = {
  "move-drive-folder": "フォルダ移動",
  "check-stock-alerts": "在庫アラート",
  "notify-password-changed": "パスワード変更",
};

export function eventSourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

/** 直近30件のイベントログを新しい順で取得する。 */
export async function fetchRecentEventLog(): Promise<EventLogEntry[]> {
  const { data, error } = await supabase
    .from("event_log")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) throw error;
  return data as EventLogEntry[];
}
