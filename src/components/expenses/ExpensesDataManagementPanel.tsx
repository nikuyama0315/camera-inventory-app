import { useEffect, useState } from "react";
import * as XLSX from "xlsx";
import {
  fetchExpenses,
  getExpensesCount,
  clearAllExpenses,
  type Expense,
} from "../../lib/api/expenses";
import {
  SHEET_CONFIGS,
  mapExpenseRawRow,
  findExistingExpenseKeys,
  markInBatchDuplicateExpenses,
  executeExpenseImportRow,
  type ExpenseRawRow,
  type MappedExpenseRow,
  type ExpenseExecuteResult,
  type SheetColumnConfig,
} from "../../lib/api/expenseExcelImport";
import { parseCsv, buildBackupRawRows, mapBackupRow } from "../../lib/api/expenseBackupRestore";
import { TAX_CATEGORY_OPTIONS, type TaxCategory } from "../../lib/api/expenses";

/**
 * 経費タブの「データ管理」サブタブ: エクセル一括取込・登録データバックアップ・
 * バックアップCSVから復元・危険な操作(経費データ全クリア)をまとめたパネル。
 * 2026-08-29のユーザー指示「経費を登録 と (この4機能) を別のサブタブに分離」により、
 * 元々 ExpensesPage.tsx の左パネル(登録フォーム)の下に縦に並んでいたセクション群を
 * そのまま独立コンポーネントとして切り出したもの。
 */

function cell(row: unknown[], colNumber1Indexed: number): unknown {
  const v = row[colNumber1Indexed - 1];
  return v === undefined ? null : v;
}

function toStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** 種別・対象期間・追跡番号の各セルを結合して「内容」欄を組み立てる(空欄は無視)。 */
function buildDescription(row: unknown[], config: SheetColumnConfig): string | null {
  if (config.descCol != null) {
    return toStr(cell(row, config.descCol));
  }
  const parts: string[] = [];
  if (config.typeCol != null) {
    const v = toStr(cell(row, config.typeCol));
    if (v) parts.push(v);
  }
  if (config.periodCol != null) {
    const v = toStr(cell(row, config.periodCol));
    if (v) parts.push(v);
  }
  if (config.trackingCol != null) {
    const v = toStr(cell(row, config.trackingCol));
    if (v) parts.push(v);
  }
  return parts.length > 0 ? parts.join(" / ") : null;
}

/** 行全体が空欄(見出し行や余白行)かどうかを判定する。 */
function isBlankRow(row: unknown[] | undefined, config: SheetColumnConfig): boolean {
  if (!row) return true;
  return cell(row, config.dateCol) == null && cell(row, config.vendorCol) == null && cell(row, config.amountCol) == null;
}

function buildRawRowsForSheet(aoa: unknown[][], config: SheetColumnConfig): ExpenseRawRow[] {
  const result: ExpenseRawRow[] = [];
  // 1行目はヘッダーとみなし、2行目以降を対象とする。
  for (let r = 2; r <= aoa.length; r++) {
    const row = aoa[r - 1];
    if (isBlankRow(row, config)) continue;

    const taxMark = config.taxMarkCol != null ? toStr(cell(row, config.taxMarkCol)) : null;
    const vendor = toStr(cell(row, config.vendorCol));
    // 送料シート(taxMarkCol無し)は、事業者名が「日本郵便」の行のみ、国際輸送(輸出免税等)とみなし
    // デフォルトを「不課税」にする(ユーザー指示、2026-09-01。eLogi・CPaSS取込のデフォルトと同じ考え方)。
    // それ以外の事業者(国内配送業者など)は従来通り「課税」のまま。
    const taxCategory: TaxCategory =
      config.taxMarkCol != null
        ? taxMark
          ? "課税"
          : "不課税"
        : vendor?.includes("日本郵便")
          ? "不課税"
          : "課税";

    result.push({
      sheetName: config.sheetName,
      rowNumber: r,
      category: config.category,
      dateRaw: cell(row, config.dateCol),
      vendor,
      amountRaw: cell(row, config.amountCol),
      description: buildDescription(row, config),
      taxCategory,
      invoiceRegistrationNo: config.invoiceCol != null ? toStr(cell(row, config.invoiceCol)) : null,
    });
  }
  return result;
}

