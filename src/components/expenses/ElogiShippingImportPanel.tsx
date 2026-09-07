import { useState } from "react";
import { parseCsv } from "../../lib/api/expenseBackupRestore";
import {
  buildElogiRawRows,
  mapElogiRawRow,
  findExistingElogiInvoiceIds,
  markInBatchDuplicateElogiRows,
  executeElogiImportRow,
  type MappedElogiRow,
  type ElogiExecuteResult,
} from "../../lib/api/elogiShippingImport";

/**
 * 経費タブ「データ管理」サブタブ内、eLogi(海外発送代行サービス)の「発送済一覧」CSVから
 * 送料の経費データを一括登録するパネル。2026-08-31新規追加。
 * 既存の経費エクセル一括取込・バックアップ復元と同じ「ドライラン→取込実行」のUXパターン。
 */

const OUTCOME_LABELS: Record<MappedElogiRow["outcome"], string> = {
  new: "新規",
  duplicate: "重複(スキップ)",
  error: "エラー",
};

const OUTCOME_COLORS: Record<MappedElogiRow["outcome"], string> = {
  new: "var(--text-primary, inherit)",
  duplicate: "var(--text-muted)",
  error: "var(--danger-text)",
};

interface ElogiShippingImportPanelProps {
  onDataChanged: () => Promise<void> | void;
}

