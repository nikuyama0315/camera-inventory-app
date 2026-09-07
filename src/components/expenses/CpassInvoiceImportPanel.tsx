import { useState } from "react";
import * as XLSX from "xlsx";
import {
  buildCpassInvoiceRawRows,
  mapCpassInvoiceRawRow,
  findExistingCpassChargeKeys,
  markInBatchDuplicateCpassRows,
  executeCpassInvoiceImportRow,
  type MappedCpassInvoiceRow,
  type CpassInvoiceExecuteResult,
} from "../../lib/api/cpassInvoiceImport";

/**
 * 経費タブ「データ管理」サブタブ内、CPaSS(eBay公式クロスボーダー配送ツール)の請求明細
 * (InvoiceDetails、xlsx)から送料の経費データを一括登録するパネル。2026-08-31新規追加。
 * eLogi送料CSV取込(ElogiShippingImportPanel.tsx)と同じ「ドライラン→取込実行」のUXパターン。
 *
 * 注意: 従来からある「CPaSS配送情報を取り込む」機能(売上・粗利タブ、追跡番号・配送業者の取込)とは
 * 別機能。あちらは配送実績データ、こちらは請求(金額)データを扱う。
 */

const OUTCOME_LABELS: Record<MappedCpassInvoiceRow["outcome"], string> = {
  new: "新規",
  duplicate: "重複(スキップ)",
  error: "エラー",
};

const OUTCOME_COLORS: Record<MappedCpassInvoiceRow["outcome"], string> = {
  new: "var(--text-primary, inherit)",
  duplicate: "var(--text-muted)",
  error: "var(--danger-text)",
};

interface CpassInvoiceImportPanelProps {
  onDataChanged: () => Promise<void> | void;
}

export default function CpassInvoiceImportPanel({ onDataChanged }: CpassInvoiceImportPanelProps) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mappedRows, setMappedRows] = useState<MappedCpassInvoiceRow[] | null>(null);
  const [filter, setFilter] = useState<"all" | MappedCpassInvoiceRow["outcome"]>("all");

  const [executing, setExecuting] = useState(false);
  const [executeResults, setExecuteResults] = useState<Map<number, CpassInvoiceExecuteResult>>(new Map());
  const [executeProgress, setExecuteProgress] = useState<{ done: number; total: number } | null>(null);

  async function handleDryRun() {
    if (!file) {
      setError("ファイルを選択してください");
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
      const wb = XLSX.read(buffer, { type: "array", raw: true });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      if (!sheet) {
        throw new Error("シートが見つかりません");
      }
      const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null });
      const rawRows = buildCpassInvoiceRawRows(aoa);
      const mapped = rawRows.map((raw) => mapCpassInvoiceRawRow(raw, file.name));

      const candidateOrderNos = mapped
        .filter((m) => m.outcome === "new" && m.raw.orderNo)
        .map((m) => m.raw.orderNo as string);
      const existing = await findExistingCpassChargeKeys(candidateOrderNos);
      for (const m of mapped) {
        if (m.outcome === "new" && m.chargeKey && existing.has(m.chargeKey)) {
          m.outcome = "duplicate";
          m.warnings.push("既にシステムに取込済みのデータです(order no・fee type・charge type・transaction timeが一致)");
        }
      }
      markInBatchDuplicateCpassRows(mapped);

      setMappedRows(mapped);
    } catch (err) {
      setError(err instanceof Error ? err.message : "ドライランに失敗しました");
    } finally {
      setBusy(false);
    }
  }

  async function handleExecute() {
    if (!mappedRows) return;
    const targets = mappedRows.filter((m) => m.outcome === "new" && m.expenseInput && m.chargeInput);
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
    // (eLogi送料CSV取込等、他の一括取込機能と同じ方針)。
    const results = new Map<number, CpassInvoiceExecuteResult>();
    for (const row of mappedRows) {
      if (row.outcome === "duplicate") {
        results.set(row.rowNumber, {
          rowNumber: row.rowNumber,
          orderNo: row.raw.orderNo,
          success: true,
          skipped: true,
          message: "スキップしました(既存の登録済みデータと一致するため、新規登録は行っていません)",
        });
      }
    }
    setExecuteResults(new Map(results));

    let doneCount = 0;
    for (const row of targets) {
      const result = await executeCpassInvoiceImportRow(row);
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

  const FILTER_OPTIONS: { key: "all" | MappedCpassInvoiceRow["outcome"]; label: string; count: number | null }[] = [
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
        {open ? "▾" : "▸"} CPaSS請求明細取込
      </button>

      {open && (
        <div style={{ marginTop: 12 }}>
          <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 0, marginBottom: 10 }}>
            CPaSS(eBay公式クロスボーダー配送ツール)の請求明細(InvoiceDetails)エクスポート(xlsx)を読み込み、
            送料の経費データとして一括登録します。「invoice period」の終了日を領収日、行ごとの「amount」を
            金額として、カテゴリ「送料」・事業者名「CPaSS」で経費(expenses)に登録します。order no・fee
            type・charge type・transaction timeは、会計データとは別に記録用として保管されます(order noは
            販売済み商品の追跡情報と紐づくキーです)。まず「ドライラン実行」で内容を確認してから、「取込実行」で
            実際にデータベースへ登録してください。取込実行は取り消せないため、必ずドライラン結果・警告欄を
            確認してからにしてください。従来の「CPaSS配送情報を取り込む」(追跡番号・配送業者、売上・粗利タブ)
            とは別機能です。
          </p>

          <div style={{ marginBottom: 10 }}>
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
                    <th style={{ padding: "5px 4px", fontWeight: 500 }}>領収日(期間終了)</th>
                    <th style={{ padding: "5px 4px", fontWeight: 500, textAlign: "right" }}>金額(送料)</th>
                    <th style={{ padding: "5px 4px", fontWeight: 500 }}>invoice period</th>
                    <th style={{ padding: "5px 4px", fontWeight: 500 }}>order no</th>
                    <th style={{ padding: "5px 4px", fontWeight: 500 }}>fee type</th>
                    <th style={{ padding: "5px 4px", fontWeight: 500 }}>charge type</th>
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
                          {row.expenseInput ? `¥${row.expenseInput.amount.toLocaleString()}` : "-"}
                        </td>
                        <td style={{ padding: "6px 4px", whiteSpace: "nowrap" }}>{row.raw.invoicePeriodRaw ?? "-"}</td>
                        <td style={{ padding: "6px 4px", whiteSpace: "nowrap" }}>{row.raw.orderNo ?? "-"}</td>
                        <td style={{ padding: "6px 4px", whiteSpace: "nowrap" }}>{row.raw.feeType ?? "-"}</td>
                        <td style={{ padding: "6px 4px", whiteSpace: "nowrap" }}>{row.raw.chargeType ?? "-"}</td>
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
