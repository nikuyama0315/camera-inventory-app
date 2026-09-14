import { useState } from "react";
import { registerCpassShipping, type CpassShippingResult } from "../../lib/api/cpassShipping";

const STATUS_LABELS: Record<CpassShippingResult["status"], string> = {
  success: "登録しました",
  not_found: "商品が見つかりません",
  not_sold: "販売済みではありません",
  no_sale: "売上レコードなし",
  error: "エラー",
};

/**
 * 「送料登録」タブ(2026-09-14新規)。CPaSS(eBay公式クロスボーダー配送ツール)の出荷画面を
 * コピー&ペーストすると、ORDER NO.単位でeBay取引明細(ebay_transaction_lines)経由で
 * 販売済み商品と突合し、追跡番号(sales.tracking_info)・送料支払額(sales.shipping_cost_paid)を
 * 一括登録する。
 */
export default function ShippingRegisterPanel() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [results, setResults] = useState<CpassShippingResult[] | null>(null);

  async function handleRegister() {
    setBusy(true);
    setErrorMessage(null);
    setResults(null);
    try {
      const r = await registerCpassShipping(text);
      setResults(r);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "登録処理に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  const successCount = results?.filter((r) => r.status === "success").length ?? 0;

  return (
    <div style={{ padding: "1.5rem", overflowY: "auto", height: "100%", boxSizing: "border-box" }}>
      <h3 style={{ fontSize: 15, fontWeight: 700, marginTop: 0, marginBottom: 8 }}>送料登録</h3>
      <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 0, marginBottom: 16 }}>
        CPaSS(eBay公式クロスボーダー配送ツール)の出荷画面の内容をコピーして下のテキストボックスに貼り付け、
        「CPaSS送料登録」を押してください。ORDER NO.をeBay取引明細と突合し、販売済みステータスの商品について
        追跡番号・送料支払額(円)を一括登録します。
      </p>

      <label style={{ fontSize: 12, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
        CPaSS出荷画面貼付け
      </label>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={16}
        placeholder="CPaSSの出荷画面を全選択してコピーし、ここに貼り付けてください"
        style={{ width: "100%", maxWidth: 720, fontSize: 12, fontFamily: "monospace", boxSizing: "border-box" }}
      />
      <div style={{ marginTop: 8 }}>
        <button
          onClick={() => void handleRegister()}
          disabled={busy || !text.trim()}
          style={{ fontSize: 12, padding: "4px 12px" }}
        >
          {busy ? "登録中..." : "CPaSS送料登録"}
        </button>
      </div>

      {errorMessage && <p style={{ color: "var(--danger-text)", fontSize: 13, marginTop: 12 }}>{errorMessage}</p>}

      {results && (
        <div style={{ marginTop: 16 }}>
          <p style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            {results.length}件中、成功{successCount}件
          </p>
          {results.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
              ORDER NO.を含む出荷情報が見つかりませんでした。貼り付け内容をご確認ください。
            </p>
          ) : (
            <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--text-secondary)" }}>
                  <th style={{ padding: "4px 6px" }}>ORDER NO.</th>
                  <th style={{ padding: "4px 6px" }}>管理番号</th>
                  <th style={{ padding: "4px 6px" }}>追跡番号</th>
                  <th style={{ padding: "4px 6px", textAlign: "right" }}>送料(円)</th>
                  <th style={{ padding: "4px 6px" }}>結果</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => {
                  const zebraBackground = i % 2 === 1 ? "var(--surface-1)" : undefined;
                  return (
                    <tr key={`${r.orderNo}-${i}`} style={{ borderTop: "0.5px solid var(--border)", background: zebraBackground }}>
                      <td style={{ padding: "4px 6px", whiteSpace: "nowrap" }}>{r.orderNo}</td>
                      <td style={{ padding: "4px 6px", whiteSpace: "nowrap" }}>{r.managementNo ?? "-"}</td>
                      <td style={{ padding: "4px 6px", fontFamily: "monospace", whiteSpace: "nowrap" }}>{r.trackingNumber}</td>
                      <td style={{ padding: "4px 6px", textAlign: "right", whiteSpace: "nowrap" }}>
                        {r.shippingFeeJpy.toLocaleString()}
                      </td>
                      <td
                        style={{
                          padding: "4px 6px",
                          color: r.status === "success" ? "var(--text-secondary)" : "var(--danger-text)",
                        }}
                      >
                        {STATUS_LABELS[r.status]}
                        {r.status !== "success" ? `(${r.message})` : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