export default function ElogiShippingImportPanel({ onDataChanged }: ElogiShippingImportPanelProps) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mappedRows, setMappedRows] = useState<MappedElogiRow[] | null>(null);
  const [filter, setFilter] = useState<"all" | MappedElogiRow["outcome"]>("all");

  const [executing, setExecuting] = useState(false);
  const [executeResults, setExecuteResults] = useState<Map<number, ElogiExecuteResult>>(new Map());
  const [executeProgress, setExecuteProgress] = useState<{ done: number; total: number } | null>(null);

  async function handleDryRun() {
    if (!file) {
      setError("CSVファイルを選択してください");
      return;
    }
    setBusy(true);
    setError(null);
    setMappedRows(null);
    setFilter("all");
    setExecuteResults(new Map());
    setExecuteProgress(null);
    try {
      const text = await file.text();
      const rows = parseCsv(text);
      const rawRows = buildElogiRawRows(rows);
      const mapped = rawRows.map((raw) => mapElogiRawRow(raw, file.name));

      const candidateIds = mapped
        .filter((m) => m.outcome === "new" && m.invoiceIdInitial)
        .map((m) => m.invoiceIdInitial as string);
      const existing = await findExistingElogiInvoiceIds(candidateIds);
      for (const m of mapped) {
        if (m.outcome === "new" && m.invoiceIdInitial && existing.has(m.invoiceIdInitial)) {
          m.outcome = "duplicate";
          m.warnings.push("既にシステムに取込済みの請求書ID(初回注文)です");
        }
      }
      markInBatchDuplicateElogiRows(mapped);

      setMappedRows(mapped);
    } catch (err) {
      setError(err instanceof Error ? err.message : "ドライランに失敗しました");
    } finally {
      setBusy(false);
    }
  }

  async function handleExecute() {
    if (!mappedRows) return;
    const targets = mappedRows.filter((m) => m.outcome === "new" && m.expenseInput && m.shipmentInput);
    if (targets.length === 0) return;
    if (
      !window.confirm(
        `${targets.length}件の送料データを実際に経費として取り込みます。この操作は取り消せません。よろしいですか?`,
      )
    ) {
      return;
    }
    setExecuting(true);
    setExecuteProgress({ done: 0, total: targets.length });

    // 重複としてスキップする行も、実行結果欄にスキップした旨をログとして明示する
    // (「仕入・販売帳」取込等、他の一括取込機能と合じ方針)。
    const results = new Map<number, ElogiExecuteResult>();
    for (const row of mappedRows) {
      if (row.outcome === "duplicate") {
        results.set(row.rowNumber, {
          rowNumber: row.rowNumber,
          invoiceIdInitial: row.invoiceIdInitial,
          success: true,
          skipped: true,
          message: "スキップしました(請求書ID(初回注文)が既存の登録済みデータと一致するため、新規登録は行っていません)",
        });
      }
    }
    setExecuteResults(new Map(results));

    let doneCount = 0;
    for (const row of targets) {
      const result = await executeElogiImportRow(row);
      results.set(row.rowNumber, result);
      doneCount += 1;
      setExecuteResults(new Map(results));
      setExecuteProgress({ done: doneCount, total: targets.length });
    }
    setExecuting(false);
    await onDataChanged();
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

  const FILTER_OPTIONS: { key: "all" | MappedElogiRow["outcome"]; label: string; count: number | null }[] = [
    { key: "all", label: "すべて", count: mappedRows ? mappedRows.length : null },
    { key: "new", label: "新規", count: summary ? summary.new : null },
    { key: "duplicate", label: "重複(スキップ)", count: summary ? summary.duplicate : null },
    { key: "error", label: "エラー", count: summary ? summary.error : null },
  ];

  return (
    <div
      style={{
        marginTop: 24,
        padding: "14px 16px",
        border: "0.5px solid var(--border-strong)",
        borderRadius: 12,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{ fontSize: 13, width: "100%", textAlign: "left", fontWeight: 700 }}
      >
        {open ? "▾" : "▸"} eLogi送料CSV取込
      </button>

      {open && (
        <div style={{ marginTop: 12 }}>
          <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 0, marginBottom: 10 }}>
            eLogi(海外発送代行サービス)の「発送済一覧」CSVを読み込み、送料の経費データとして一括登録します。
            「ラベル印刷日」を領収日、「初回請求金額」+「追加請求/返金金額」の合計を金額として、カテゴリ「送料」・
            事業者名「eLogi」で経費(expenses)に登録します。請求書ID(初回注文・追加請求)・追跡番号・購入者ID・
            eBayオーダー番号・アカウント種類は、会計データとは別に記録用として保管されます(在庫タブ等からは参照しません)。
            まず「ドライラン実行」で内容を確認してから、「取込実行」で実際にデータベースへ登録してください。
            取込実行は取り消せないため、必ずドライラン結果・警告欄を確認してからにしてください。
          </p>

          <div style={{ marginBottom: 10 }}>
            <input
              type="file"
              accept=".csv"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setMappedRows(null);
                setFilter("all");
                setExecuteResults(new Map());
                setError(null);
              }}
            />
          </div>
          <button onClick={handleDryRun} disabled={busy || !file} style={{ marginBottom: 10 }}>
            {busy ? "ドライラン実行中..." : "ドライラン実行"}
          </button>

          {error && <p style={{ fontSize: 12, color: "var(--danger-text)", marginBottom: 10 }}>{error}</p>}

          {summary && (
            <div
              style={{
                marginBottom: 10,
                padding: "10px 12px",
                border: "0.5px solid var(--border)",
                borderRadius: 8,
                display: "flex",
                gap: 16,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <span style={{ fontSize: 12 }}>
                新規: <strong>{summary.new}</strong>件 / 重複(スキップ): {summary.duplicate}件 / エラー:{" "}
                {summary.error}件
              </span>
              <button onClick={handleExecute} disabled={executing || summary.new === 0}>
                {executing
                  ? `取込実行中... (${executeProgress?.done ?? 0}/${executeProgress?.total ?? 0})`
                  : `取込実行(新規${summary.new}件)`}
              </button>
              {executeResults.size > 0 && !executing && (
                <span style={{ fontSize: 12 }}>
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
            <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
              {FILTER_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  onClick={() => setFilter(opt.key)}
                  style={{
                    fontSize: 11,
                    padding: "3px 8px",
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
            <p style={{ fontSize: 12, color: "var(--text-muted)" }}>該当する行はありません</p>
          )}

          {filteredRows && filteredRows.length > 0 && (
            <div style={{ maxHeight: 480, overflow: "auto", border: "0.5px solid var(--border)", borderRadius: 8 }}>
              <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
                <thead>
                  <tr
                    style={{
                      textAlign: "left",
                      color: "var(--text-secondary)",
                      position: "sticky",
                      top: 0,
                      background: "var(--surface-2, #fff)",
                    }}
                  >
                    <th style={{ padding: "5px 4px", fontWeight: 500 }}>行</th>
                    <th style={{ padding: "5px 4px", fontWeight: 500 }}>判定</th>
                    <th style={{ padding: "5px 4px", fontWeight: 500 }}>ラベル印刷日</th>
                    <th style={{ padding: "5px 4px", fontWeight: 500, textAlign: "right" }}>金額(送料)</th>
                    <th style={{ padding: "5px 4px", fontWeight: 500 }}>請求書ID(初回)</th>
                    <th style={{ padding: "5px 4px", fontWeight: 500 }}>請求書ID(追加)</th>
                    <th style={{ padding: "5px 4px", fontWeight: 500 }}>追跡番号</th>
                    <th style={{ padding: "5px 4px", fontWeight: 500 }}>購入者ID</th>
                    <th style={{ padding: "5px 4px", fontWeight: 500 }}>eBayオーダー番号</th>
                    <th style={{ padding: "5px 4px", fontWeight: 500 }}>アカウント種類</th>
                    <th style={{ padding: "5px 4px", fontWeight: 500 }}>エラー・警告</th>
                    <th style={{ padding: "5px 4px", fontWeight: 500 }}>実行結果</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((row) => {
                    const execResult = executeResults.get(row.rowNumber);
                    return (
                      <tr key={row.rowNumber} style={{ borderTop: "0.5px solid var(--border)" }}>
                        <td style={{ padding: "6px 4px", whiteSpace: "nowrap" }}>{row.rowNumber}</td>
                        <td style={{ padding: "6px 4px", color: OUTCOME_COLORS[row.outcome], whiteSpace: "nowrap" }}>
                          {OUTCOME_LABELS[row.outcome]}
                        </td>
                        <td style={{ padding: "6px 4px", whiteSpace: "nowrap" }}>
                          {row.expenseInput?.expense_date ?? "-"}
                        </td>
                        <td style={{ padding: "6px 4px", textAlign: "right", whiteSpace: "nowrap" }}>
                          {row.totalAmount != null ? `¥${row.totalAmount.toLocaleString()}` : "-"}
                        </td>
                        <td style={{ padding: "6px 4px", whiteSpace: "nowrap" }}>{row.raw.invoiceIdInitial ?? "-"}</td>
                        <td style={{ padding: "6px 4px", whiteSpace: "nowrap" }}>
                          {row.raw.invoiceIdAdditional ?? "-"}
                        </td>
                        <td style={{ padding: "6px 4px", whiteSpace: "nowrap" }}>{row.raw.trackingNumber ?? "-"}</td>
                        <td style={{ padding: "6px 4px", whiteSpace: "nowrap" }}>{row.raw.buyerId ?? "-"}</td>
                        <td style={{ padding: "6px 4px", whiteSpace: "nowrap" }}>
                          {row.raw.ebayOrderNumber ?? "-"}
                        </td>
                        <td style={{ padding: "6px 4px", whiteSpace: "nowrap" }}>{row.raw.accountType ?? "-"}</td>
                        <td style={{ padding: "6px 4px", minWidth: 220 }}>
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
                            minWidth: 180,
                            color:
                              execResult && !execResult.success
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
            </div>
          )}
        </div>
      )}
    </div>
  );
}
