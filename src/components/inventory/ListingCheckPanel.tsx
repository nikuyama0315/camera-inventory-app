import { useState } from "react";
import { runEbayListingCheck, type ListingCheckResult } from "../../lib/api/ebaySync";
import { EBAY_ACCOUNT_LABELS, EBAY_SYNC_SHOP_IDS } from "../../lib/types";

/**
 * 「出品チェック」タブ(2026-09-08新規)。システム上「出品中」ステータスの商品と、
 * eBay(米国サイト・ストック1以上のアクティブ出品)を突合し、過不足を一覧表示する。
 */
export default function ListingCheckPanel() {
  const [shopId, setShopId] = useState<"soulcamera" | "soulmenjapan">("soulcamera");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [result, setResult] = useState<ListingCheckResult | null>(null);

  async function handleRun() {
    setBusy(true);
    setErrorMessage(null);
    setResult(null);
    try {
      const r = await runEbayListingCheck(shopId);
      setResult(r);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "チェックに失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: "1.5rem", overflowY: "auto", height: "100%", boxSizing: "border-box" }}>
      <h3 style={{ fontSize: 15, fontWeight: 700, marginTop: 0, marginBottom: 8 }}>出品チェック</h3>
      <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 0, marginBottom: 16 }}>
        システム上「出品中」ステータスの商品と、eBay(米国サイト・ストック1以上のアクティブ出品)を
        Custom Label(SKU)から推測した管理番号で突合し、過不足を表示します。
      </p>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16 }}>
        <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          対象アカウント:
          <select
            value={shopId}
            onChange={(e) => setShopId(e.target.value as "soulcamera" | "soulmenjapan")}
            style={{ marginLeft: 6 }}
          >
            {EBAY_SYNC_SHOP_IDS.map((s) => (
              <option key={s} value={s}>
                {EBAY_ACCOUNT_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <button onClick={handleRun} disabled={busy}>
          {busy ? "チェック中..." : "チェック実行"}
        </button>
      </div>

      {errorMessage && (
        <p style={{ fontSize: 13, color: "var(--danger-text)", marginBottom: 12 }}>{errorMessage}</p>
      )}

      {result && (
        <>
          <div
            style={{
              display: "flex",
              gap: 16,
              marginBottom: 20,
              padding: "10px 14px",
              border: "0.5px solid var(--border)",
              borderRadius: 8,
              fontSize: 12,
              color: "var(--text-secondary)",
            }}
          >
            <span>システム上「出品中」: {result.totalListedInSystem}件</span>
            <span>eBayアクティブ出品(全サイト): {result.totalEbayActiveListings}件</span>
            <span>うち米国サイト・ストック1以上: {result.totalEbayActiveUsListings}件</span>
          </div>

          <div style={{ marginBottom: 24 }}>
            <p style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
              不足: システムでは「出品中」だが、eBay(米国サイト)に見つからない({result.shortage.length}件)
            </p>
            {result.shortage.length === 0 ? (
              <p style={{ fontSize: 12, color: "var(--text-muted)" }}>該当なし</p>
            ) : (
              <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--text-secondary)" }}>
                    <th style={{ padding: "4px" }}>管理番号</th>
                    <th style={{ padding: "4px" }}>仕入品名</th>
                  </tr>
                </thead>
                <tbody>
                  {result.shortage.map((row) => (
                    <tr key={row.managementNo} style={{ borderTop: "0.5px solid var(--border)" }}>
                      <td style={{ padding: "4px" }}>{row.managementNo}</td>
                      <td style={{ padding: "4px" }}>{row.title ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div>
            <p style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
              過剰: eBay(米国サイト)ではアクティブだが、システムでは「出品中」でない({result.excess.length}件)
            </p>
            {result.excess.length === 0 ? (
              <p style={{ fontSize: 12, color: "var(--text-muted)" }}>該当なし</p>
            ) : (
              <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--text-secondary)" }}>
                    <th style={{ padding: "4px" }}>ITEM ID</th>
                    <th style={{ padding: "4px" }}>SKU</th>
                    <th style={{ padding: "4px" }}>ITEM TITLE</th>
                    <th style={{ padding: "4px", textAlign: "right" }}>在庫数</th>
                    <th style={{ padding: "4px" }}>システム上の対応商品</th>
                  </tr>
                </thead>
                <tbody>
                  {result.excess.map((row) => (
                    <tr key={row.itemId} style={{ borderTop: "0.5px solid var(--border)" }}>
                      <td style={{ padding: "4px" }}>
                        <a
                          href={`https://www.ebay.com/itm/${row.itemId}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {row.itemId}
                        </a>
                      </td>
                      <td style={{ padding: "4px" }}>{row.sku ?? "-"}</td>
                      <td style={{ padding: "4px" }}>{row.title ?? "-"}</td>
                      <td style={{ padding: "4px", textAlign: "right" }}>{row.quantityAvailable}</td>
                      <td style={{ padding: "4px" }}>
                        {row.matchedManagementNo
                          ? `${row.matchedManagementNo}(${row.matchedStatus ?? "-"}・${row.matchedAccount ?? "未設定"})`
                          : "該当商品なし"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
