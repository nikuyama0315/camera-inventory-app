import { useState } from "react";
import * as XLSX from "xlsx";
import {
  mapCameraStockRawRow,
  executeCameraStockImportRow,
  type CameraStockRawRow,
  type MappedCameraStockRow,
  type ExecuteResult,
} from "../../lib/api/cameraStockImport";
import { findExistingManagementNos } from "../../lib/api/purchaseLedgerImport";
import { ITEM_STATUS_LABELS, type ItemStatus } from "../../lib/types";
import { COUNTERPARTY_TYPE_OPTIONS, getDeductionInfo, type CounterpartyType } from "../../lib/taxDeduction";

const SHEET_NAME = "カメラ";
const DEFAULT_START_ROW = 2;
const DEFAULT_END_ROW = 151;

// 列番号(1始まり、シート実物のヘッダー行で確認済み)
const COL = {
  model: 1, // A 機種名
  purchaseDate: 2, // B 仕入日
  itemName: 3, // C 仕入品名
  sourceMain: 4, // D 仕入先
  sourceSub: 5, // E 仕入先2
  usedGoodsLabel: 6, // F 新品・古物判定
  purchasePrice: 12, // L 仕入高合計(ポイント考慮なし)
  statusCode: 13, // M ステータス
  managementNo: 14, // N 管理番号
  conditionNotes: 15, // O 状態
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

/** 機種名・管理番号・仕入品名がすべて空欄の行は空行とみなして取込対象から除外する。 */
function isBlankRow(row: unknown[]): boolean {
  return (
    toStr(cell(row, COL.model)) == null &&
    toStr(cell(row, COL.managementNo)) == null &&
    toStr(cell(row, COL.itemName)) == null
  );
}

function buildRawRows(aoa: unknown[][], startRow: number, endRow: number): CameraStockRawRow[] {
  const result: CameraStockRawRow[] = [];
  for (let r = startRow; r <= endRow; r++) {
    const row = aoa[r - 1];
    if (!row) continue;
    if (isBlankRow(row)) continue;

    result.push({
      rowNumber: r,
      model: toStr(cell(row, COL.model)),
      purchaseDateRaw: cell(row, COL.purchaseDate),
      itemName: toStr(cell(row, COL.itemName)),
      sourceMain: toStr(cell(row, COL.sourceMain)),
      sourceSub: toStr(cell(row, COL.sourceSub)),
      usedGoodsLabel: toStr(cell(row, COL.usedGoodsLabel)),
      purchasePrice: toNum(cell(row, COL.purchasePrice)),
      statusCode: toStr(cell(row, COL.statusCode)),
      managementNoRaw: toStr(cell(row, COL.managementNo)),
      conditionNotes: toStr(cell(row, COL.conditionNotes)),
    });
  }
  return result;
}

/** 取込候補内(バッチ内)で管理番号が重複している行を検出し、2件目以降を重複扱いにする。 */
function markInBatchDuplicates(rows: MappedCameraStockRow[]): void {
  const seen = new Map<string, number>();
  for (const row of rows) {
    if (row.outcome !== "new" || !row.managementNo) continue;
    const count = seen.get(row.managementNo) ?? 0;
    seen.set(row.managementNo, count + 1);
    if (count > 0) {
      row.outcome = "duplicate";
      row.warnings.push("この取込データ内で管理番号が重複しています(先に出てきた行はみ取込対象とします)");
    }
  }
}

const OUTCOME_LABELS: Record<MappedCameraStockRow["outcome"], string> = {
  new: "新規",
  duplicate: "重複(スキップ)",
  error: "エラー",
};

const OUTCOME_COLORS: Record<MappedCameraStockRow["outcome"], string> = {
  new: "var(--text-primary, inherit)",
  duplicate: "var(--text-muted)",
  error: "var(--danger-text)",
};

export default function CameraStockImportPanel() {
  const [file, setFile] = useState<File | null>(null);
  const [startRow, setStartRow] = useState(DEFAULT_START_ROW);
  const [endRow, setEndRow] = useState(DEFAULT_END_ROW);
  const [defaultStatus, setDefaultStatus] = useState<ItemStatus>("inspected_awaiting_listing");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mappedRows, setMappedRows] = useState<MappedCameraStockRow[] | null>(null);
  const [filter, setFilter] = useState<"all" | MappedCameraStockRow["outcome"]>("all");

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

      // 取引先区分は行ごとに異なりうるため、既定値「消費者(個人)」で一律マッピングし、
      // ドライラン結果の表で行ごとに個別選択できるようにする(「仕入・販売帳」取込と同じ方式)。
      const mapped = rawRows.map((raw) => mapCameraStockRawRow(raw, defaultStatus, "consumer"));

      const candidateNos = mapped
        .filter((m) => m.outcome === "new" && m.managementNo)
        .map((m) => m.managementNo as string);
      const existing = await findExistingManagementNos(candidateNos);
      for (const m of mapped) {
        if (m.outcome === "new" && m.managementNo && existing.has(m.managementNo)) {
          m.outcome = "duplicate";
          m.warnings.push("既にシステムに取込済みの管理番号です");
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
    const targets = mappedRows.filter((m) => m.outcome === "new" && m.itemInput);
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
          message: "スキップしました(管理番号が既存の登録済み商品と一致するため、新規登録は行っていません)",
        });
      }
    }
    setExecuteResults(new Map(results));

    let doneCount = 0;
    for (const row of targets) {
      const result = await executeCameraStockImportRow(row);
      results.set(row.rowNumber, result);
      doneCount += 1;
      setExecuteResults(new Map(results));
      setExecuteProgress({ done: doneCount, total: targets.length });
    }
    setExecuting(false);
  }

  function handleRowStatusChange(rowNumber: number, value: ItemStatus) {
    setMappedRows((prev) =>
      prev ? prev.map((r) => (r.rowNumber === rowNumber ? { ...r, finalStatus: value } : r)) : prev,
    );
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

  const summary = mappedRows
    ? {
        new: mappedRows.filter((m) => m.outcome === "new").length,
        duplicate: mappedRows.filter((m) => m.outcome === "duplicate").length,
        error: mappedRows.filter((m) => m.outcome === "error").length,
      }
    : null;

  const executeSuccessCount = Array.from(executeResults.values()).filter((r) => r.success && !r.skipped).length;
  const executeFailCount = Array.from(executeResults.values()).filter((r) => !r.success).length;
  const executeSkippedCount = Array.from(executeResults.values()).filter((r) => r.skipped).length;

  const filteredRows = mappedRows
    ? filter === "all"
      ? mappedRows
      : mappedRows.filter((m) => m.outcome === filter)
    : null;

  const FILTER_OPTIONS: { key: "all" | MappedCameraStockRow["outcome"]; label: string; count: number | null }[] = [
    { key: "all", label: "すべて", count: mappedRows ? mappedRows.length : null },
    { key: "new", label: "新規", count: summary ? summary.new : null },
    { key: "duplicate", label: "重複(スキップ)", count: summary ? summary.duplicate : null },
    { key: "error", label: "エラー", count: summary ? summary.error : null },
  ];

  return (
    <div>
      <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 0, marginBottom: 16 }}>
        「カメラ」エクセルシートの指定行範囲(既定は在庫中の商品が並ぶ2〜151行)を読み込み、商品・仕入データとして
        一括登録します(このシートは在庫中の商品のみが対象で、売上データは作成されません)。まず「ドライラン実行」で
        内容を確認してから、「取込実行」で実際にデータベースへ登録しでください。取込実行は取り消せないため、
        必ずドライラン結果・警告欄を確認してからにしてください。
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
          既定ステータス:
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
        既定ステータス・取引先区分は、下記のドライラン結果の表で商品ごとに個別選択できます。M列(ステータス、S/L等)の
        生の値は、拡張しやすいよう商品の「在庫シートステータスコード」として別途そのまま保存され、既定ステータスの
        自動判定には使用していません(取込前にご臫身で行ごとに選択してください)。
      </p>

      {error && <p style={{ fontSize: 13, color: "var(--danger-text)", marginBottom: 12 }}>{error}</p>}

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
            新規: <strong>{summary.new}</strong>件 / 重複(スキップ): {summary.duplicate}件 / エラー: {summary.error}件
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
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>機種名</th>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>品名</th>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>仕入先</th>
              <th style={{ padding: "6px 4px", fontWeight: 500, textAlign: "right" }}>仕入高</th>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>シートステータス</th>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>登録ステータス</th>
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
                  <td style={{ padding: "6px 4px" }}>{row.raw.model ?? "-"}</td>
                  <td style={{ padding: "6px 4px" }}>{row.raw.itemName ?? "-"}</td>
                  <td style={{ padding: "6px 4px" }}>
                    {[row.raw.sourceMain, row.raw.sourceSub].filter(Boolean).join(" / ") || "-"}
                  </td>
                  <td style={{ padding: "6px 4px", textAlign: "right" }}>
                    {row.raw.purchasePrice != null ? row.raw.purchasePrice.toLocaleString() : "-"}
                  </td>
                  <td style={{ padding: "6px 4px" }}>{row.listingStatusCode ?? "-"}</td>
                  <td style={{ padding: "6px 4px" }}>
                    {row.itemInput ? (
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
                    ) : (
                      "-"
                    )}
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
    </div>
  );
}
