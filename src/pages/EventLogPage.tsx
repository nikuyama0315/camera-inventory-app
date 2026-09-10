import { useEffect, useState } from "react";
import { fetchRecentEventLog, eventSourceLabel, type EventLogEntry } from "../lib/api/eventLog";

/**
 * 「イベントログ」タブ(2026-09-10追加、ユーザー指示)。
 * 通知メールを発信するのと同じトリガーで書き込まれるevent_logテーブルの直近30件を、
 * メールの件名・本文と同じ内容で一覧表示する(フォルダ移動完了/失敗・在庫アラート・パスワード変更)。
 */
export default function EventLogPage() {
  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function reload() {
    setLoading(true);
    setErrorMessage(null);
    try {
      setEvents(await fetchRecentEventLog());
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "イベントログの取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "1.5rem", paddingBottom: "3rem", boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
          通知メール(フォルダ移動完了・失敗/在庫アラート/パスワード変更)を送信するのと同じタイミングで記録された、直近30件のイベントです。内容はメールの件名・本文と同じです。
        </p>
        <button onClick={reload} disabled={loading} style={{ fontSize: 11, padding: "3px 10px", flexShrink: 0 }}>
          {loading ? "更新中..." : "再取得"}
        </button>
      </div>

      {errorMessage && <p style={{ color: "var(--danger-text)", fontSize: 13 }}>{errorMessage}</p>}

      {events.length === 0 && !loading && (
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>イベントログはまだありません</p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {events.map((e) => (
          <div
            key={e.id}
            style={{ border: "0.5px solid var(--border)", borderRadius: 8, padding: "10px 12px", background: "var(--surface-1)" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                {new Date(e.created_at).toLocaleString("ja-JP")}
              </span>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  padding: "1px 8px",
                  borderRadius: 4,
                  background: "var(--surface-2, var(--border))",
                  color: "var(--text-secondary)",
                }}
              >
                {eventSourceLabel(e.source)}
              </span>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{e.subject}</span>
            </div>
            <p style={{ fontSize: 12, whiteSpace: "pre-wrap", margin: 0, color: "var(--text-secondary)" }}>{e.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
