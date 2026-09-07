import { useEffect, useState } from "react";
import { ITEM_STATUS_LABELS, EBAY_ACCOUNT_LABELS, type EbayAccount } from "../../lib/types";
import { COUNTERPARTY_TYPE_OPTIONS } from "../../lib/taxDeduction";
import { parseCsv } from "../../lib/api/expenseBackupRestore";
import {
  ITEMS_CSV_HEADERS,
  INSPECTION_CSV_HEADERS,
  DRIVE_FOLDER_CSV_HEADERS,
  SECTION_MARKERS,
  fetchAllInventoryBackupData,
  splitInventoryBackupSections,
  mapInventoryBackupRows,
  markInBatchDuplicateItems,
  findExistingManagementNos,
  executeInventoryRestoreRow,
  getInventoryDataCounts,
  clearAllInventoryData,
  type InventoryBackupItemRow,
  type InventoryBackupInspectionRow,
  type InventoryBackupDriveFolderRow,
  type MappedInventoryRow,
  type InventoryExecuteResult,
  type InventoryDataCounts,
} from "../../lib/api/inventoryBackupRestore";

const CLEAR_CONFIRM_PHRASE = "全データ削除";

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function numOrBlank(n: number | null): string {
  return n == null ? "" : String(n);
}

const COUNTERPARTY_LABELS: Record<string, string> = Object.fromEntries(
  COUNTERPARTY_TYPE_OPTIONS.map((o) => [o.value, o.label]),
);

function buildItemsSection(rows: InventoryBackupItemRow[]): string[] {
  const lines = [SECTION_MARKERS.items, ITEMS_CSV_HEADERS.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.managementNo,
        r.category,
        r.brand ?? "",
        r.model ?? "",
        r.serialNumber ?? "",
        r.title ?? "",
        ITEM_STATUS_LABELS[r.status],
        r.purchaseDate ?? "",
        r.sourceType ?? "",
        r.sourceName ?? "",
        r.sourceUrl ?? "",
        numOrBlank(r.purchasePrice),
        numOrBlank(r.quantity),
        r.isUsedGoods == null ? "" : r.isUsedGoods ? "古物" : "新品",
        r.counterpartyType ? COUNTERPARTY_LABELS[r.counterpartyType] ?? r.counterpartyType : "",
        r.saleDate ?? "",
        r.saleItemTitle ?? "",
        r.trackingInfo ?? "",
        numOrBlank(r.jpPlatformPrice),
        numOrBlank(r.jpPlatformFee),
        numOrBlank(r.jpPlatformShippingCollected),
        numOrBlank(r.shippingCostPaid),
        numOrBlank(r.ebayPriceUsd),
        numOrBlank(r.ebayShippingCollectedUsd),
        numOrBlank(r.ebayHandlingFeeUsd),
        numOrBlank(r.ebayAdFeeUsd),
        numOrBlank(r.exchangeRate),
        r.account ? EBAY_ACCOUNT_LABELS[r.account as EbayAccount] ?? r.account : "",
      ]
        .map((v) => csvEscape(String(v)))
        .join(","),
    );
  }
  return lines;
}

function buildInspectionsSection(rows: InventoryBackupInspectionRow[]): string[] {
  const lines = [SECTION_MARKERS.inspections, INSPECTION_CSV_HEADERS.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.managementNo,
        r.inspectedBy ?? "",
        r.inspectedAt,
        r.overallNotes ?? "",
        r.overallNotesEn ?? "",
        r.electricalNotes ?? "",
        r.electricalNotesEn ?? "",
        r.shutterNotes ?? "",
        r.shutterNotesEn ?? "",
        r.apertureExposureNotes ?? "",
        r.apertureExposureNotesEn ?? "",
        r.filmTransportNotes ?? "",
        r.filmTransportNotesEn ?? "",
        r.viewfinderNotes ?? "",
        r.viewfinderNotesEn ?? "",
        r.lensNotes ?? "",
        r.lensNotesEn ?? "",
        r.otherNotes ?? "",
        r.otherNotesEn ?? "",
        r.conditionGrade ?? "",
      ]
        .map((v) => csvEscape(String(v)))
        .join(","),
    );
  }
  return lines;
}

function buildDriveFoldersSection(rows: InventoryBackupDriveFolderRow[]): string[] {
  const lines = [SECTION_MARKERS.driveFolders, DRIVE_FOLDER_CSV_HEADERS.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.managementNo,
        r.driveFolderPath,
        r.modelFolderName ?? "",
        r.itemFolderName ?? "",
        r.driveFolderId ?? "",
        r.currentStage ?? "",
        r.registeredAt,
      ]
        .map((v) => csvEscape(String(v)))
        .join(","),
    );
  }
  return lines;
}

