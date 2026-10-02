import { useEffect, useState } from "react";
import {
  fetchArrivalAlertItems,
  fetchArrivalAlertThresholdDays,
  saveArrivalAlertThresholdDays,
  type ArrivalAlertItem,
} from "../lib/api/stockAlerts";

interface ArrivalAlertPanelProps {
  onViewInInventory: () => void;
}

/**
 * 入荷アラート(2026-10-02新規、ユーザー要望)。
 * ステータスが「入荷待ち」で、アイテム登録日からn日以上経過している商品を一覧表示する。
 * 既存の在庫アラート表示の上に設置する。
 */
export default function ArrivalAlertPanel({ onViewInInventory }: ArrivalAlertPanelProps) {
  const [items, setItems] = useState<ArrivalAlertItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [thresholdDays, setThresholdDays] = useState(5);
  const [thresholdInput, setThresholdInput] = useState("5");
  const [savingThreshold, setSavingThreshold] = useState(false);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    setErrorMessage(null);
    try {
      const days = await fetchArrivalAlertThresholdDays();
      setThresholdDays(days);
      setThresholdInput(String(days));
      const data = await fetchArrivalAlertItems(days);
      setItems(data);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveThreshold() {
    const days = Number(thresholdInput);
    if (!Number.isFinite(days) || days < 0) {
      setErrorMessage("日数は0以上の数値で入力してください");
      return;
    }
    setSavingThreshold(true);
    setErrorMessage(null);
    try {
      await saveArrivalAlertThresholdDays(days);
      setThresholdDays(days);
      const data = await fetchArrivalAlertItems(days);
      setItems(data);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingThreshold(false);
    }
  }

  function formatYen(v: number | null): string {
    if (v === null || v === undefined) return "-";
    return `¥${v.toLocaleString()}`;
  }

  return (
    <div style={{ marginBottom: 20 }}>
      <h3 style={{ fontSize: 15, fontWeight: 700, marginTop: 0, marginBottom: 8 }}>入荷アラート</h3>

      {items.length > 0 && (
        <div
          style={{
            marginBottom: 12,
            padding: "10px 12px",
            border: "0.5px solid var(--danger-text)",
            borderRadius: 8,
            background: "var(--danger-bg)",
          }}
        >
          <p style={{ fontSize: 13, color: "var(--danger-text)", margin: 0, fontWeight: 500 }}>
            入荷待ちで{thresholdDays}日以上経過している商品が{items.length}件あります
          </p>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          入荷待ちから
          <input
            type="number"
            min={0}
            value={thresholdInput}
            onChange={(e) => setThresholdInput(e.target.value)}
            style={{ width: 60, margin: "0 4px" }}
          />
          日以上経過
        </label>
        <button type="button" onClick={handleSaveThreshold} disabled={savingThreshold}>
          設定
        </button>
        <button type="button" onClick={onViewInInventory}>
          仕入・在庫・販売画面で見る
        </button>
      </div>

      {errorMessage && (
        <p style={{ color: "var(--danger-text)", fontSize: 12, marginBottom: 12 }}>{errorMessage}</p>
      )}

      {loading ? (
        <p style={{ fontSize: 13 }}>読み込み中...</p>
      ) : items.length === 0 ? (
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>該当する商品はありません。</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ fontSize: 12, borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "4px 8px", borderBottom: "1px solid var(--border)" }}>アカウント</th>
                <th style={{ textAlign: "left", padding: "4px 8px", borderBottom: "1px solid var(--border)" }}>管理番号</th>
                <th style={{ textAlign: "left", padding: "4px 8px", borderBottom: "1px solid var(--border)" }}>仕入品名</th>
                <th style={{ textAlign: "left", padding: "4px 8px", borderBottom: "1px solid var(--border)" }}>仕入先・出品者名</th>
                <th style={{ textAlign: "left", padding: "4px 8px", borderBottom: "1px solid var(--border)" }}>購入元URL</th>
                <th style={{ textAlign: "left", padding: "4px 8px", borderBottom: "1px solid var(--border)" }}>仕入高</th>
                <th style={{ textAlign: "left", padding: "4px 8px", borderBottom: "1px solid var(--border)" }}>経過日数</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td style={{ padding: "4px 8px" }}>{item.account ?? "-"}</td>
                  <td style={{ padding: "4px 8px" }}>{item.management_no}</td>
                  <td style={{ padding: "4px 8px" }}>{item.title ?? "-"}</td>
                  <td style={{ padding: "4px 8px" }}>{item.source_name ?? "-"}</td>
                  <td style={{ padding: "4px 8px" }}>
                    {item.source_url ? (
                      <a href={item.source_url} target="_blank" rel="noreferrer">
                        購入サイトでみる
                      </a>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td style={{ padding: "4px 8px" }}>{formatYen(item.purchase_price)}</td>
                  <td style={{ padding: "4px 8px" }}>{item.daysElapsed}日</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
