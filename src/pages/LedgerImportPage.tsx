import { useEffect, useState } from "react";
import * as XLSX from "xlsx";
import {
  mapRawRow,
  findExistingManagementNos,
  applyCameraAttributeMatches,
  findItemsWithExistingSales,
  executeImportRow,
  type LedgerRawRow,
  type MappedRow,
  type ExecuteResult,
} from "../lib/api/purchaseLedgerImport";
import { ITEM_STATUS_LABELS, type ItemStatus } from "../lib/types";
import { COUNTERPARTY_TYPE_OPTIONS, getDeductionInfo, type CounterpartyType } from "../lib/taxDeduction";
import CameraStockImportPanel from "../components/ledgerImport/CameraStockImportPanel";
import CameraManagementNoMatchPanel from "../components/ledgerImport/CameraManagementNoMatchPanel";
import ZakkaStockImportPanel from "../components/ledgerImport/ZakkaStockImportPanel";

const SHEET_NAME = "仕入・販売帳";
const DEFAULT_START_ROW = 2;
const DEFAULT_END_ROW = 524;

// 列番号(1始まり、シート実物のヘッダー行で確認済み)
const COL = {
  account: 1,
  serial: 2,
  purchaseDate: 3,
  itemName: 4,
  sourceMain: 5,
  sourceSub: 6,
  usedGoodsLabel: 7,
  purchasePrice: 8,
  quantity: 11,
  saleItemTitle: 13,
  saleDate: 14,
  trackingInfo: 15,
  jpPrice: 16,
  jpFee: 17,
  jpShippingCollected: 18,
  shippingCostPaid: 19,
  ebayPriceUsd: 21,
  ebayShippingCollectedUsd: 22,
  ebayFeeUsd: 23,
  exchangeRate: 29,
};

function cell(row: unknown[], colNumber1Indexed: number): unknown {
  const v = row[colNumber1Indexed - 1];
  return v === undefined ? null : v;
}

function toStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function toNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

/** アカウント・No.が両方とも空欄の行は、月次合計行(集計用の行)とみなして取込対象から除外する。 */
function isMonthlyTotalRow(row: unknown[]): boolean {
  return toStr(cell(row, COL.account)) == null && toNum(cell(row, COL.serial)) == null;
}

function buildRawRows(aoa: unknown[][], startRow: number, endRow: number): LedgerRawRow[] {
  const result: LedgerRawRow[] = [];
  for (let r = startRow; r <= endRow; r++) {
    const row = aoa[r - 1];
    if (!row) continue;
    if (isMonthlyTotalRow(row)) continue;

    result.push({
      rowNumber: r,
      account: toStr(cell(row, COL.account)),
      serial: toNum(cell(row, COL.serial)),
      serialRaw: toStr(cell(row, COL.serial)),
      salesRecordRef: toStr(cell(row, COL.serial)),
      purchaseDateRaw: cell(row, COL.purchaseDate),
      itemName: toStr(cell(row, COL.itemName)),
      sourceMain: toStr(cell(row, COL.sourceMain)),
      sourceSub: toStr(cell(row, COL.sourceSub)),
      usedGoodsLabel: toStr(cell(row, COL.usedGoodsLabel)),
      purchasePrice: toNum(cell(row, COL.purchasePrice)),
      quantity: toNum(cell(row, COL.quantity)),
      saleItemTitle: toStr(cell(row, COL.saleItemTitle)),
      saleDateRaw: cell(row, COL.saleDate),
      trackingInfo: toStr(cell(row, COL.trackingInfo)),
      jpPrice: toNum(cell(row, COL.jpPrice)),
      jpFee: toNum(cell(row, COL.jpFee)),
      jpShippingCollected: toNum(cell(row, COL.jpShippingCollected)),
      shippingCostPaid: toNum(cell(row, COL.shippingCostPaid)),
      ebayPriceUsd: toNum(cell(row, COL.ebayPriceUsd)),
      ebayShippingCollectedUsd: toNum(cell(row, COL.ebayShippingCollectedUsd)),
      ebayFeeUsd: toNum(cell(row, COL.ebayFeeUsd)),
      exchangeRate: toNum(cell(row, COL.exchangeRate)),
    });
  }
  return result;
}

