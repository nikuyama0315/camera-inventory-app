import { useState } from "react";
import ExcelJS from "exceljs";
import { lookupEbayOrdersLive } from "../../lib/api/ebaySync";

// テンプレート「利益管理表」の実データ範囲(既存の数式がF13:F302等を参照しているのに合わせる)
const DATA_START_ROW = 13;
const DATA_MAX_ROW = 1000;

type RowFillStatus = "filled" | "warning" | "not_found" | "no_empty_row";

interface RowFillResult {
  orderNo: string;
  status: RowFillStatus;
  message: string;
}

const STATUS_LABELS: Record<RowFillStatus, string> = {
  filled: "入力済み",
  warning: "入力済み(一部警告)",
  not_found: "見つかりませんでした",
  no_empty_row: "空き行なし",
};

const STATUS_COLORS: Record<RowFillStatus, string> = {
  filled: "var(--text-primary, inherit)",
  warning: "var(--danger-text)",
  not_found: "var(--danger-text)",
  no_empty_row: "var(--danger-text)",
};

// 2026-09-09追加: 「実行してダウンロード」の結果として、eBayから取得・シートへ書き込んだ値を
// 画面上にも一覧表示する(ダウンロード自体の挙動は変更しない)。取得できた項目(lookup.found)に
// ついてのみ行を作る(シート側に空き行が無く書き込めなかった場合も、値は取得できているので表示する)。
interface RowValuesResult {
  orderNo: string;
  soldDate: string | null;
  itemTitle: string | null;
  managementNo: string | null;
  salePriceUsd: number | null;
  shippingUsd: number | null;
  feesBasedOnUsd: number | null;
  plFeeUsd: number | null;
  purchasePriceJpy: number | null;
  listingStartDate: Date | null;
  purchaseDate: Date | null;
  buyerCountry: string | null;
}

