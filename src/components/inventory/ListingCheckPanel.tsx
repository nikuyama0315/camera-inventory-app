import { useState } from "react";
import { runEbayListingCheck, type ListingCheckResult, type ListingCheckModelStockRow } from "../../lib/api/ebaySync";
import { EBAY_ACCOUNT_LABELS, EBAY_SYNC_SHOP_IDS } from "../../lib/types";

/**
 * 「在庫あり・eBay出品なし/QTY全て0の機種」表(2026-09-25追加)。3単語版・4単語版で
 * マッチング精度が異なるため、共通の表コンポーネントとして切り出し左右に並べる。
 * 【2026-09-25追加・ユーザー指示】もう一方の単語数版の結果には出てこない(=3単語版と
 * 4単語版で判定が食い違っている)機種名を赤字で強調表示する(otherModelNames)。
 */
function ModelStockIssuesTable({
  title,
  wordCount,
  rows,
  otherModelNames,
  starredModels,
  onToggleStar,
}: {
  title: string;
  wordCount: number;
  rows: ListingCheckModelStockRow[];
  otherModelNames: Set<string>;
  /** 星マーク済みの機種名(2026-09-25追加、ユーザー指示。画面上のみで保持、DB保存はしない)。 */
  starredModels: Set<string>;
  onToggleStar: (modelFolderName: string) => void;
}) {
  return (
    <div style={{ marginBottom: 24 }}>
      <p style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
        {title}({rows.length}件)
      </p>
      <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 0, marginBottom: 8 }}>
        在庫アラート(Google Drive「@撮影済み・出品待ち」フォルダ)で在庫1件以上ある機種のうち、
        機種名を含むeBayアクティブ出品(米国サイト)が1件も無いか、見つかってもQTY合計が0のものです
        (機種名とeBay出品タイトルの突合は、ブランド名を含めて先頭{wordCount}単語までのあいまい一致)。
        赤字はもう一方の単語数版では該当しなかった機種(3単語版・4単語版で判定が食い違っているもの)です。
      </p>
      {rows.length === 0 ? (
        <p style={{ fontSize: 12, color: "var(--text-muted)" }}>該当なし</p>
      ) : (
        <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-secondary)" }}>
              <th style={{ padding: "4px" }}>機種名</th>
              <th style={{ padding: "4px", textAlign: "right" }}>在庫数</th>
              <th style={{ padding: "4px", textAlign: "right" }}>該当eBay出品数</th>
              <th style={{ padding: "4px", textAlign: "right" }}>QTY合計</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const isMismatch = !otherModelNames.has(row.modelFolderName);
              const isStarred = starredModels.has(row.modelFolderName);
              return (
                <tr
                  key={row.modelFolderName}
                  style={{
                    borderTop: "0.5px solid var(--border)",
                    background: i % 2 === 1 ? "var(--surface-1)" : undefined,
                    color: isMismatch ? "var(--highlight-text)" : undefined,
                  }}
                >
                  <td
                    style={{
                      padding: "4px",
                      color: isStarred ? "var(--highlight-text)" : undefined,
                      fontWeight: isStarred ? 700 : undefined,
                    }}
                  >
                    <button
                      onClick={() => onToggleStar(row.modelFolderName)}
                      title="星をつける/外す"
                      style={{
                        border: "none",
                        background: "transparent",
                        padding: 0,
                        marginRight: 4,
                        cursor: "pointer",
                        fontSize: 13,
                        color: isStarred ? "var(--highlight-text)" : "var(--text-muted)",
                        fontWeight: isStarred ? 700 : undefined,
                      }}
                    >
                      {isStarred ? "★" : "☆"}
                    </button>
                    {row.modelFolderName}
                  </td>
                  <td style={{ padding: "4px", textAlign: "right" }}>{row.inStockCount}</td>
                  <td style={{ padding: "4px", textAlign: "right" }}>{row.matchedListingsCount}</td>
                  <td style={{ padding: "4px", textAlign: "right" }}>{row.totalQuantityAvailable}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * 「出品チェック」タブ(2026-09-08新規)。システム上「出品中」ステータスの商品と、
 * eBay(米国サイト・ストック1以上のアクティブ出品)を突合し、過不足を一覧表示する。
 */
export default function ListingCheckPanel() {
  const [shopId, setShopId] = useState<"soulcamera" | "soulmenjapan">("soulcamera");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [result, setResult] = useState<ListingCheckResult | null>(null);
  // 2026-09-25追加(ユーザー指示): 機種在庫/eBay出品未検出表の右にメモ欄を設置。
  // 確認結果や対応状況などを自由記述で残せるようにする(保存はせず画面上のみ)。
  const [modelStockMemo, setModelStockMemo] = useState("");
  // 2026-09-25追加(ユーザー指示): 機種名の先頭に星バッジを配置し、クリックで星と機種名を
  // 赤字太字にする(確認済み等のマーキング用、画面上のみで保持、DB保存はしない)。
  // 3単語版・4単語版で機種名が重複する場合は同じマーク状態を共有する。
  const [starredModels, setStarredModels] = useState<Set<string>>(new Set());

  function handleToggleStar(modelFolderName: string) {
    setStarredModels((prev) => {
      const next = new Set(prev);
      if (next.has(modelFolderName)) next.delete(modelFolderName);
      else next.add(modelFolderName);
      return next;
    });
  }

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

      {result && (() => {
        const modelNames3 = new Set(result.modelStockIssues3.map((r) => r.modelFolderName));
        const modelNames4 = new Set(result.modelStockIssues4.map((r) => r.modelFolderName));
        return (
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
                    <th style={{ padding: "4px" }}>Soulcamera Item Info</th>
                    <th style={{ padding: "4px" }}>Custom Label(SKU)</th>
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
                      <td style={{ padding: "4px" }}>{row.soulcameraItemInfo ?? "-"}</td>
                      <td style={{ padding: "4px" }}>{row.sku ?? "-"}</td>
                      <td style={{ padding: "4px" }}>{row.title ?? "-"}</td>
                      <td style={{ padding: "4px", textAlign: "right" }}>{row.quantityAvailable}</td>
                      <td style={{ padding: "4px" }}>
                        {row.matchedManagementNo
                          ? `${row.matchedManagementNo}(${row.matchedStatus ?? "-"}・${row.matchedAccount ?? "未設定"}・判定元: ${
                              row.matchSource === "soulcamera_item_info" ? "Item Info" : "SKU"
                            })`
                          : "該当商品なし"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* 2026-09-25追加(ユーザー指示): 在庫アラートで在庫1件以上ある機種のうち、eBayに
              同一機種の出品が1件も無い、またはQTYが全て0の機種を一覧表示する。過剰の下に配置。
              3単語版・4単語版のどちらが実態に合うか判断しづらいため、上下2段で両方表示する
              (2026-09-25変更)。 */}
          {/* 2026-09-25変更(ユーザー指示): 上下2段ではなく左右に並べて表示。
              3単語版・4単語版で判定が食い違う機種(過不足)は赤字で強調する。 */}
          <div style={{ display: "flex", gap: 24, marginBottom: 24 }}>
            <div style={{ flex: "0 0 30%" }}>
              <ModelStockIssuesTable
                title="在庫あり・eBay出品なし/QTY全て0の機種(3単語マッチング)"
                wordCount={3}
                rows={result.modelStockIssues3}
                otherModelNames={modelNames4}
                starredModels={starredModels}
                onToggleStar={handleToggleStar}
              />
            </div>
            <div style={{ flex: "0 0 30%" }}>
              <ModelStockIssuesTable
                title="在庫あり・eBay出品なし/QTY全て0の機種(4単語マッチング)"
                wordCount={4}
                rows={result.modelStockIssues4}
                otherModelNames={modelNames3}
                starredModels={starredModels}
                onToggleStar={handleToggleStar}
              />
            </div>
            <div style={{ flex: "0 0 30%" }}>
              <p style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>メモ</p>
              <textarea
                value={modelStockMemo}
                onChange={(e) => setModelStockMemo(e.target.value)}
                placeholder="確認結果や対応状況などを自由に記入できます"
                style={{ width: "100%", minHeight: 300, fontSize: 12, boxSizing: "border-box" }}
              />
            </div>
          </div>
        </>
        );
      })()}
    </div>
  );
}