/** 取込候補内(バッチ内)で管理番号が重複している行を検出し、2件目以降を重複扱いにする。 */
function markInBatchDuplicates(rows: MappedRow[]): void {
  const seen = new Map<string, number>();
  for (const row of rows) {
    if (row.outcome !== "new" || !row.managementNo) continue;
    const count = seen.get(row.managementNo) ?? 0;
    seen.set(row.managementNo, count + 1);
    if (count > 0) {
      row.outcome = "duplicate";
      row.warnings.push("この取込データ内で管理番号が重複しています(先に出てきた行のみ取込対象とします)");
    }
  }
}

const OUTCOME_LABELS: Record<MappedRow["outcome"], string> = {
  new: "新規",
  duplicate: "重複(スキップ)",
  error: "エラー",
};

const OUTCOME_COLORS: Record<MappedRow["outcome"], string> = {
  new: "var(--text-primary, inherit)",
  duplicate: "var(--text-muted)",
  error: "var(--danger-text)",
};

export default function LedgerImportPage() {
  const [file, setFile] = useState<File | null>(null);
  const [startRow, setStartRow] = useState(DEFAULT_START_ROW);
  const [endRow, setEndRow] = useState(DEFAULT_END_ROW);
  const [defaultStatus, setDefaultStatus] = useState<ItemStatus>("listed");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mappedRows, setMappedRows] = useState<MappedRow[] | null>(null);
  const [filter, setFilter] = useState<"all" | MappedRow["outcome"] | "salewarning">("all");

  const [executing, setExecuting] = useState(false);
  const [executeResults, setExecuteResults] = useState<Map<number, ExecuteResult>>(new Map());
  const [executeProgress, setExecuteProgress] = useState<{ done: number; total: number } | null>(null);

  async function handleDryRun() {
    if (!file) {
      setError("エクセルファイルを選択してください");
      return;
    }
    setBusy(true);
    setError(null);
    setMappedRows(null);
    setFilter("all");
    setExecuteResults(new Map());
    setExecuteProgress(null);
    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: "array", cellDates: true });
      const sheet = wb.Sheets[SHEET_NAME];
      if (!sheet) {
        throw new Error(
          `シート「${SHEET_NAME}」が見つかりません(このファイルのシート一覧: ${wb.SheetNames.join(", ")})`,
        );
      }
      const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null });
      const rawRows = buildRawRows(aoa, startRow, endRow);

      // 取引先区分は行ごとに異なりうるため、ここでは既定値「消費者(個人)」で一律マッピングし、
      // ドライラン結果の表で行ごとに個別選択できるようにする(2026-08-29: 全体一括選択を廃止)。
      const mapped = rawRows.map((raw) => mapRawRow(raw, defaultStatus, "consumer"));

      // カメラ(C)行は「仕入品名・仕入先・仕入先2・仕入高」の4項目でカメラシート取込済みの既存商品と
      // 突合する(management_noはその既存商品のものをそのまま引き継ぐため、以下のfindExistingManagementNosに
      // よる重複判定からは除外する)。
      await applyCameraAttributeMatches(mapped);

      // カメラ(C)行のうち突合先の既存商品が見つかった行(managementNoは突合先のものをそのまま引き継ぐ)は、
      // ここでの重複判定からは除外する。突合できなかったC行は仮の管理番号(C-R行番号)で新規登録するため、
      // M/J行と同様に通常の重複判定の対象とする(2026-09-01(5))。
      const candidateNos = mapped
        .filter(
          (m) =>
            m.outcome === "new" &&
            m.managementNo &&
            !((m.raw.account ?? "").trim() === "C" && m.matchedExistingItemId),
        )
        .map((m) => m.managementNo as string);
      const existing = await findExistingManagementNos(candidateNos);
      for (const m of mapped) {
        if (m.outcome === "new" && m.managementNo && existing.has(m.managementNo)) {
          m.outcome = "duplicate";
          m.warnings.push("既にシステムに取込済みの管理番号です");
        }
      }

      // 突合できたカメラ(C)行のうち、突合先の商品に既に売上データが登録済みのものは、商品情報の更新は行うが
      // (ユーザー指示により上書き更新の対象とする)、このシートの再取込による売上の二重登録は避けるため、
      // 売上の追加登録だけをスキップする(取込自体をスキップするわけではない、2026-09-01(5)で変更)。
      const matchedItemIds = mapped
        .filter((m) => m.outcome === "new" && m.matchedExistingItemId)
        .map((m) => m.matchedExistingItemId as string);
      const itemsWithSales = await findItemsWithExistingSales(matchedItemIds);
      for (const m of mapped) {
        if (m.outcome === "new" && m.matchedExistingItemId && itemsWithSales.has(m.matchedExistingItemId)) {
          m.matchedHasExistingSale = true;
          m.warnings.push("この商品は既に売上データが登録済みのため、商品情報のみ更新し、売上の追加登録は行いません");
        }
      }

      markInBatchDuplicates(mapped);

      setMappedRows(mapped);
    } catch (err) {
      setError(err instanceof Error ? err.message : "ドライランに失敗しました");
    } finally {
      setBusy(false);
    }
  }

  async function handleExecute() {
    if (!mappedRows) return;
    const targets = mappedRows.filter((m) => m.outcome === "new" && (m.itemInput || m.matchedExistingItemId));
    if (targets.length === 0) return;
    if (
      !window.confirm(
        `${targets.length}件のデータを実際に取り込みます。この操作は取り消せません。よろしいですか?`,
      )
    ) {
      return;
    }
    setExecuting(true);
    setExecuteProgress({ done: 0, total: targets.length });

    // 重複としてスキップする行(既存の登録済み商品と管理番号が一致した行)も、実行結果欄に
    // スキップした旨をログとして明示する(2026-08-31ユーザー指示)。既存商品の更新は行わない。
    const results = new Map<number, ExecuteResult>();
    for (const row of mappedRows) {
      if (row.outcome === "duplicate") {
        results.set(row.rowNumber, {
          rowNumber: row.rowNumber,
          managementNo: row.managementNo,
          success: true,
          skipped: true,
          message: `スキップしました(${row.warnings.join(" / ") || "重複のため"})。新規登録は行わず、売上データ等の更新もしていません`,
        });
      }
    }
    setExecuteResults(new Map(results));

    let doneCount = 0;
    for (const row of targets) {
      const result = await executeImportRow(row);
      results.set(row.rowNumber, result);
      doneCount += 1;
      setExecuteResults(new Map(results));
      setExecuteProgress({ done: doneCount, total: targets.length });
    }
    setExecuting(false);
  }

  function handleRowCounterpartyChange(rowNumber: number, value: CounterpartyType) {
    setMappedRows((prev) =>
      prev
        ? prev.map((r) =>
            r.rowNumber === rowNumber && r.itemInput
              ? { ...r, itemInput: { ...r.itemInput, counterparty_type: value } }
              : r,
          )
        : prev,
    );
  }

  function handleRowStatusChange(rowNumber: number, value: ItemStatus) {
    setMappedRows((prev) =>
      prev ? prev.map((r) => (r.rowNumber === rowNumber ? { ...r, finalStatus: value } : r)) : prev,
    );
  }

  const summary = mappedRows
    ? {
        new: mappedRows.filter((m) => m.outcome === "new").length,
        duplicate: mappedRows.filter((m) => m.outcome === "duplicate").length,
        error: mappedRows.filter((m) => m.outcome === "error").length,
        saleWarning: mappedRows.filter((m) => m.criticalWarnings.length > 0).length,
      }
    : null;

  const executeSuccessCount = Array.from(executeResults.values()).filter((r) => r.success && !r.skipped).length;
  const executeFailCount = Array.from(executeResults.values()).filter((r) => !r.success).length;
  const executeSkippedCount = Array.from(executeResults.values()).filter((r) => r.skipped).length;

  const filteredRows = mappedRows
    ? filter === "all"
      ? mappedRows
      : filter === "salewarning"
        ? mappedRows.filter((m) => m.criticalWarnings.length > 0)
        : mappedRows.filter((m) => m.outcome === filter)
    : null;

  const FILTER_OPTIONS: { key: "all" | MappedRow["outcome"] | "salewarning"; label: string; count: number | null }[] = [
    { key: "all", label: "すべて", count: mappedRows ? mappedRows.length : null },
    { key: "new", label: "新規", count: summary ? summary.new : null },
    { key: "duplicate", label: "重複(スキップ)", count: summary ? summary.duplicate : null },
    { key: "error", label: "エラー", count: summary ? summary.error : null },
    { key: "salewarning", label: "販売日抜け(要確認)", count: summary ? summary.saleWarning : null },
  ];

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "1.5rem", boxSizing: "border-box" }}>
      <h3 style={{ fontSize: 15, fontWeight: 700, marginTop: 0, marginBottom: 8 }}>
        カメラ在庫(未出品・出品中商品)の一括取込
      </h3>
      <CameraStockImportPanel />

      <hr style={{ margin: "32px 0", border: "none", borderTop: "1px solid var(--border)" }} />

      <h3 style={{ fontSize: 15, fontWeight: 700, marginTop: 0, marginBottom: 8 }}>
        仕入・販売帳(販売済み商品)の一括取込
      </h3>
      <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 0, marginBottom: 16 }}>
        「仕入・販売帳」エクセルの指定行範囲を読み込み、商品・仕入・(販売済みなら)売上データとして一括登録します。
        まず「ドライラン実行」で内容を確認してから、「取込実行」で実際にデータベースへ登録してください。
        取込実行は取り消せないため、必ずドライラン結果を確認してからにしてください。
        登録データのバックアップ・復元・全クリアは「在庫」タブの「バックアップ・復元」に移動しました。
        カメラ(C)区分の行は、「仕入品名・仕入先・仕入先2・仕入高」の4項目で、上記の「カメラ在庫」取込で
        登録済みの商品と突合します。一致した場合はその商品の情報を上書き更新し(既に売上登録済みなら売上の追加登録はスキップ)、
        一致しなかった場合は新規商品として登録します(仮の管理番号を自動採番)。複数の商品が該当し一意に特定できない場合のみエラーになります。
      </p>

      <div
        style={{
          display: "flex",
          gap: 16,
          alignItems: "center",
          flexWrap: "wrap",
          marginBottom: 12,
          padding: "12px 14px",
          border: "0.5px solid var(--border)",
          borderRadius: 12,
          background: "var(--surface-2)",
        }}
      >
        <input
          type="file"
          accept=".xlsx"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setMappedRows(null);
            setFilter("all");
            setExecuteResults(new Map());
            setError(null);
          }}
        />
        <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          開始行:
          <input
            type="number"
            value={startRow}
            onChange={(e) => setStartRow(Number(e.target.value) || DEFAULT_START_ROW)}
            style={{ width: 70, marginLeft: 4 }}
          />
        </label>
        <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          終了行:
          <input
            type="number"
            value={endRow}
            onChange={(e) => setEndRow(Number(e.target.value) || DEFAULT_END_ROW)}
            style={{ width: 70, marginLeft: 4 }}
          />
        </label>
        <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          販売日が空欄の行のステータス:
          <select
            value={defaultStatus}
            onChange={(e) => setDefaultStatus(e.target.value as ItemStatus)}
            style={{ marginLeft: 4 }}
          >
            {(Object.keys(ITEM_STATUS_LABELS) as ItemStatus[]).map((s) => (
              <option key={s} value={s}>
                {ITEM_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <button onClick={handleDryRun} disabled={busy || !file}>
          {busy ? "ドライラン実行中..." : "ドライラン実行"}
        </button>
      </div>

      <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 0, marginBottom: 12 }}>
        取引先区分(消費税の仕入税額控除率の判定に使う項目)は、下記のドライラン結果の表で商品ごとに個別選択できます。
        エクセルの仕入先列(メルカリ・ヤフオク等)は個人からの仕入を想定しているため、既定は「消費者(個人)」になっていますが、
        事業者からの仕入が含まれる商品だけ行ごとに変更してください。freeeデータ出力タブの仕入データCSVの税区分判定にも使われます。
        取込後に「在庫」タブの各商品の仕入タブで個別に修正することもできます。
      </p>

      {error && (
        <p style={{ fontSize: 13, color: "var(--danger-text)", marginBottom: 12 }}>{error}</p>
      )}

      {summary && (
        <div
          style={{
            display: "flex",
            gap: 16,
            alignItems: "center",
            flexWrap: "wrap",
            marginBottom: 12,
            padding: "12px 14px",
            border: "0.5px solid var(--border)",
            borderRadius: 12,
          }}
        >
          <span style={{ fontSize: 13 }}>
            新規: <strong>{summary.new}</strong>件 / 重複(スキップ): {summary.duplicate}件 / エラー:{" "}
            {summary.error}件
            {summary.saleWarning > 0 && (
              <span style={{ color: "var(--danger-text)", fontWeight: 700 }}>
                {" "}
                / 販売日抜け(売上未登録・要確認): {summary.saleWarning}件
              </span>
            )}
          </span>
          <button onClick={handleExecute} disabled={executing || summary.new === 0}>
            {executing
              ? `取込実行中... (${executeProgress?.done ?? 0}/${executeProgress?.total ?? 0})`
              : `取込実行(新規${summary.new}件)`}
          </button>
          {executeResults.size > 0 && !executing && (
            <span style={{ fontSize: 13 }}>
              → 完了: 成功{executeSuccessCount}件
              {executeSkippedCount > 0 && (
                <span style={{ color: "var(--text-muted)" }}> / スキップ{executeSkippedCount}件</span>
              )}
              {executeFailCount > 0 && (
                <span style={{ color: "var(--danger-text)" }}> / 失敗{executeFailCount}件</span>
              )}
            </span>
          )}
        </div>
      )}

      {mappedRows && (
        <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
          {FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              onClick={() => setFilter(opt.key)}
              style={{
                fontSize: 12,
                padding: "3px 10px",
                fontWeight: filter === opt.key ? 700 : 400,
                background: filter === opt.key ? "var(--accent)" : undefined,
                color: filter === opt.key ? "var(--surface, #fff)" : undefined,
              }}
            >
              {opt.label}
              {opt.count != null ? `(${opt.count})` : ""}
            </button>
          ))}
        </div>
      )}

      {filteredRows && filteredRows.length === 0 && (
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>該当する行はありません</p>
      )}

      {filteredRows && filteredRows.length > 0 && (
        <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-secondary)" }}>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>行</th>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>管理番号</th>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>判定</th>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>品名</th>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>仕入先</th>
              <th style={{ padding: "6px 4px", fontWeight: 500, textAlign: "right" }}>仕入高</th>
              <th style={{ padding: "6px 4px", fontWeight: 500, textAlign: "right" }}>邦売上高</th>
              <th style={{ padding: "6px 4px", fontWeight: 500, textAlign: "right" }}>eBay売上高</th>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>ステータス</th>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>取引先区分</th>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>エラー・警告</th>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>実行結果</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row) => {
              const execResult = executeResults.get(row.rowNumber);
              return (
                <tr key={row.rowNumber} style={{ borderTop: "0.5px solid var(--border)" }}>
                  <td style={{ padding: "6px 4px" }}>{row.rowNumber}</td>
                  <td style={{ padding: "6px 4px" }}>{row.managementNo ?? "-"}</td>
                  <td style={{ padding: "6px 4px", color: OUTCOME_COLORS[row.outcome] }}>
                    {OUTCOME_LABELS[row.outcome]}
                  </td>
                  <td style={{ padding: "6px 4px" }}>{row.raw.itemName ?? "-"}</td>
                  <td style={{ padding: "6px 4px" }}>
                    {[row.raw.sourceMain, row.raw.sourceSub].filter(Boolean).join(" / ") || "-"}
                  </td>
                  <td style={{ padding: "6px 4px", textAlign: "right" }}>
                    {row.raw.purchasePrice != null ? row.raw.purchasePrice.toLocaleString() : "-"}
                  </td>
                  <td style={{ padding: "6px 4px", textAlign: "right" }}>
                    {(() => {
                      const jpSubtotal =
                        (row.raw.jpPrice ?? 0) - (row.raw.jpFee ?? 0) + (row.raw.jpShippingCollected ?? 0);
                      return jpSubtotal !== 0 ? `¥${jpSubtotal.toLocaleString()}` : "-";
                    })()}
                  </td>
                  <td style={{ padding: "6px 4px", textAlign: "right" }}>
                    {(() => {
                      const ebaySubtotalUsd =
                        (row.raw.ebayPriceUsd ?? 0) + (row.raw.ebayShippingCollectedUsd ?? 0) - (row.raw.ebayFeeUsd ?? 0);
                      if (ebaySubtotalUsd === 0) return "-";
                      const ebaySubtotalJpy = ebaySubtotalUsd * (row.raw.exchangeRate ?? 150);
                      return (
                        <div>
                          <div>${ebaySubtotalUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
                          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                            (¥{Math.round(ebaySubtotalJpy).toLocaleString()})
                          </div>
                        </div>
                      );
                    })()}
                  </td>
                  <td style={{ padding: "6px 4px" }}>
                    <select
                      value={row.finalStatus}
                      onChange={(e) => handleRowStatusChange(row.rowNumber, e.target.value as ItemStatus)}
                      style={{ fontSize: 12 }}
                    >
                      {(Object.keys(ITEM_STATUS_LABELS) as ItemStatus[]).map((s) => (
                        <option key={s} value={s}>
                          {ITEM_STATUS_LABELS[s]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td style={{ padding: "6px 4px" }}>
                    {row.itemInput ? (
                      (() => {
                        const info = getDeductionInfo(row.itemInput.counterparty_type);
                        return (
                          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                            <select
                              value={row.itemInput.counterparty_type}
                              onChange={(e) =>
                                handleRowCounterpartyChange(row.rowNumber, e.target.value as CounterpartyType)
                              }
                              style={{ fontSize: 12 }}
                            >
                              {COUNTERPARTY_TYPE_OPTIONS.map((o) => (
                                <option key={o.value} value={o.value}>
                                  {o.label}
                                </option>
                              ))}
                            </select>
                            <span
                              style={{
                                fontSize: 11,
                                color: info.rate === 0 ? "var(--danger-text)" : "var(--text-muted)",
                              }}
                            >
                              控除率 {info.rate}%
                            </span>
                          </div>
                        );
                      })()
                    ) : (
                      "-"
                    )}
                  </td>
                  <td style={{ padding: "6px 4px" }}>
                    {row.errors.map((e, i) => (
                      <div key={`e${i}`} style={{ color: "var(--danger-text)" }}>
                        {e}
                      </div>
                    ))}
                    {row.criticalWarnings.map((w, i) => (
                      <div
                        key={`cw${i}`}
                        style={{
                          color: "var(--danger-text)",
                          fontWeight: 700,
                          background: "var(--danger-bg, rgba(220,53,69,0.08))",
                          borderRadius: 4,
                          padding: "2px 4px",
                          marginBottom: 2,
                        }}
                      >
                        ⚠ {w}
                      </div>
                    ))}
                    {row.warnings.map((w, i) => (
                      <div key={`w${i}`} style={{ color: "var(--text-muted)" }}>
                        {w}
                      </div>
                    ))}
                  </td>
                  <td
                    style={{
                      padding: "6px 4px",
                      color: execResult && !execResult.success
                        ? "var(--danger-text)"
                        : execResult?.skipped
                          ? "var(--text-muted)"
                          : undefined,
                    }}
                  >
                    {execResult ? execResult.message : ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <hr style={{ margin: "32px 0", border: "none", borderTop: "1px solid var(--border)" }} />

      <CameraManagementNoMatchPanel />

      <hr style={{ margin: "32px 0", border: "none", borderTop: "1px solid var(--border)" }} />

      <h3 style={{ fontSize: 15, fontWeight: 700, marginTop: 0, marginBottom: 8 }}>雑貨在庫の一括取込</h3>
      <ZakkaStockImportPanel />

    </div>
  );
}