function fmtNum(value: number | null, digits: number): string {
  if (value == null) return "-";
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtDate(value: Date | null): string {
  if (!value) return "-";
  return value.toISOString().slice(0, 10);
}

/** SKU(Custom Label)の先頭9文字(管理番号部分)を取り出す */
function skuManagementNo(sku: string): string {
  return sku.trim().slice(0, 9);
}

/** SKUの18文字目から次のハイフンの直前までを取り出す(仕入値、円建て) */
function skuPurchasePrice(sku: string): number | null {
  const s = sku.trim();
  if (s.length < 18) return null;
  const hyphenIdx = s.indexOf("-", 17);
  if (hyphenIdx === -1) return null;
  const n = Number(s.slice(17, hyphenIdx));
  return Number.isFinite(n) ? n : null;
}

/** SKU内のstartIndex(0始まり)から6桁のYYMMDDを取り出し、西暦2000+YYの日付として解釈する */
function parseSkuDate(sku: string, startIndex0Based: number): Date | null {
  const s = sku.trim();
  if (s.length < startIndex0Based + 6) return null;
  const digits = s.slice(startIndex0Based, startIndex0Based + 6);
  if (!/^\d{6}$/.test(digits)) return null;
  const yy = Number(digits.slice(0, 2));
  const mm = Number(digits.slice(2, 4));
  const dd = Number(digits.slice(4, 6));
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return new Date(Date.UTC(2000 + yy, mm - 1, dd));
}

export default function EbayXlsxFillPanel() {
  const [file, setFile] = useState<File | null>(null);
  const [sheetName, setSheetName] = useState("");
  const [orderNos, setOrderNos] = useState<string[]>([""]);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [results, setResults] = useState<RowFillResult[] | null>(null);
  const [valueResults, setValueResults] = useState<RowValuesResult[] | null>(null);

  function updateOrderNo(index: number, value: string) {
    setOrderNos((prev) => prev.map((v, i) => (i === index ? value : v)));
  }
  function addOrderNoField() {
    setOrderNos((prev) => [...prev, ""]);
  }
  function removeOrderNoField(index: number) {
    setOrderNos((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  async function handleRun() {
    setErrorMessage(null);
    setResults(null);
    setValueResults(null);

    if (!file) {
      setErrorMessage("エクセルファイルを選択してください");
      return;
    }
    if (!sheetName.trim()) {
      setErrorMessage("シート名を入力してください");
      return;
    }
    const targetOrderNos = orderNos.map((v) => v.trim()).filter((v) => v.length > 0);
    if (targetOrderNos.length === 0) {
      setErrorMessage("Order Noを1件以上入力してください");
      return;
    }

    setBusy(true);
    try {
      const buffer = await file.arrayBuffer();
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);
      const ws = workbook.getWorksheet(sheetName.trim());
      if (!ws) {
        const available = workbook.worksheets.map((s) => s.name).join(", ");
        throw new Error(
          `シート「${sheetName.trim()}」が見つかりません(このファイルのシート一覧: ${available})`,
        );
      }

      // C列(落札日)が空欄の行を、上から順に「未入力行」として収集する
      const emptyRows: number[] = [];
      for (let r = DATA_START_ROW; r <= DATA_MAX_ROW; r++) {
        const v = ws.getCell(`C${r}`).value;
        if (v == null || v === "") emptyRows.push(r);
        if (emptyRows.length >= targetOrderNos.length) break;
      }

      const lookups = await lookupEbayOrdersLive(targetOrderNos, "soulcamera");
      const lookupByOrderNo = new Map(lookups.map((l) => [l.orderNo, l]));

      const rowResults: RowFillResult[] = [];
      const rowValues: RowValuesResult[] = [];
      let cursor = 0;
      let filledAny = false;

      for (const orderNo of targetOrderNos) {
        const lookup = lookupByOrderNo.get(orderNo);
        if (!lookup || !lookup.found) {
          rowResults.push({
            orderNo,
            status: "not_found",
            message: lookup?.error ? `見つかりませんでした(${lookup.error})` : "見つかりませんでした",
          });
          continue;
        }

        const sku = lookup.sku ?? "";
        const warnings: string[] = [];

        // 2026-09-09追加: 値プレビュー表示用に、シートへの書き込み可否(空き行の有無)に
        // 関わらず、eBayから取得できた値そのものを記録しておく。
        rowValues.push({
          orderNo,
          soldDate: lookup.soldDate ?? null,
          itemTitle: lookup.itemTitle ?? null,
          managementNo: sku ? skuManagementNo(sku) : null,
          salePriceUsd: lookup.subtotalUsd ?? null,
          shippingUsd: lookup.shippingUsd ?? null,
          feesBasedOnUsd: lookup.orderTotalUsd ?? null,
          plFeeUsd: lookup.adFeeUsd ?? null,
          purchasePriceJpy: sku ? skuPurchasePrice(sku) : null,
          listingStartDate: sku ? parseSkuDate(sku, 10) : null,
          purchaseDate: sku ? parseSkuDate(sku, 0) : null,
          buyerCountry: lookup.buyerCountry ?? null,
        });

        if (cursor >= emptyRows.length) {
          rowResults.push({ orderNo, status: "no_empty_row", message: "空いている行がありませんでした" });
          continue;
        }
        const row = emptyRows[cursor];
        cursor++;

        if (lookup.soldDate) {
          const [y, m, d] = lookup.soldDate.split("-").map(Number);
          ws.getCell(`C${row}`).value = new Date(Date.UTC(y, m - 1, d));
        }
        if (lookup.itemTitle) ws.getCell(`D${row}`).value = lookup.itemTitle;

        if (sku) {
          const mgmtNo = skuManagementNo(sku);
          if (mgmtNo.length === 9) ws.getCell(`E${row}`).value = mgmtNo;
          else warnings.push("管理番号(E列)");
        } else {
          warnings.push("SKUが取得できなかったためE/R/AA/AC列は未入力");
        }

        ws.getCell(`F${row}`).value = 1;
        // 金額欄はテンプレート側の通貨記号付き書式([$$]#,##0.00等)を引き継がず、$を付けない数値表示にする
        if (lookup.subtotalUsd != null) {
          const cell = ws.getCell(`G${row}`);
          cell.value = lookup.subtotalUsd;
          cell.numFmt = "#,##0.00";
        }
        if (lookup.shippingUsd != null) {
          const cell = ws.getCell(`H${row}`);
          cell.value = lookup.shippingUsd;
          cell.numFmt = "#,##0.00";
        }
        if (lookup.orderTotalUsd != null) {
          const cell = ws.getCell(`J${row}`);
          cell.value = lookup.orderTotalUsd;
          cell.numFmt = "#,##0.00";
        }
        if (lookup.adFeeUsd != null) {
          const cell = ws.getCell(`Q${row}`);
          cell.value = lookup.adFeeUsd;
          cell.numFmt = "#,##0.00";
        }

        if (sku) {
          const purchasePrice = skuPurchasePrice(sku);
          if (purchasePrice != null) ws.getCell(`R${row}`).value = purchasePrice;
          else warnings.push("仕入値(R列)");

          const listingDate = parseSkuDate(sku, 10);
          if (listingDate) ws.getCell(`AA${row}`).value = listingDate;
          else warnings.push("出品Start日(AA列)");

          const purchaseDate = parseSkuDate(sku, 0);
          if (purchaseDate) ws.getCell(`AC${row}`).value = purchaseDate;
          else warnings.push("仕入日(AC列)");
        }

        if (lookup.buyerCountry) ws.getCell(`AD${row}`).value = lookup.buyerCountry;

        filledAny = true;
        rowResults.push({
          orderNo,
          status: warnings.length > 0 ? "warning" : "filled",
          message:
            warnings.length > 0
              ? `${row}行目に入力しました(一部抽出できませんでした: ${warnings.join("、")})`
              : `${row}行目に入力しました`,
        });
      }

      setResults(rowResults);
      setValueResults(rowValues);

      if (filledAny) {
        const outBuffer = await workbook.xlsx.writeBuffer();
        const blob = new Blob([outBuffer as BlobPart], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = file.name.replace(/\.xlsx$/i, "") + "_更新済み.xlsx";
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "処理に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        marginTop: 24,
        padding: "14px 16px",
        border: "0.5px solid var(--border)",
        borderRadius: 12,
      }}
    >
      <p style={{ fontSize: 15, fontWeight: 700, margin: "0 0 8px" }}>利益管理票の更新</p>
      <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 12px" }}>
        エクセルファイルをアップロードし、シート名とOrder No(eBay注文番号)を指定すると、eBay(soulcameraアカウント)からその場でAPI取得した売上データを、指定シート内のまだ入力されていない行(C列が空欄の行)に上から順に自動入力し、ダウンロードを促します。
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", gap: 24, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div>
            <label style={{ fontSize: 12, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
              エクセルファイル(.xlsx)
            </label>
            <input
              type="file"
              accept=".xlsx"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setResults(null);
                setErrorMessage(null);
              }}
            />
          </div>

          <div>
            <label style={{ fontSize: 12, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
              編集対象のシート名
            </label>
            <input
              type="text"
              value={sheetName}
              onChange={(e) => setSheetName(e.target.value)}
              placeholder="例: 2026.9(商品)"
              style={{ width: 220 }}
            />
          </div>
        </div>

        <div style={{ display: "flex", gap: 24, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div>
            <label style={{ fontSize: 12, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
              Order No(eBay注文番号)
            </label>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {orderNos.map((v, i) => (
                <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input
                    type="text"
                    value={v}
                    onChange={(e) => updateOrderNo(i, e.target.value)}
                    placeholder="例: 08-15133-98164"
                    style={{ width: 220 }}
                  />
                  {orderNos.length > 1 && (
                    <button onClick={() => removeOrderNoField(i)} style={{ fontSize: 11, padding: "2px 8px" }}>
                      −
                    </button>
                  )}
                </div>
              ))}
              <button onClick={addOrderNoField} style={{ fontSize: 12, padding: "2px 10px", width: "fit-content" }}>
                + Order Noを追加
              </button>
            </div>
          </div>

          <button onClick={handleRun} disabled={busy} style={{ width: "fit-content" }}>
            {busy ? "処理中..." : "実行してダウンロード"}
          </button>
        </div>
      </div>

      {errorMessage && (
        <p style={{ fontSize: 13, color: "var(--danger-text)", marginTop: 12 }}>{errorMessage}</p>
      )}

      {valueResults && valueResults.length > 0 && (
        <div style={{ overflowX: "auto", marginTop: 12 }}>
          <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse", whiteSpace: "nowrap" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--text-secondary)" }}>
                <th style={{ padding: "4px" }}>Order No</th>
                <th style={{ padding: "4px" }}>落札日</th>
                <th style={{ padding: "4px" }}>商品名</th>
                <th style={{ padding: "4px" }}>管理番号</th>
                <th style={{ padding: "4px" }}>販売価格</th>
                <th style={{ padding: "4px" }}>送料</th>
                <th style={{ padding: "4px" }}>Fees Based on</th>
                <th style={{ padding: "4px" }}>PL手数料</th>
                <th style={{ padding: "4px" }}>仕入値(税込)</th>
                <th style={{ padding: "4px" }}>出品Start日</th>
                <th style={{ padding: "4px" }}>仕入日</th>
                <th style={{ padding: "4px" }}>発送先</th>
              </tr>
            </thead>
            <tbody>
              {valueResults.map((v, i) => (
                <tr key={i} style={{ borderTop: "0.5px solid var(--border)" }}>
                  <td style={{ padding: "4px" }}>{v.orderNo}</td>
                  <td style={{ padding: "4px" }}>{v.soldDate ?? "-"}</td>
                  <td style={{ padding: "4px", whiteSpace: "normal", minWidth: 200 }}>{v.itemTitle ?? "-"}</td>
                  <td style={{ padding: "4px" }}>{v.managementNo ?? "-"}</td>
                  <td style={{ padding: "4px" }}>{fmtNum(v.salePriceUsd, 2)}</td>
                  <td style={{ padding: "4px" }}>{fmtNum(v.shippingUsd, 2)}</td>
                  <td style={{ padding: "4px" }}>{fmtNum(v.feesBasedOnUsd, 2)}</td>
                  <td style={{ padding: "4px" }}>{fmtNum(v.plFeeUsd, 2)}</td>
                  <td style={{ padding: "4px" }}>{fmtNum(v.purchasePriceJpy, 0)}</td>
                  <td style={{ padding: "4px" }}>{fmtDate(v.listingStartDate)}</td>
                  <td style={{ padding: "4px" }}>{fmtDate(v.purchaseDate)}</td>
                  <td style={{ padding: "4px" }}>{v.buyerCountry ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {results && results.length > 0 && (
        <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse", marginTop: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-secondary)" }}>
              <th style={{ padding: "4px" }}>Order No</th>
              <th style={{ padding: "4px" }}>結果</th>
              <th style={{ padding: "4px" }}>詳細</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r, i) => (
              <tr key={i} style={{ borderTop: "0.5px solid var(--border)" }}>
                <td style={{ padding: "4px" }}>{r.orderNo}</td>
                <td style={{ padding: "4px", color: STATUS_COLORS[r.status] }}>{STATUS_LABELS[r.status]}</td>
                <td style={{ padding: "4px" }}>{r.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
