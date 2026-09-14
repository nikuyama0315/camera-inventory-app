import { useRef, useState } from "react";
import {
  registerCpassShipping,
  registerElogiShipping,
  type ShippingImportResult,
} from "../../lib/api/cpassShipping";

const STATUS_LABELS: Record<ShippingImportResult["status"], string> = {
  success: "登録しました",
  not_found: "商品が見つかりません",
  not_sold: "販売済みではありません",
  no_sale: "売上レコードなし",
  error: "エラー",
};

/**
 * 「送料登録」タブ(2026-09-14新規)。
 * ①CPaSS(eBay公式クロスボーダー配送ツール)の出荷画面をコピー&ペーストすると、ORDER NO.単位で
 *   eBay取引明細(ebay_transaction_lines)経由で販売済み商品と突合し、追跡番号(sales.tracking_info)・
 *   送料支払額(sales.shipping_cost_paid)を一括登録する。
 * ②eLogiの「発送済一覧」CSVを選択すると、同様にeBayオーダー番号列で突合し、CSVの「追跡番号」列を
 *   tracking_infoに、「初回請求金額」+「追加請求/返金金額」の合計をshipping_cost_paidに登録する
 *   (2026-09-14追加)。
 */
export default function ShippingRegisterPanel() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [results, setResults] = useState<ShippingImportResult[] | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  function handleElogiFileClick() {
    fileInputRef.current?.click();
  }

  async function handleElogiFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    setErrorMessage(null);
    setResults(null);
    try {
      const csvText = await file.text();
      const r = await registerElogiShipping(csvText);
      setResults(r);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "eLogiファイルの取り込みに失敗しました");
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
        「CPaSS送料登録」を押してください。または、eLogiの発送済一覧CSVを「eLogiファイル選択」から取り込むこともできます。
        いずれもeBayオーダー番号でeBay取引明細と突合し、販売済みステータスの商品について追跡番号・送料支払額(円)を一括登録します。
      </p>

      <div style={{ display: "flex", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
        <div>
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
        </div>

        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            onChange={(e) => void handleElogiFileChange(e)}
            style={{ display: "none" }}
          />
          <button onClick={handleElogiFileClick} disabled={busy} style={{ fontSize: 12, padding: "4px 12px" }}>
            eLogiファイル選択
          </button>
        </div>
      </div>

      {errorMessage && <p style={{ color: "var(--danger-text)", fontSize: 13, marginTop: 12 }}>{errorMessage}</p>}

      {results && (
        <div style={{ marginTop: 16 }}>
          <p style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            {results.length}件中、成功{successCount}件
          </p>
          {results.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
              対象データが見つかりませんでした。貼り付け内容・ファイルの内容をご確認ください。
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
