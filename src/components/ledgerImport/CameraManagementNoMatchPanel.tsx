import { useState } from "react";
import * as XLSX from "xlsx";
import {
  mapCameraMatchRawRow,
  applyCameraManagementNoMatches,
  markInBatchDuplicateTargets,
  findManagementNoOwners,
  markConflictingTargets,
  executeCameraManagementNoUpdateRow,
  type CameraMatchRawRow,
  type MappedCameraMatchRow,
  type ManagementNoUpdateResult,
} from "../../lib/api/cameraManagementNoMatch";

const SHEET_NAME = "カメラ";
const DEFAULT_START_ROW = 154;
const DEFAULT_END_ROW = 716;

// 列番号(1始まり、CameraStockImportPanel.tsx と同じ「カメラ」シートの列レイアウト)
// 2026-09-01(7): 突合方式が「仕入品名・仕入先・仕入先2・仕入高」の4項目一致に変更されたため、
// 突合に使わないB列(仕入日)・F列(新品・古物判定)はここでは読み取らない。
const COL = {
  itemName: 3, // C 仕入品名
  sourceMain: 4, // D 仕入先
  sourceSub: 5, // E 仕入先2
  purchasePrice: 12, // L 仕入高合計(ポイント考慮なし)
  managementNo: 14, // N 管理番号(この値で既存商品を上書きする)
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

/** 仕入品名・管理番号・仕入高がすべて空欄の行は空行とみなして取込対象から除外する。 */
function isBlankRow(row: unknown[]): boolean {
  return (
    toStr(cell(row, COL.itemName)) == null &&
    toStr(cell(row, COL.managementNo)) == null &&
    toNum(cell(row, COL.purchasePrice)) == null
  );
}

function buildRawRows(aoa: unknown[][], startRow: number, endRow: number): CameraMatchRawRow[] {
  const result: CameraMatchRawRow[] = [];
  for (let r = startRow; r <= endRow; r++) {
    const row = aoa[r - 1];
    if (!row) continue;
    if (isBlankRow(row)) continue;

    result.push({
      rowNumber: r,
      itemName: toStr(cell(row, COL.itemName)),
      sourceMain: toStr(cell(row, COL.sourceMain)),
      sourceSub: toStr(cell(row, COL.sourceSub)),
      purchasePrice: toNum(cell(row, COL.purchasePrice)),
      newManagementNoRaw: toStr(cell(row, COL.managementNo)),
    });
  }
  return result;
}

const OUTCOME_LABELS: Record<MappedCameraMatchRow["outcome"], string> = {
  matched: "マッチ(更新対象)",
  unmatched: "未マッチ",
  ambiguous: "複数該当",
  error: "エラー",
};

const OUTCOME_COLORS: Record<MappedCameraMatchRow["outcome"], string> = {
  matched: "var(--text-primary, inherit)",
  unmatched: "var(--text-muted)",
  ambiguous: "var(--danger-text)",
  error: "var(--danger-text)",
};

export default function CameraManagementNoMatchPanel() {
  const [file, setFile] = useState<File | null>(null);
  const [startRow, setStartRow] = useState(DEFAULT_START_ROW);
  const [endRow, setEndRow] = useState(DEFAULT_END_ROW);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mappedRows, setMappedRows] = useState<MappedCameraMatchRow[] | null>(null);
  const [filter, setFilter] = useState<"all" | MappedCameraMatchRow["outcome"]>("all");

  const [executing, setExecuting] = useState(false);
  const [executeResults, setExecuteResults] = useState<Map<number, ManagementNoUpdateResult>>(new Map());
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

      const mapped = rawRows.map((raw) => mapCameraMatchRawRow(raw));
      await applyCameraManagementNoMatches(mapped);
      markInBatchDuplicateTargets(mapped);

      const candidateNewNos = mapped
        .filter((m) => m.outcome === "matched" && !m.noChangeNeeded && m.newManagementNo)
        .map((m) => m.newManagementNo as string);
      const owners = await findManagementNoOwners(candidateNewNos);
      markConflictingTargets(mapped, owners);

      setMappedRows(mapped);
    } catch (err) {
      setError(err instanceof Error ? err.message : "ドライランに失敗しました");
    } finally {
      setBusy(false);
    }
  }

  async function handleExecute() {
    if (!mappedRows) return;
    const targets = mappedRows.filter((m) => m.outcome === "matched");
    if (targets.length === 0) return;
    if (
      !window.confirm(
        `${targets.length}件の既存商品の管理番号を上書き更新します。この操作は取り消せません。よろしいですか?`,
      )
    ) {
      return;
    }
    setExecuting(true);
    setExecuteProgress({ done: 0, total: targets.length });

    const results = new Map<number, ManagementNoUpdateResult>();
    setExecuteResults(new Map(results));

    let doneCount = 0;
    for (const row of targets) {
      const result = await executeCameraManagementNoUpdateRow(row);
      results.set(row.rowNumber, result);
      doneCount += 1;
      setExecuteResults(new Map(results));
      setExecuteProgress({ done: doneCount, total: targets.length });
    }
    setExecuting(false);
  }

  const summary = mappedRows
    ? {
        matched: mappedRows.filter((m) => m.outcome === "matched").length,
        unmatched: mappedRows.filter((m) => m.outcome === "unmatched").length,
        ambiguous: mappedRows.filter((m) => m.outcome === "ambiguous").length,
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

  const FILTER_OPTIONS: { key: "all" | MappedCameraMatchRow["outcome"]; label: string; count: number | null }[] = [
    { key: "all", label: "すべて", count: mappedRows ? mappedRows.length : null },
    { key: "matched", label: "マッチ", count: summary ? summary.matched : null },
    { key: "unmatched", label: "未マッチ", count: summary ? summary.unmatched : null },
    { key: "ambiguous", label: "複数該当", count: summary ? summary.ambiguous : null },
    { key: "error", label: "エラー", count: summary ? summary.error : null },
  ];

  return (
    <div style={{ marginTop: 24 }}>
      <h4 style={{ fontSize: 13, fontWeight: 700, marginTop: 0, marginBottom: 8 }}>
        既存商品との管理番号突合・更新
      </h4>
      <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 0, marginBottom: 16 }}>
        「カメラ」エクセルシートの指定行範囲(既定は154〜716行)を読み込み、「仕入品名・仕入先・仕入先2・
        仕入高」の4項目がすべて一致する既存の登録済み商品を探し、一致した場合はその商品の
        管理番号だけをこの行のN列の値で上書き更新します(商品の他の情報は変更しません)。新規商品の登録は行いません
        (一致しなかった行はそのまま、複数該当し一意に特定できない場合はエラーとして更新対象外にします)。
        まず「ドライラン実行」で内容を確認してから、「更新実行」で実際にデータベースを更新してください。
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
        <button onClick={handleDryRun} disabled={busy || !file}>
          {busy ? "ドライラン実行中..." : "ドライラン実行"}
        </button>
      </div>

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
            マッチ: <strong>{summary.matched}</strong>件 / 未マッチ: {summary.unmatched}件 / 複数該当:{" "}
            {summary.ambiguous}件 / エラー: {summary.error}件
          </span>
          <button onClick={handleExecute} disabled={executing || summary.matched === 0}>
            {executing
              ? `更新実行中... (${executeProgress?.done ?? 0}/${executeProgress?.total ?? 0})`
              : `更新実行(マッチ${summary.matched}件)`}
          </button>
          {executeResults.size > 0 && !executing && (
            <span style={{ fontSize: 13 }}>
              → 完了: 成功{executeSuccessCount}件
              {executeSkippedCount > 0 && (
                <span style={{ color: "var(--text-muted)" }}> / 変更なし{executeSkippedCount}件</span>
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
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>判定</th>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>品名</th>
              <th style={{ padding: "6px 4px", fontWeight: 500, textAlign: "right" }}>仕入高</th>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>現在の管理番号</th>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>新しい管理番号(N列)</th>
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
                  <td style={{ padding: "6px 4px", color: OUTCOME_COLORS[row.outcome] }}>
                    {OUTCOME_LABELS[row.outcome]}
                  </td>
                  <td style={{ padding: "6px 4px" }}>{row.raw.itemName ?? "-"}</td>
                  <td style={{ padding: "6px 4px", textAlign: "right" }}>
                    {row.raw.purchasePrice != null ? row.raw.purchasePrice.toLocaleString() : "-"}
                  </td>
                  <td style={{ padding: "6px 4px" }}>{row.existingManagementNo ?? "-"}</td>
                  <td style={{ padding: "6px 4px" }}>{row.newManagementNo ?? "-"}</td>
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