const OUTCOME_LABELS: Record<MappedExpenseRow["outcome"], string> = {
  new: "新規",
  duplicate: "重複(取込対象)",
  error: "エラー",
};

const OUTCOME_COLORS: Record<MappedExpenseRow["outcome"], string> = {
  new: "var(--text-primary, inherit)",
  duplicate: "var(--text-muted)",
  error: "var(--danger-text)",
};

const CLEAR_EXPENSES_CONFIRM_PHRASE = "経費データ削除";

const BACKUP_CSV_HEADERS = [
  "領収日",
  "カテゴリ",
  "事業者名",
  "内容",
  "金額",
  "課税区分",
  "適格請求書発行事業者番号",
  "領収書保管フォルダ",
  "データ由来",
  "登録日時",
];

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** 経費データ一覧をCSV文字列に変換する(Excelでも文字化けしないようUTF-8 BOM付き)。 */
function buildExpensesBackupCsv(rows: Expense[]): string {
  const lines = [BACKUP_CSV_HEADERS.join(",")];
  for (const e of rows) {
    lines.push(
      [
        e.expense_date,
        e.category,
        e.vendor ?? "",
        e.description ?? "",
        String(e.amount),
        e.tax_category,
        e.invoice_registration_no ?? "",
        e.receipt_folder_path ?? "",
        e.source,
        e.created_at,
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  return "\uFEFF" + lines.join("\r\n");
}

interface ExpensesDataManagementPanelProps {
  onDataChanged: () => Promise<void> | void;
}

export default function ExpensesDataManagementPanel({ onDataChanged }: ExpensesDataManagementPanelProps) {
  // --- エクセル一括取込 ---
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [mappedRows, setMappedRows] = useState<MappedExpenseRow[] | null>(null);
  const [importFilter, setImportFilter] = useState<"all" | MappedExpenseRow["outcome"]>("all");
  const [importExecuting, setImportExecuting] = useState(false);
  const [importResults, setImportResults] = useState<Map<string, ExpenseExecuteResult>>(new Map());
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null);

  // --- 経費データバックアップ ---
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupMessage, setBackupMessage] = useState<string | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);

  // --- バックアップCSVから復元 ---
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreMappedRows, setRestoreMappedRows] = useState<MappedExpenseRow[] | null>(null);
  const [restoreFilter, setRestoreFilter] = useState<"all" | MappedExpenseRow["outcome"]>("all");
  const [restoreExecuting, setRestoreExecuting] = useState(false);
  const [restoreResults, setRestoreResults] = useState<Map<string, ExpenseExecuteResult>>(new Map());
  const [restoreProgress, setRestoreProgress] = useState<{ done: number; total: number } | null>(null);

  // --- 経費データ全クリア ---
  const [expensesCount, setExpensesCount] = useState<number | null>(null);
  const [expensesCountLoading, setExpensesCountLoading] = useState(false);
  const [expensesCountError, setExpensesCountError] = useState<string | null>(null);
  const [clearConfirmText, setClearConfirmText] = useState("");
  const [clearing, setClearing] = useState(false);
  const [clearMessage, setClearMessage] = useState<string | null>(null);
  const [clearError, setClearError] = useState<string | null>(null);

  async function reloadExpensesCount() {
    setExpensesCountLoading(true);
    setExpensesCountError(null);
    try {
      setExpensesCount(await getExpensesCount());
    } catch (err) {
      setExpensesCountError(err instanceof Error ? err.message : "件数の取得に失敗しました");
    } finally {
      setExpensesCountLoading(false);
    }
  }

  useEffect(() => {
    void reloadExpensesCount();
  }, []);

  async function handleBackup() {
    setBackupBusy(true);
    setBackupError(null);
    setBackupMessage(null);
    try {
      // 現在の絞り込み条件に関わらず、全ての経費データをバックアップ対象とする。
      const allExpenses = await fetchExpenses({});
      const csv = buildExpensesBackupCsv(allExpenses);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const now = new Date();
      const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
      const a = document.createElement("a");
      a.href = url;
      a.download = `経費データバックアップ_${stamp}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setBackupMessage(`${allExpenses.length}件の経費データをCSVでダウンロードしました`);
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : "バックアップの作成に失敗しました");
    } finally {
      setBackupBusy(false);
    }
  }

  async function handleRestoreDryRun() {
    if (!restoreFile) {
      setRestoreError("バックアップCSVファイルを選択してください");
      return;
    }
    setRestoreBusy(true);
    setRestoreError(null);
    setRestoreMappedRows(null);
    setRestoreFilter("all");
    setRestoreResults(new Map());
    setRestoreProgress(null);
    try {
      const text = await restoreFile.text();
      const rows = parseCsv(text);
      const { raw, headerError } = buildBackupRawRows(rows);
      if (headerError) {
        throw new Error(headerError);
      }

      const mapped = raw.map((r) => mapBackupRow(r));

      const existingKeys = await findExistingExpenseKeys();
      for (const m of mapped) {
        if (m.outcome === "new" && m.input) {
          const key = `${m.input.expense_date}|${m.input.category}|${m.input.vendor ?? ""}|${m.input.amount}|${m.input.description ?? ""}`;
          if (existingKeys.has(key)) {
            m.outcome = "duplicate";
            m.warnings.push("既にシステムに登録済みのデータと一致します");
          }
        }
      }
      markInBatchDuplicateExpenses(mapped);

      setRestoreMappedRows(mapped);
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : "ドライランに失敗しました");
    } finally {
      setRestoreBusy(false);
    }
  }

  async function handleRestoreExecute() {
    if (!restoreMappedRows) return;
    const targets = restoreMappedRows.filter((m) => (m.outcome === "new" || m.outcome === "duplicate") && m.input);
    if (targets.length === 0) return;
    if (
      !window.confirm(
        `${targets.length}件のデータを実際に復元(登録)します(重複データも含めてすべて復元します)。この操作は取り消せません。よろしいですか?`,
      )
    ) {
      return;
    }
    setRestoreExecuting(true);
    setRestoreProgress({ done: 0, total: targets.length });
    const results = new Map<string, ExpenseExecuteResult>();
    for (const row of targets) {
      const result = await executeExpenseImportRow(row);
      results.set(row.rowId, result);
      setRestoreResults(new Map(results));
      setRestoreProgress({ done: results.size, total: targets.length });
    }
    setRestoreExecuting(false);
    await reloadExpensesCount();
    await onDataChanged();
  }

  async function handleClearAllExpenses() {
    if (clearConfirmText !== CLEAR_EXPENSES_CONFIRM_PHRASE) return;
    const countText = expensesCount != null ? `経費データ${expensesCount}件` : "経費データ";
    if (!window.confirm(`${countText}を完全に削除します。この操作は取り消せません。本当によろしいですか?`)) {
      return;
    }
    setClearing(true);
    setClearError(null);
    setClearMessage(null);
    try {
      await clearAllExpenses();
      setClearMessage("経費データを全て削除しました");
      setClearConfirmText("");
      await reloadExpensesCount();
      await onDataChanged();
    } catch (err) {
      setClearError(err instanceof Error ? err.message : "削除に失敗しました");
    } finally {
      setClearing(false);
    }
  }

  async function handleImportDryRun() {
    if (!importFile) {
      setImportError("エクセルファイルを選択してください");
      return;
    }
    setImportBusy(true);
    setImportError(null);
    setMappedRows(null);
    setImportFilter("all");
    setImportResults(new Map());
    setImportProgress(null);
    try {
      const buffer = await importFile.arrayBuffer();
      const wb = XLSX.read(buffer, { type: "array", cellDates: true });

      const missingSheets = SHEET_CONFIGS.filter((c) => !wb.Sheets[c.sheetName]).map((c) => c.sheetName);
      if (missingSheets.length === SHEET_CONFIGS.length) {
        throw new Error(
          `対象シートが見つかりません(このファイルのシート一覧: ${wb.SheetNames.join(", ")})`,
        );
      }

      const allRaw: ExpenseRawRow[] = [];
      for (const config of SHEET_CONFIGS) {
        const sheet = wb.Sheets[config.sheetName];
        if (!sheet) continue;
        const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null });
        allRaw.push(...buildRawRowsForSheet(aoa, config));
      }

      const mapped = allRaw.map((raw) => mapExpenseRawRow(raw));

      const existingKeys = await findExistingExpenseKeys();
      for (const m of mapped) {
        if (m.outcome === "new" && m.input) {
          const key = `${m.input.expense_date}|${m.input.category}|${m.input.vendor ?? ""}|${m.input.amount}|${m.input.description ?? ""}`;
          if (existingKeys.has(key)) {
            m.outcome = "duplicate";
            m.warnings.push("既にシステムに登録済みのデータと一致します");
          }
        }
      }
      markInBatchDuplicateExpenses(mapped);

      setMappedRows(mapped);
      if (missingSheets.length > 0) {
        setImportError(
          `以下のシートが見つからなかったため、取込対象から除外しました: ${missingSheets.join(", ")}`,
        );
      }
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "ドライランに失敗しました");
    } finally {
      setImportBusy(false);
    }
  }

  /** ドライラン結果表で行ごとに課税区分(課税/不課税)を上書きする(2026-09-01追加)。
   *  取込実行時は m.input.tax_category をそのまま createExpense に渡すため、この値を
   *  更新するだけで取込実行結果に反映される(executeExpenseImportRow側の変更は不要)。 */
  function handleImportRowTaxCategoryChange(rowId: string, value: TaxCategory) {
    setMappedRows((prev) =>
      prev
        ? prev.map((m) => (m.rowId === rowId && m.input ? { ...m, input: { ...m.input, tax_category: value } } : m))
        : prev,
    );
  }

  async function handleImportExecute() {
    if (!mappedRows) return;
    const targets = mappedRows.filter((m) => (m.outcome === "new" || m.outcome === "duplicate") && m.input);
    if (targets.length === 0) return;
    if (
      !window.confirm(
        `${targets.length}件のデータを実際に取り込みます(重複データも含めてすべて取り込みます)。この操作は取り消せません。よろしいですか?`,
      )
    ) {
      return;
    }
    setImportExecuting(true);
    setImportProgress({ done: 0, total: targets.length });
    const results = new Map<string, ExpenseExecuteResult>();
    for (const row of targets) {
      const result = await executeExpenseImportRow(row);
      results.set(row.rowId, result);
      setImportResults(new Map(results));
      setImportProgress({ done: results.size, total: targets.length });
    }
    setImportExecuting(false);
    await onDataChanged();
  }

  const importSummary = mappedRows
    ? {
        new: mappedRows.filter((m) => m.outcome === "new").length,
        duplicate: mappedRows.filter((m) => m.outcome === "duplicate").length,
        error: mappedRows.filter((m) => m.outcome === "error").length,
      }
    : null;

  const importSuccessCount = Array.from(importResults.values()).filter((r) => r.success).length;
  const importFailCount = Array.from(importResults.values()).filter((r) => !r.success).length;

  const filteredImportRows = mappedRows
    ? importFilter === "all"
      ? mappedRows
      : mappedRows.filter((m) => m.outcome === importFilter)
    : null;

  const IMPORT_FILTER_OPTIONS: { key: "all" | MappedExpenseRow["outcome"]; label: string; count: number | null }[] = [
    { key: "all", label: "すべて", count: mappedRows ? mappedRows.length : null },
    { key: "new", label: "新規", count: importSummary ? importSummary.new : null },
    { key: "duplicate", label: "重複(取込対象)", count: importSummary ? importSummary.duplicate : null },
    { key: "error", label: "エラー", count: importSummary ? importSummary.error : null },
  ];

  const restoreSummary = restoreMappedRows
    ? {
        new: restoreMappedRows.filter((m) => m.outcome === "new").length,
        duplicate: restoreMappedRows.filter((m) => m.outcome === "duplicate").length,
        error: restoreMappedRows.filter((m) => m.outcome === "error").length,
      }
    : null;

  const restoreSuccessCount = Array.from(restoreResults.values()).filter((r) => r.success).length;
  const restoreFailCount = Array.from(restoreResults.values()).filter((r) => !r.success).length;

  const filteredRestoreRows = restoreMappedRows
    ? restoreFilter === "all"
      ? restoreMappedRows
      : restoreMappedRows.filter((m) => m.outcome === restoreFilter)
    : null;

  const RESTORE_FILTER_OPTIONS: { key: "all" | MappedExpenseRow["outcome"]; label: string; count: number | null }[] = [
    { key: "all", label: "すべて", count: restoreMappedRows ? restoreMappedRows.length : null },
    { key: "new", label: "新規", count: restoreSummary ? restoreSummary.new : null },
    { key: "duplicate", label: "重複(取込対象)", count: restoreSummary ? restoreSummary.duplicate : null },
    { key: "error", label: "エラー", count: restoreSummary ? restoreSummary.error : null },
  ];

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "1.5rem", boxSizing: "border-box" }}>
      <div style={{ maxWidth: 900 }}>
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 0, marginBottom: 16 }}>
          エクセルからの一括取込、登録データのバックアップ・復元、危険な操作(全クリア)をまとめて行えます。
        </p>

        <div style={{ padding: "14px 16px", border: "0.5px solid var(--border-strong)", borderRadius: 12 }}>
          <button
            type="button"
            onClick={() => setImportOpen((v) => !v)}
            style={{ fontSize: 13, width: "100%", textAlign: "left", fontWeight: 700 }}
          >
            {importOpen ? "▾" : "▸"} エクセルから一括取込
          </button>

          {importOpen && (
            <div style={{ marginTop: 12 }}>
              <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 0, marginBottom: 10 }}>
                消耗品・送料・通信費等・支払報酬・支払手数料・交際費の各シートを読み込み、経費データとして一括登録します。
                まず「ドライラン実行」で内容を確認してから、「取込実行」で実際にデータベースへ登録してください。
                取込実行は取り消せないため、必ずドライラン結果を確認してからにしてください。
              </p>

              <div style={{ marginBottom: 10 }}>
                <input
                  type="file"
                  accept=".xlsx"
                  onChange={(e) => {
                    setImportFile(e.target.files?.[0] ?? null);
                    setMappedRows(null);
                    setImportFilter("all");
                    setImportResults(new Map());
                    setImportError(null);
                  }}
                />
              </div>
              <button onClick={handleImportDryRun} disabled={importBusy || !importFile} style={{ marginBottom: 10 }}>
                {importBusy ? "ドライラン実行中..." : "ドライラン実行"}
              </button>

              {importError && (
                <p style={{ fontSize: 12, color: "var(--danger-text)", marginBottom: 10 }}>{importError}</p>
              )}

              {importSummary && (
                <div
                  style={{
                    marginBottom: 10,
                    padding: "10px 12px",
                    border: "0.5px solid var(--border)",
                    borderRadius: 8,
                  }}
                >
                  <p style={{ fontSize: 12, margin: "0 0 8px" }}>
                    取込対象: <strong>{importSummary.new + importSummary.duplicate}</strong>件 (新規{importSummary.new}件 /
                    重複{importSummary.duplicate}件・重複も取込対象に含みます) / エラー: {importSummary.error}件
                  </p>
                  <button
                    onClick={handleImportExecute}
                    disabled={importExecuting || importSummary.new + importSummary.duplicate === 0}
                  >
                    {importExecuting
                      ? `取込実行中... (${importProgress?.done ?? 0}/${importProgress?.total ?? 0})`
                      : `取込実行(${importSummary.new + importSummary.duplicate}件)`}
                  </button>
                  {importResults.size > 0 && !importExecuting && (
                    <p style={{ fontSize: 12, margin: "8px 0 0" }}>
                      → 完了: 成功{importSuccessCount}件
                      {importFailCount > 0 && (
                        <span style={{ color: "var(--danger-text)" }}> / 失敗{importFailCount}件</span>
                      )}
                    </p>
                  )}
                </div>
              )}

              {mappedRows && (
                <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
                  {IMPORT_FILTER_OPTIONS.map((opt) => (
                    <button
                      key={opt.key}
                      onClick={() => setImportFilter(opt.key)}
                      style={{
                        fontSize: 11,
                        padding: "3px 8px",
                        fontWeight: importFilter === opt.key ? 700 : 400,
                        background: importFilter === opt.key ? "var(--accent)" : undefined,
                        color: importFilter === opt.key ? "var(--surface, #fff)" : undefined,
                      }}
                    >
                      {opt.label}
                      {opt.count != null ? `(${opt.count})` : ""}
                    </button>
                  ))}
                </div>
              )}

              {filteredImportRows && filteredImportRows.length === 0 && (
                <p style={{ fontSize: 12, color: "var(--text-muted)" }}>該当する行はありません</p>
              )}

              {filteredImportRows && filteredImportRows.length > 0 && (
                <div style={{ maxHeight: 420, overflowY: "auto", border: "0.5px solid var(--border)", borderRadius: 8 }}>
                  <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ textAlign: "left", color: "var(--text-secondary)", position: "sticky", top: 0, background: "var(--surface-2, #fff)" }}>
                        <th style={{ padding: "5px 4px", fontWeight: 500 }}>シート/行</th>
                        <th style={{ padding: "5px 4px", fontWeight: 500 }}>状態</th>
                        <th style={{ padding: "5px 4px", fontWeight: 500 }}>領収日</th>
                        <th style={{ padding: "5px 4px", fontWeight: 500 }}>事業者名</th>
                        <th style={{ padding: "5px 4px", fontWeight: 500 }}>内容</th>
                        <th style={{ padding: "5px 4px", fontWeight: 500, textAlign: "right" }}>金額</th>
                        <th style={{ padding: "5px 4px", fontWeight: 500 }}>課税区分</th>
                        <th style={{ padding: "5px 4px", fontWeight: 500 }}>詳細</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredImportRows.map((m) => {
                        const execResult = importResults.get(m.rowId);
                        return (
                          <tr key={m.rowId} style={{ borderTop: "0.5px solid var(--border)" }}>
                            <td style={{ padding: "6px 4px", whiteSpace: "nowrap" }}>
                              {m.raw.sheetName} #{m.raw.rowNumber}
                            </td>
                            <td style={{ padding: "6px 4px", color: OUTCOME_COLORS[m.outcome] }}>
                              {OUTCOME_LABELS[m.outcome]}
                            </td>
                            <td style={{ padding: "6px 4px" }}>{m.input?.expense_date ?? "-"}</td>
                            <td style={{ padding: "6px 4px" }}>{m.raw.vendor ?? "-"}</td>
                            <td style={{ padding: "6px 4px" }}>{m.raw.description ?? "-"}</td>
                            <td style={{ padding: "6px 4px", textAlign: "right" }}>
                              {m.input ? m.input.amount.toLocaleString() : "-"}
                            </td>
                            <td style={{ padding: "6px 4px" }}>
                              {m.input ? (
                                <select
                                  value={m.input.tax_category}
                                  onChange={(e) =>
                                    handleImportRowTaxCategoryChange(m.rowId, e.target.value as TaxCategory)
                                  }
                                  style={{ fontSize: 11 }}
                                >
                                  {TAX_CATEGORY_OPTIONS.map((t) => (
                                    <option key={t} value={t}>
                                      {t}
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                "-"
                              )}
                            </td>
                            <td style={{ padding: "6px 4px" }}>
                              {execResult && (
                                <span style={{ color: execResult.success ? undefined : "var(--danger-text)" }}>
                                  {execResult.message}
                                </span>
                              )}
                              {!execResult && m.errors.length > 0 && (
                                <span style={{ color: "var(--danger-text)" }}>{m.errors.join(" / ")}</span>
                              )}
                              {!execResult && m.errors.length === 0 && m.warnings.length > 0 && (
                                <span style={{ color: "var(--text-muted)" }}>{m.warnings.join(" / ")}</span>
                              )}
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

        <div
          style={{
            marginTop: 24,
            padding: "14px 16px",
            border: "0.5px solid var(--border-strong)",
            borderRadius: 12,
          }}
        >
          <p style={{ fontSize: 13, fontWeight: 700, margin: "0 0 8px" }}>登録データバックアップ</p>
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 8px" }}>
            現在の絞り込み条件に関わらず、登録されている経費データを全件CSVファイルとしてダウンロードします。「経費データ全クリア」などの操作を行う前のバックアップとしてご利用ください。
          </p>
          <button onClick={handleBackup} disabled={backupBusy}>
            {backupBusy ? "バックアップ作成中..." : "経費データをバックアップ(CSVダウンロード)"}
          </button>
          {backupMessage && (
            <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 8 }}>{backupMessage}</p>
          )}
          {backupError && <p style={{ fontSize: 12, color: "var(--danger-text)", marginTop: 8 }}>{backupError}</p>}
        </div>

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
            onClick={() => setRestoreOpen((v) => !v)}
            style={{ fontSize: 13, width: "100%", textAlign: "left", fontWeight: 700 }}
          >
            {restoreOpen ? "▾" : "▸"} バックアップCSVから復元
          </button>

          {restoreOpen && (
            <div style={{ marginTop: 12 }}>
              <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 0, marginBottom: 10 }}>
                「登録データバックアップ」で出力したCSVファイルを読み込み、経費データとして再登録します。
                まず「ドライラン実行」で内容を確認してから、「取込実行」で実際にデータベースへ登録してください。
                取込実行は取り消せないため、必ずドライラン結果を確認してからにしてください。
                なお、復元後の登録日時は復元実行時刻になります(元の登録日時は保持されません)。
              </p>

              <div style={{ marginBottom: 10 }}>
                <input
                  type="file"
                  accept=".csv"
                  onChange={(e) => {
                    setRestoreFile(e.target.files?.[0] ?? null);
                    setRestoreMappedRows(null);
                    setRestoreFilter("all");
                    setRestoreResults(new Map());
                    setRestoreError(null);
                  }}
                />
              </div>
              <button onClick={handleRestoreDryRun} disabled={restoreBusy || !restoreFile} style={{ marginBottom: 10 }}>
                {restoreBusy ? "ドライラン実行中..." : "ドライラン実行"}
              </button>

              {restoreError && (
                <p style={{ fontSize: 12, color: "var(--danger-text)", marginBottom: 10 }}>{restoreError}</p>
              )}

              {restoreSummary && (
                <div
                  style={{
                    marginBottom: 10,
                    padding: "10px 12px",
                    border: "0.5px solid var(--border)",
                    borderRadius: 8,
                  }}
                >
                  <p style={{ fontSize: 12, margin: "0 0 8px" }}>
                    取込対象: <strong>{restoreSummary.new + restoreSummary.duplicate}</strong>件 (新規{restoreSummary.new}件 /
                    重複{restoreSummary.duplicate}件・重複も取込対象に含みます) / エラー: {restoreSummary.error}件
                  </p>
                  <button
                    onClick={handleRestoreExecute}
                    disabled={restoreExecuting || restoreSummary.new + restoreSummary.duplicate === 0}
                  >
                    {restoreExecuting
                      ? `取込実行中... (${restoreProgress?.done ?? 0}/${restoreProgress?.total ?? 0})`
                      : `取込実行(${restoreSummary.new + restoreSummary.duplicate}件)`}
                  </button>
                  {restoreResults.size > 0 && !restoreExecuting && (
                    <p style={{ fontSize: 12, margin: "8px 0 0" }}>
                      → 完了: 成功{restoreSuccessCount}件
                      {restoreFailCount > 0 && (
                        <span style={{ color: "var(--danger-text)" }}> / 失敗{restoreFailCount}件</span>
                      )}
                    </p>
                  )}
                </div>
              )}

              {restoreMappedRows && (
                <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
                  {RESTORE_FILTER_OPTIONS.map((opt) => (
                    <button
                      key={opt.key}
                      onClick={() => setRestoreFilter(opt.key)}
                      style={{
                        fontSize: 11,
                        padding: "3px 8px",
                        fontWeight: restoreFilter === opt.key ? 700 : 400,
                        background: restoreFilter === opt.key ? "var(--accent)" : undefined,
                        color: restoreFilter === opt.key ? "var(--surface, #fff)" : undefined,
                      }}
                    >
                      {opt.label}
                      {opt.count != null ? `(${opt.count})` : ""}
                    </button>
                  ))}
                </div>
              )}

              {filteredRestoreRows && filteredRestoreRows.length === 0 && (
                <p style={{ fontSize: 12, color: "var(--text-muted)" }}>該当する行はありません</p>
              )}

              {filteredRestoreRows && filteredRestoreRows.length > 0 && (
                <div style={{ maxHeight: 420, overflowY: "auto", border: "0.5px solid var(--border)", borderRadius: 8 }}>
                  <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ textAlign: "left", color: "var(--text-secondary)", position: "sticky", top: 0, background: "var(--surface-2, #fff)" }}>
                        <th style={{ padding: "5px 4px", fontWeight: 500 }}>行</th>
                        <th style={{ padding: "5px 4px", fontWeight: 500 }}>状態</th>
                        <th style={{ padding: "5px 4px", fontWeight: 500 }}>領収日</th>
                        <th style={{ padding: "5px 4px", fontWeight: 500 }}>カテゴリ</th>
                        <th style={{ padding: "5px 4px", fontWeight: 500 }}>事業者名</th>
                        <th style={{ padding: "5px 4px", fontWeight: 500, textAlign: "right" }}>金額</th>
                        <th style={{ padding: "5px 4px", fontWeight: 500 }}>詳細</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRestoreRows.map((m) => {
                        const execResult = restoreResults.get(m.rowId);
                        return (
                          <tr key={m.rowId} style={{ borderTop: "0.5px solid var(--border)" }}>
                            <td style={{ padding: "6px 4px", whiteSpace: "nowrap" }}>#{m.raw.rowNumber}</td>
                            <td style={{ padding: "6px 4px", color: OUTCOME_COLORS[m.outcome] }}>
                              {OUTCOME_LABELS[m.outcome]}
                            </td>
                            <td style={{ padding: "6px 4px" }}>{m.input?.expense_date ?? "-"}</td>
                            <td style={{ padding: "6px 4px" }}>{m.raw.category || "-"}</td>
                            <td style={{ padding: "6px 4px" }}>{m.raw.vendor ?? "-"}</td>
                            <td style={{ padding: "6px 4px", textAlign: "right" }}>
                              {m.input ? m.input.amount.toLocaleString() : "-"}
                            </td>
                            <td style={{ padding: "6px 4px" }}>
                              {execResult && (
                                <span style={{ color: execResult.success ? undefined : "var(--danger-text)" }}>
                                  {execResult.message}
                                </span>
                              )}
                              {!execResult && m.errors.length > 0 && (
                                <span style={{ color: "var(--danger-text)" }}>{m.errors.join(" / ")}</span>
                              )}
                              {!execResult && m.errors.length === 0 && m.warnings.length > 0 && (
                                <span style={{ color: "var(--text-muted)" }}>{m.warnings.join(" / ")}</span>
                              )}
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

        <div
          style={{
            marginTop: 24,
            padding: "14px 16px",
            border: "1px solid var(--danger-text)",
            borderRadius: 12,
          }}
        >
          <p style={{ fontSize: 13, fontWeight: 700, color: "var(--danger-text)", margin: "0 0 8px" }}>
            危険な操作: 経費データ全クリア
          </p>
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 8px" }}>
            経費データ(手動登録・エクセル取込を問わず全て)を全件削除します。取り消せません。在庫・仕入・売上データには影響しません。
            eLogi送料CSV・CPaSS請求明細取込のデータは対象外です(「レポート取込」タブから削除してください)。
          </p>
          <p style={{ fontSize: 13, margin: "0 0 8px" }}>
            {expensesCountLoading
              ? "件数を確認中..."
              : expensesCount != null
                ? `現在の経費データ件数: ${expensesCount}件`
                : "件数を取得できませんでした"}
            <button
              onClick={reloadExpensesCount}
              disabled={expensesCountLoading}
              style={{ fontSize: 11, padding: "1px 8px", marginLeft: 8 }}
            >
              再取得
            </button>
          </p>
          {expensesCountError && (
            <p style={{ fontSize: 12, color: "var(--danger-text)", margin: "0 0 8px" }}>{expensesCountError}</p>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              確認のため「{CLEAR_EXPENSES_CONFIRM_PHRASE}」と入力してください:
            </label>
            <input
              type="text"
              value={clearConfirmText}
              onChange={(e) => setClearConfirmText(e.target.value)}
              style={{ width: 160 }}
            />
            <button
              onClick={handleClearAllExpenses}
              disabled={clearing || clearConfirmText !== CLEAR_EXPENSES_CONFIRM_PHRASE}
              style={{ color: "var(--danger-text)", fontWeight: 700 }}
            >
              {clearing ? "削除中..." : "経費データ全クリアを実行"}
            </button>
          </div>
          {clearMessage && (
            <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 8 }}>{clearMessage}</p>
          )}
          {clearError && <p style={{ fontSize: 12, color: "var(--danger-text)", marginTop: 8 }}>{clearError}</p>}
        </div>
      </div>
    </div>
  );
}