const OUTCOME_LABELS: Record<MappedInventoryRow["outcome"], string> = {
  new: "新規",
  duplicate: "重複(スキップ)",
  error: "エラー",
};

const OUTCOME_COLORS: Record<MappedInventoryRow["outcome"], string> = {
  new: "var(--text-primary, inherit)",
  duplicate: "var(--text-muted)",
  error: "var(--danger-text)",
};

interface InventoryBackupPanelProps {
  onDataChanged: () => Promise<void> | void;
}

export default function InventoryBackupPanel({ onDataChanged }: InventoryBackupPanelProps) {
  // 登録データバックアップ
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupMessage, setBackupMessage] = useState<string | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);

  // バックアップCSVから復元
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [mappedRows, setMappedRows] = useState<MappedInventoryRow[] | null>(null);
  const [filter, setFilter] = useState<"all" | MappedInventoryRow["outcome"]>("all");
  const [executing, setExecuting] = useState(false);
  const [executeResults, setExecuteResults] = useState<Map<number, InventoryExecuteResult>>(new Map());
  const [executeProgress, setExecuteProgress] = useState<{ done: number; total: number } | null>(null);

  // 危険な操作: 登録データ全クリア(台帳一括取込タブから移設・バックアップ機能と統合)
  const [counts, setCounts] = useState<InventoryDataCounts | null>(null);
  const [countsLoading, setCountsLoading] = useState(false);
  const [countsError, setCountsError] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [clearing, setClearing] = useState(false);
  const [clearMessage, setClearMessage] = useState<string | null>(null);
  const [clearError, setClearError] = useState<string | null>(null);

  async function reloadCounts() {
    setCountsLoading(true);
    setCountsError(null);
    try {
      setCounts(await getInventoryDataCounts());
    } catch (err) {
      setCountsError(err instanceof Error ? err.message : "件数の取得に失敗しました");
    } finally {
      setCountsLoading(false);
    }
  }

  useEffect(() => {
    void reloadCounts();
  }, []);

  async function handleBackup() {
    setBackupBusy(true);
    setBackupError(null);
    setBackupMessage(null);
    try {
      const data = await fetchAllInventoryBackupData();
      const lines = [
        ...buildItemsSection(data.items),
        ...buildInspectionsSection(data.inspections),
        ...buildDriveFoldersSection(data.driveFolders),
      ];
      const csv = "\uFEFF" + lines.join("\r\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const filename = `在庫データバックアップ_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}.csv`;
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setBackupMessage(
        `商品${data.items.length}件・検品${data.inspections.length}件・Driveフォルダ${data.driveFolders.length}件をバックアップしました(${filename})`,
      );
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : "バックアップに失敗しました");
    } finally {
      setBackupBusy(false);
    }
  }

  async function handleRestoreDryRun() {
    if (!restoreFile) {
      setRestoreError("CSVファイルを選択してください");
      return;
    }
    setRestoreBusy(true);
    setRestoreError(null);
    setMappedRows(null);
    setFilter("all");
    setExecuteResults(new Map());
    setExecuteProgress(null);
    try {
      const text = await restoreFile.text();
      const parsedRows = parseCsv(text);
      const sections = splitInventoryBackupSections(parsedRows);
      if ("sectionError" in sections) {
        throw new Error(sections.sectionError);
      }
      const { rows, headerErrors } = mapInventoryBackupRows(sections);
      if (headerErrors.length > 0) {
        throw new Error(headerErrors.join(" / "));
      }

      const candidateNos = rows
        .filter((m) => m.outcome === "new" && m.managementNo)
        .map((m) => m.managementNo as string);
      const existing = await findExistingManagementNos(candidateNos);
      for (const m of rows) {
        if (m.outcome === "new" && m.managementNo && existing.has(m.managementNo)) {
          m.outcome = "duplicate";
          m.warnings.push("既にシステムに登録済みの管理番号です(検品・Driveフォルダデータもスキップされます)");
        }
      }
      markInBatchDuplicateItems(rows);

      setMappedRows(rows);
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : "ドライランに失敗しました");
    } finally {
      setRestoreBusy(false);
    }
  }

  async function handleRestoreExecute() {
    if (!mappedRows) return;
    const targets = mappedRows.filter((m) => m.outcome === "new" && m.itemInput);
    if (targets.length === 0) return;
    if (
      !window.confirm(`${targets.length}件のデータを実際に復元します。この操作は取り消せません。よろしいですか?`)
    ) {
      return;
    }
    setExecuting(true);
    setExecuteProgress({ done: 0, total: targets.length });
    const results = new Map<number, InventoryExecuteResult>();
    for (const row of targets) {
      const result = await executeInventoryRestoreRow(row);
      results.set(row.rowNumber, result);
      setExecuteResults(new Map(results));
      setExecuteProgress({ done: results.size, total: targets.length });
    }
    setExecuting(false);
    await onDataChanged();
  }

  async function handleClearAll() {
    if (confirmText !== CLEAR_CONFIRM_PHRASE) return;
    const countsText = counts
      ? `在庫${counts.items}件・仕入${counts.purchases}件・売上${counts.sales}件`
      : "システム内の在庫関連データ";
    if (!window.confirm(`${countsText}を完全に削除します。この操作は取り消せません。本当によろしいですか?`)) {
      return;
    }
    setClearing(true);
    setClearError(null);
    setClearMessage(null);
    try {
      await clearAllInventoryData();
      setClearMessage("在庫関連データを全て削除しました");
      setConfirmText("");
      setMappedRows(null);
      setFilter("all");
      setExecuteResults(new Map());
      await reloadCounts();
      await onDataChanged();
    } catch (err) {
      setClearError(err instanceof Error ? err.message : "削除に失敗しました");
    } finally {
      setClearing(false);
    }
  }

  const summary = mappedRows
    ? {
        new: mappedRows.filter((m) => m.outcome === "new").length,
        duplicate: mappedRows.filter((m) => m.outcome === "duplicate").length,
        error: mappedRows.filter((m) => m.outcome === "error").length,
      }
    : null;

  const executeSuccessCount = Array.from(executeResults.values()).filter((r) => r.success).length;
  const executeFailCount = Array.from(executeResults.values()).filter((r) => !r.success).length;

  const filteredRows = mappedRows
    ? filter === "all"
      ? mappedRows
      : mappedRows.filter((m) => m.outcome === filter)
    : null;

  const FILTER_OPTIONS: { key: "all" | MappedInventoryRow["outcome"]; label: string; count: number | null }[] = [
    { key: "all", label: "すべて", count: mappedRows ? mappedRows.length : null },
    { key: "new", label: "新規", count: summary ? summary.new : null },
    { key: "duplicate", label: "重複(スキップ)", count: summary ? summary.duplicate : null },
    { key: "error", label: "エラー", count: summary ? summary.error : null },
  ];

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "1.5rem", boxSizing: "border-box" }}>
      <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 0, marginBottom: 16 }}>
        在庫タブに登録されている商品・仕入・売上・検品・Driveフォルダ紐付けデータの全てを対象に、CSVでのバックアップと復元ができます。
      </p>

      {/* 登録データバックアップ */}
      <div
        style={{
          marginBottom: 16,
          padding: "14px 16px",
          border: "0.5px solid var(--border-strong)",
          borderRadius: 12,
        }}
      >
        <p style={{ fontSize: 13, fontWeight: 700, margin: "0 0 8px" }}>登録データバックアップ</p>
        <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 8px" }}>
          現在登録されている商品・仕入・売上・検品・Driveフォルダ紐付けデータを全件、CSVファイルとして書き出します。
        </p>
        <button onClick={handleBackup} disabled={backupBusy}>
          {backupBusy ? "バックアップ中..." : "バックアップCSVをダウンロード"}
        </button>
        {backupMessage && (
          <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 8 }}>{backupMessage}</p>
        )}
        {backupError && <p style={{ fontSize: 12, color: "var(--danger-text)", marginTop: 8 }}>{backupError}</p>}
      </div>

      {/* バックアップCSVから復元 */}
      <div
        style={{
          marginBottom: 16,
          padding: "14px 16px",
          border: "0.5px solid var(--border-strong)",
          borderRadius: 12,
        }}
      >
        <p
          style={{ fontSize: 13, fontWeight: 700, margin: "0 0 8px", cursor: "pointer" }}
          onClick={() => setRestoreOpen((v) => !v)}
        >
          {restoreOpen ? "▼" : "▶"} バックアップCSVから復元
        </p>
        {restoreOpen && (
          <>
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 8px" }}>
              上記の「登録データバックアップ」で出力したCSVファイルから、商品・仕入・売上・検品・Driveフォルダ紐付けデータを復元します。
              まず「ドライラン実行」で内容を確認してから、「復元実行」で実際にデータベースへ登録してください。
              既に登録済みの管理番号は商品ごとスキップされます(その商品に紐づく検品・Driveフォルダデータも含む)。
            </p>
            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
              <input
                type="file"
                accept=".csv"
                onChange={(e) => {
                  setRestoreFile(e.target.files?.[0] ?? null);
                  setMappedRows(null);
                  setFilter("all");
                  setExecuteResults(new Map());
                  setRestoreError(null);
                }}
              />
              <button onClick={handleRestoreDryRun} disabled={restoreBusy || !restoreFile}>
                {restoreBusy ? "ドライラン実行中..." : "ドライラン実行"}
              </button>
            </div>

            {restoreError && (
              <p style={{ fontSize: 13, color: "var(--danger-text)", marginBottom: 12 }}>{restoreError}</p>
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
                </span>
                <button onClick={handleRestoreExecute} disabled={executing || summary.new === 0}>
                  {executing
                    ? `復元実行中... (${executeProgress?.done ?? 0}/${executeProgress?.total ?? 0})`
                    : `復元実行(新規${summary.new}件)`}
                </button>
                {executeResults.size > 0 && !executing && (
                  <span style={{ fontSize: 13 }}>
                    → 完了: 成功{executeSuccessCount}件
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
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ textAlign: "left", color: "var(--text-secondary)" }}>
                      <th style={{ padding: "6px 4px", fontWeight: 500 }}>行</th>
                      <th style={{ padding: "6px 4px", fontWeight: 500 }}>管理番号</th>
                      <th style={{ padding: "6px 4px", fontWeight: 500 }}>判定</th>
                      <th style={{ padding: "6px 4px", fontWeight: 500 }}>品名</th>
                      <th style={{ padding: "6px 4px", fontWeight: 500, textAlign: "right" }}>仕入高</th>
                      <th style={{ padding: "6px 4px", fontWeight: 500 }}>ステータス</th>
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
                          <td style={{ padding: "6px 4px" }}>{row.displayTitle ?? "-"}</td>
                          <td style={{ padding: "6px 4px", textAlign: "right" }}>
                            {row.displayPurchasePrice != null ? row.displayPurchasePrice.toLocaleString() : "-"}
                          </td>
                          <td style={{ padding: "6px 4px" }}>{ITEM_STATUS_LABELS[row.finalStatus]}</td>
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
                              color: execResult && !execResult.success ? "var(--danger-text)" : undefined,
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
          </>
        )}
      </div>

      {/* 危険な操作: 登録データ全クリア(台帳一括取込タブから移設・バックアップ機能と統合) */}
      <div
        style={{
          marginTop: 24,
          padding: "14px 16px",
          border: "1px solid var(--danger-text)",
          borderRadius: 12,
        }}
      >
        <p style={{ fontSize: 13, fontWeight: 700, color: "var(--danger-text)", margin: "0 0 8px" }}>
          危険な操作: 登録データ全クリア
        </p>
        <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 8px" }}>
          システム内の在庫関連データ(在庫・仕入・売上、および紐づく検品・フォルダ情報など)を全件削除します。手動登録したデータも含め全て消え、取り消せません。
          事前に上記の「登録データバックアップ」でCSVを保存しておくことを推奨します。
        </p>
        <p style={{ fontSize: 13, margin: "0 0 8px" }}>
          {countsLoading
            ? "件数を確認中..."
            : counts
              ? `現在のデータ件数: 在庫${counts.items}件 / 仕入${counts.purchases}件 / 売上${counts.sales}件`
              : "件数を取得できませんでした"}
          <button
            onClick={reloadCounts}
            disabled={countsLoading}
            style={{ fontSize: 11, padding: "1px 8px", marginLeft: 8 }}
          >
            再取得
          </button>
        </p>
        {countsError && (
          <p style={{ fontSize: 12, color: "var(--danger-text)", margin: "0 0 8px" }}>{countsError}</p>
        )}
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            確認のため「{CLEAR_CONFIRM_PHRASE}」と入力してください:
          </label>
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            style={{ width: 160 }}
          />
          <button
            onClick={handleClearAll}
            disabled={clearing || confirmText !== CLEAR_CONFIRM_PHRASE}
            style={{ color: "var(--danger-text)", fontWeight: 700 }}
          >
            {clearing ? "削除中..." : "登録データ全クリアを実行"}
          </button>
        </div>
        {clearMessage && (
          <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 8 }}>{clearMessage}</p>
        )}
        {clearError && <p style={{ fontSize: 12, color: "var(--danger-text)", marginTop: 8 }}>{clearError}</p>}
      </div>
    </div>
  );
}
