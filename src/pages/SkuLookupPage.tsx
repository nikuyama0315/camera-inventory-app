import { useState } from "react";
import { searchBySkuFragment, type SkuLookupRow } from "../lib/api/skuLookup";
import { ITEM_STATUS_LABELS } from "../lib/types";
import ItemDetailPane from "../components/inventory/ItemDetailPane";

const STAGE_LABELS: Record<string, string> = {
  awaiting_listing: "@撮影済み・出品待ち(機種名フォルダ配下)",
  listed: "@カメラ出品データ(直下)",
  sold: "@カメラ出品データ\\＠SOLD",
};

export default function SkuLookupPage() {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<SkuLookupRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);

  async function handleSearch() {
    setLoading(true);
    setErrorMessage(null);
    setSearched(true);
    try {
      const data = await searchBySkuFragment(query);
      setRows(data);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "検索に失敗しました");
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") void handleSearch();
  }

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "1.5rem", paddingBottom: "3rem", boxSizing: "border-box" }}>
      <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 0, marginBottom: 16 }}>
        eBayのCustom label(SKU)に含まれる文字列の一部を入力すると、該当する商品の現在のステータスと、Google Driveフォルダの所在ステージを確認できます(Custom labelは管理番号と同一の値です)。
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <input
          type="text"
          placeholder="例: 260822-01 や 260822 の一部"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          style={{ flex: 1, maxWidth: 320 }}
        />
        <button onClick={handleSearch} disabled={loading}>
          {loading ? "検索中..." : "検索"}
        </button>
      </div>

      {errorMessage && <p style={{ color: "var(--danger-text)", fontSize: 13 }}>{errorMessage}</p>}

      {!loading && searched && rows.length === 0 && !errorMessage && (
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>該当する管理番号(Custom label)が見つかりませんでした</p>
      )}

      {!loading && rows.length > 0 && (
        <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-secondary)" }}>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>管理番号(Custom label)</th>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>仕入品名</th>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>ステータス</th>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>Driveフォルダの現在地</th>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ borderTop: "0.5px solid var(--border)" }}>
                <td style={{ padding: "8px 4px", fontWeight: 500 }}>{r.management_no}</td>
                <td style={{ padding: "8px 4px" }}>{r.title ?? "-"}</td>
                <td style={{ padding: "8px 4px" }}>
                  <span
                    style={{
                      fontSize: 12,
                      padding: "2px 8px",
                      borderRadius: 999,
                      background: "var(--surface-1)",
                      border: "0.5px solid var(--border)",
                    }}
                  >
                    {ITEM_STATUS_LABELS[r.status]}
                  </span>
                </td>
                <td style={{ padding: "8px 4px", color: "var(--text-secondary)" }}>
                  {r.drive_current_stage ? (
                    <>
                      <div>{STAGE_LABELS[r.drive_current_stage] ?? r.drive_current_stage}</div>
                      {r.drive_model_folder_name && (
                        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                          機種名フォルダ: {r.drive_model_folder_name}
                          {r.drive_item_folder_name ? ` / 商品フォルダ: ${r.drive_item_folder_name}` : ""}
                        </div>
                      )}
                    </>
                  ) : (
                    <span style={{ color: "var(--text-muted)" }}>未登録</span>
                  )}
                </td>
                <td style={{ padding: "8px 4px", textAlign: "right" }}>
                  <button
                    onClick={() => setEditingItemId(r.id)}
                    style={{ fontSize: 11, padding: "3px 10px" }}
                  >
                    編集
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editingItemId && (
        <div
          onClick={() => setEditingItemId(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            padding: "5vh 16px",
            zIndex: 1000,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(720px, 100%)",
              maxHeight: "90vh",
              overflowY: "auto",
              background: "var(--surface-2)",
              border: "0.5px solid var(--border)",
              borderRadius: 12,
              padding: "1.5rem",
              boxShadow: "0 8px 24px rgba(0,0,0,0.2)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <p style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>商品を編集</p>
              <button onClick={() => setEditingItemId(null)} style={{ fontSize: 11, padding: "3px 10px" }}>
                閉じる
              </button>
            </div>
            <ItemDetailPane
              itemId={editingItemId}
              isCreatingNew={false}
              onItemCreated={() => {}}
              onItemChanged={() => void handleSearch()}
            />
          </div>
        </div>
      )}
    </div>
  );
}
