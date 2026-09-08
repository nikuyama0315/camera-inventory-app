import { useEffect, useState } from "react";
import { parseCsvFile } from "../lib/csvUtils";
import { fetchMonthlyExchangeRates, upsertMonthlyExchangeRate } from "../lib/api/exchangeRates";
import { fetchLatestMufgTtm } from "../lib/api/mufgRate";
import {
  clearAllReportImportData,
  fetchImportHistory,
  fetchMonthlyImportStatus,
  fetchMonthlyReconciliationSummary,
  fetchReportImportClearLog,
  getReportImportDataCounts,
  analyzeEbayTaxInvoiceCsv,
  importEbayTaxInvoiceRows,
  importEbayTransactionReport,
  importPayoneerReport,
  saveFinancialStatementManualEntry,
  type MonthlyImportStatusRow,
  type MonthlyReconciliationSummary,
  type PlatformImport,
  type ReportImportClearLogEntry,
  type ReportImportDataCounts,
  type TaxInvoiceAnalysis,
} from "../lib/api/reportImports";

const EBAY_ACCOUNTS = ["soulcamera", "soulmenjapan"];

const CLEAR_REPORT_IMPORT_CONFIRM_PHRASE = "レポート取込データ削除";

const PLATFORM_LABELS: Record<string, string> = {
  ebay_financial_statement: "eBay Financial Statement",
  ebay_tax_invoice: "eBay Tax Invoices",
  ebay_transaction_report: "eBay Transaction Report",
  payoneer_transaction_report: "Payoneer Transaction Report",
};

export default function ImportPage() {
  const [history, setHistory] = useState<PlatformImport[]>([]);
  const [reconSummary, setReconSummary] = useState<MonthlyReconciliationSummary[]>([]);
  const [monthlyImportStatus, setMonthlyImportStatus] = useState<MonthlyImportStatusRow[]>([]);
  const [reportImportCounts, setReportImportCounts] = useState<ReportImportDataCounts | null>(null);
  const [reportImportCountsLoading, setReportImportCountsLoading] = useState(false);
  const [reportImportCountsError, setReportImportCountsError] = useState<string | null>(null);
  const [clearReportImportConfirmText, setClearReportImportConfirmText] = useState("");
  const [clearingReportImport, setClearingReportImport] = useState(false);
  const [clearReportImportMessage, setClearReportImportMessage] = useState<string | null>(null);
  const [clearReportImportError, setClearReportImportError] = useState<string | null>(null);
  const [clearLog, setClearLog] = useState<ReportImportClearLogEntry[]>([]);

  async function reloadHistory() {
    try {
      setHistory(await fetchImportHistory());
    } catch {
      // 履歴取得の失敗は致命的ではないため無視
    }
    try {
      setReconSummary(await fetchMonthlyReconciliationSummary());
    } catch {
      // 月次照合サマリー取得の失敗は致命的ではないため無視
    }
    try {
      setMonthlyImportStatus(await fetchMonthlyImportStatus());
    } catch {
      // 取込状況サマリー取得の失敗は致命的ではないため無視
    }
  }

  async function reloadReportImportCounts() {
    setReportImportCountsLoading(true);
    setReportImportCountsError(null);
    try {
      setReportImportCounts(await getReportImportDataCounts());
    } catch (err) {
      setReportImportCountsError(err instanceof Error ? err.message : "件数の取得に失敗しました");
    } finally {
      setReportImportCountsLoading(false);
    }
  }

  async function reloadClearLog() {
    try {
      setClearLog(await fetchReportImportClearLog());
    } catch {
      // 全クリア実行履歴の取得失敗は致命的ではないため無視
    }
  }

  useEffect(() => {
    void reloadHistory();
    void reloadReportImportCounts();
    void reloadClearLog();
  }, []);

  async function handleClearReportImportData() {
    if (clearReportImportConfirmText !== CLEAR_REPORT_IMPORT_CONFIRM_PHRASE) return;
    const totalCount = reportImportCounts
      ? reportImportCounts.platformSettlementImports +
        reportImportCounts.ebayTransactionLines +
        reportImportCounts.ebayTaxInvoiceLines +
        reportImportCounts.payoneerTransactions +
        reportImportCounts.monthlySettlementReconciliations +
        reportImportCounts.monthlyPayoneerSummary
      : null;
    const countText = totalCount != null ? `レポート取込タブのデータ計${totalCount}件` : "レポート取込タブのデータ";
    if (!window.confirm(`${countText}を完全に削除します。この操作は取り消せません。本当によろしいですか?`)) {
      return;
    }
    setClearingReportImport(true);
    setClearReportImportError(null);
    setClearReportImportMessage(null);
    try {
      await clearAllReportImportData();
      setClearReportImportMessage("レポート取込タブのデータを全て削除しました");
      setClearReportImportConfirmText("");
      await reloadReportImportCounts();
      await reloadHistory();
      await reloadClearLog();
    } catch (err) {
      setClearReportImportError(err instanceof Error ? err.message : "削除に失敗しました");
    } finally {
      setClearingReportImport(false);
    }
  }

  function fmtUsd(v: number | null): string {
    return v == null ? "-" : v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtJpy(v: number | null): string {
    return v == null ? "-" : Math.round(v).toLocaleString("ja-JP");
  }
  // 「当月6日経過後、当月分未取込なら警告」の判定に使う当日の日付(1-31)。
  const todayDate = new Date().getDate();

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "1.5rem", paddingBottom: "3rem", boxSizing: "border-box" }}>
      <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 0, marginBottom: 20 }}>
        各レポートのCSVは実データで列名・ヘッダー行の位置(先頭の請求書番号等のメタデータ行を自動で読み飛ばします)を確認済みです。それでも取込件数が0件、または想定と異なる場合はCSVの列名をご確認ください。
      </p>

      <h3 style={{ fontSize: 14, fontWeight: 500, marginTop: 0 }}>取込状況(直近6か月)</h3>
      <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "0 0 8px" }}>
        各レポート・アカウントについて、月ごとに取込済みかどうかを表示します(対象月とデータ期間が重なる取込が1件でもあれば「済」。eBay Financial Statementのみ入力対象年月そのもの)。
        当月について、7日を過ぎても取込が無い場合は行に警告(⚠)を表示します。
      </p>
      <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse", marginBottom: 24 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "var(--text-secondary)" }}>
            <th style={{ padding: "6px 4px", fontWeight: 500 }}>レポート種別</th>
            <th style={{ padding: "6px 4px", fontWeight: 500 }}>アカウント</th>
            {(monthlyImportStatus[0]?.months ?? []).map((cell) => (
              <th key={cell.yearMonth} style={{ padding: "6px 4px", fontWeight: 500, textAlign: "center" }}>
                {cell.yearMonth}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(() => {
            // レポート種別ごとにゼブラ背景色を付ける(アカウント違いは同じ色にする)ため、
            // 出現順のレポート種別一覧から偶数/奇数のグループ番号を求める。
            const platformOrder: typeof monthlyImportStatus[number]["platform"][] = [];
            for (const row of monthlyImportStatus) {
              if (!platformOrder.includes(row.platform)) platformOrder.push(row.platform);
            }
            return monthlyImportStatus.map((row) => {
              const currentMonthCell = row.months[row.months.length - 1];
              // 当月の7日目以降(6日経過後)、当月分が未取込ならこの行に警告を出す。
              const rowAlert = todayDate > 6 && currentMonthCell != null && !currentMonthCell.imported;
              const groupIndex = platformOrder.indexOf(row.platform);
              const zebraBackground = groupIndex % 2 === 1 ? "var(--surface-1)" : undefined;
              return (
                <tr
                  key={`${row.platform}-${row.account ?? "all"}`}
                  style={{
                    borderTop: "0.5px solid var(--border)",
                    background: rowAlert ? "var(--danger-bg)" : zebraBackground,
                  }}
                >
                <td style={{ padding: "6px 4px" }}>
                  {PLATFORM_LABELS[row.platform]}
                  {rowAlert && (
                    <span
                      style={{ marginLeft: 6, color: "var(--danger-text)" }}
                      title="当月分が、当月7日を過ぎても取込まれていません"
                    >
                      ⚠
                    </span>
                  )}
                </td>
                <td style={{ padding: "6px 4px" }}>{row.account ?? "(2アカウント統合)"}</td>
                {row.months.map((cell, idx) => {
                  const isCurrent = idx === row.months.length - 1;
                  const cellAlert = isCurrent && rowAlert;
                  return (
                    <td
                      key={cell.yearMonth}
                      style={{
                        padding: "6px 4px",
                        textAlign: "center",
                        color: cellAlert ? "var(--danger-text)" : cell.imported ? undefined : "var(--text-muted)",
                        fontWeight: cellAlert ? 700 : undefined,
                      }}
                    >
                      {cell.imported ? "済" : cellAlert ? "⚠ 未" : "未"}
                    </td>
                  );
                })}
              </tr>
              );
            });
          })()}
        </tbody>
      </table>

      <TransactionReportSection onImported={reloadHistory} />
      <TaxInvoiceSection onImported={reloadHistory} />
      <PayoneerSection onImported={reloadHistory} />
      <FinancialStatementSection onImported={reloadHistory} />

      <h3 style={{ fontSize: 14, fontWeight: 500, marginTop: 32 }}>月次照合サマリー(eBay Payout合算 vs Payoneer入金)</h3>
      <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "0 0 8px" }}>
        eBay Transaction Report(2アカウント合算)のPayout金額と、Payoneer取込のCredit amount合計を月次で突き合わせます。
        「差額」は入金タイミング差・為替スプレッドの両方を含むため、大きい月は内訳の目視確認を推奨します。
      </p>
      <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse", marginBottom: 24 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "var(--text-secondary)" }}>
            <th style={{ padding: "6px 4px", fontWeight: 500 }}>年月</th>
            <th style={{ padding: "6px 4px", fontWeight: 500 }}>eBay Payout($)</th>
            <th style={{ padding: "6px 4px", fontWeight: 500 }}>eBay Payout(¥)</th>
            <th style={{ padding: "6px 4px", fontWeight: 500 }}>Payoneer入金($)</th>
            <th style={{ padding: "6px 4px", fontWeight: 500 }}>Payoneer入金(¥)</th>
            <th style={{ padding: "6px 4px", fontWeight: 500 }}>差額(¥)</th>
          </tr>
        </thead>
        <tbody>
          {reconSummary.map((r) => (
            <tr key={r.yearMonth} style={{ borderTop: "0.5px solid var(--border)" }}>
              <td style={{ padding: "8px 4px" }}>{r.yearMonth.slice(0, 7)}</td>
              <td style={{ padding: "8px 4px" }}>{fmtUsd(r.ebayPayoutUsdTotal)}</td>
              <td style={{ padding: "8px 4px" }}>{fmtJpy(r.ebayPayoutJpyTotal)}</td>
              <td style={{ padding: "8px 4px" }}>{fmtUsd(r.payoneerCreditUsd)}</td>
              <td style={{ padding: "8px 4px" }}>{fmtJpy(r.payoneerCreditJpy)}</td>
              <td style={{ padding: "8px 4px" }}>{fmtJpy(r.payoneerFeeJpy)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {reconSummary.length === 0 && (
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 24 }}>
          月次照合サマリーはまだありません(Transaction ReportとPayoneerの両方を取込むと表示されます)
        </p>
      )}

      <h3 style={{ fontSize: 14, fontWeight: 500, marginTop: 32 }}>取込履歴(直近30件)</h3>
      <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", color: "var(--text-secondary)" }}>
            <th style={{ padding: "6px 4px", fontWeight: 500 }}>レポート種別</th>
            <th style={{ padding: "6px 4px", fontWeight: 500 }}>アカウント</th>
            <th style={{ padding: "6px 4px", fontWeight: 500 }}>対象期間</th>
            <th style={{ padding: "6px 4px", fontWeight: 500 }}>取込日時</th>
          </tr>
        </thead>
        <tbody>
          {history.map((h) => (
            <tr key={h.id} style={{ borderTop: "0.5px solid var(--border)" }}>
              <td style={{ padding: "8px 4px" }}>{PLATFORM_LABELS[h.platform] ?? h.platform}</td>
              <td style={{ padding: "8px 4px" }}>{h.ebay_account ?? "-"}</td>
              <td style={{ padding: "8px 4px" }}>
                {h.period_start} 〜 {h.period_end}
              </td>
              <td style={{ padding: "8px 4px" }}>{new Date(h.imported_at).toLocaleString("ja-JP")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {history.length === 0 && <p style={{ fontSize: 13, color: "var(--text-muted)" }}>取込履歴はまだありません</p>}
      {clearLog.length > 0 && (
        <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8 }}>
          {clearLog.map((c) => (
            <span key={c.id} style={{ display: "block" }}>
              {new Date(c.cleared_at).toLocaleString("ja-JP")} に「レポート取込データ全クリア」を実行し、
              {c.records_deleted}件のデータを削除しました。
            </span>
          ))}
        </p>
      )}

      <div
        style={{
          marginTop: 24,
          padding: "14px 16px",
          border: "1px solid var(--danger-text)",
          borderRadius: 12,
        }}
      >
        <p style={{ fontSize: 13, fontWeight: 700, color: "var(--danger-text)", margin: "0 0 8px" }}>
          危険な操作: レポート取込データ全クリア
        </p>
        <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 8px" }}>
          このタブから取込んだデータ(eBay Transaction Report・Tax Invoice・Payoneer明細・月次照合サマリー・取込履歴)を全件削除します。取り消せません。「売上・粗利」タブのeBay自動同期データ(ライブ同期)・売上登録・在庫・仕入・経費データには影響しません。
        </p>
        <p style={{ fontSize: 13, margin: "0 0 8px" }}>
          {reportImportCountsLoading
            ? "件数を確認中..."
            : reportImportCounts
              ? `現在の件数: 取込履歴${reportImportCounts.platformSettlementImports}件 / eBay取引明細${reportImportCounts.ebayTransactionLines}件 / 手数料明細${reportImportCounts.ebayTaxInvoiceLines}件 / Payoneer明細${reportImportCounts.payoneerTransactions}件 / 月次照合${reportImportCounts.monthlySettlementReconciliations}件 / Payoneer月次サマリー${reportImportCounts.monthlyPayoneerSummary}件`
              : "件数を取得できませんでした"}
          <button
            onClick={reloadReportImportCounts}
            disabled={reportImportCountsLoading}
            style={{ fontSize: 11, padding: "1px 8px", marginLeft: 8 }}
          >
            再取得
          </button>
        </p>
        {reportImportCountsError && (
          <p style={{ fontSize: 12, color: "var(--danger-text)", margin: "0 0 8px" }}>{reportImportCountsError}</p>
        )}
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            確認のため「{CLEAR_REPORT_IMPORT_CONFIRM_PHRASE}」と入力してください:
          </label>
          <input
            type="text"
            value={clearReportImportConfirmText}
            onChange={(e) => setClearReportImportConfirmText(e.target.value)}
            style={{ width: 180 }}
          />
          <button
            onClick={handleClearReportImportData}
            disabled={clearingReportImport || clearReportImportConfirmText !== CLEAR_REPORT_IMPORT_CONFIRM_PHRASE}
            style={{ color: "var(--danger-text)", fontWeight: 700 }}
          >
            {clearingReportImport ? "削除中..." : "レポート取込データ全クリアを実行"}
          </button>
        </div>
        {clearReportImportMessage && (
          <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 8 }}>{clearReportImportMessage}</p>
        )}
        {clearReportImportError && (
          <p style={{ fontSize: 12, color: "var(--danger-text)", marginTop: 8 }}>{clearReportImportError}</p>
        )}
      </div>
    </div>
  );
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        marginBottom: 16,
        padding: "14px 16px",
        border: "0.5px solid var(--border)",
        borderRadius: 12,
        background: "var(--surface-2)",
      }}
    >
      <p style={{ fontSize: 13, fontWeight: 500, margin: "0 0 10px" }}>{title}</p>
      {children}
    </div>
  );
}

function TransactionReportSection({ onImported }: { onImported: () => void }) {
  const [account, setAccount] = useState(EBAY_ACCOUNTS[0]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      const csv = await parseCsvFile(file, ["Transaction creation date", "Type", "Order number"]);
      const result = await importEbayTransactionReport(csv, account, file.name);
      setIsError(false);
      const skippedNote = result.skippedCount ? `(重複のため${result.skippedCount}件スキップ)` : "";
      setMessage(`${result.rowCount}件取込完了${skippedNote}(${result.periodStart} 〜 ${result.periodEnd})`);
      onImported();
    } catch (err) {
      setIsError(true);
      setMessage(err instanceof Error ? err.message : "取込に失敗しました");
    } finally {
      setBusy(false);
      e.target.value = "";
    }
  }

  return (
    <SectionCard title="eBay Transaction Report(CSV)">
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
        <select value={account} onChange={(e) => setAccount(e.target.value)}>
          {EBAY_ACCOUNTS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <input type="file" accept=".csv" onChange={handleFile} disabled={busy} />
      </div>
      {message && (
        <p style={{ fontSize: 12, color: isError ? "var(--danger-text)" : "var(--text-secondary)" }}>{message}</p>
      )}
    </SectionCard>
  );
}

function TaxInvoiceSection({ onImported }: { onImported: () => void }) {
  const [account, setAccount] = useState(EBAY_ACCOUNTS[0]);
  // TTMレートの対象年月(このレポート自体の対象月の月末TTMを使う。freee CSV出力タブの
  // 「前月末TTM」とは考え方が異なる点に注意。年月を変更すると、既に保存済みのレートが
  // あればそれを自動反映する)。
  // 注: このTTMレート(円/USD)は「月次為替レート」機能(monthly_exchange_rates、freee CSV出力
  // 等で使う円換算用)専用であり、下記のUSD以外通貨(GBP/EUR/AUD等)→USD換算とは無関係。
  // 2026-09-03修正前は誤ってこの円/USDレートをGBP等の金額に乗算していたため、USD以外通貨の
  // 換算ロジックをebay_transaction_lines由来の自動取得+通貨ごとの手動フォールバックに分離した。
  const [yearMonth, setYearMonth] = useState(new Date().toISOString().slice(0, 7));
  const [ttmRate, setTtmRate] = useState("150");
  const [monthlyRates, setMonthlyRates] = useState<Record<string, number>>({});
  const [fetchingMufgRate, setFetchingMufgRate] = useState(false);
  const [mufgFetchMessage, setMufgFetchMessage] = useState<string | null>(null);
  const [savingRate, setSavingRate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  // USD以外通貨→USD換算(2026-09-03追加): ファイル選択時にドライラン解析し、
  // ebay_transaction_lines(Transaction Report取込・eBay受注同期のいずれか)から
  // 自動取得できなかった通貨があれば、通貨ごとの手動レート入力欄を表示してから取込実行する。
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [analysis, setAnalysis] = useState<TaxInvoiceAnalysis | null>(null);
  const [manualRates, setManualRates] = useState<Record<string, string>>({});
  const [analyzing, setAnalyzing] = useState(false);

  const savedRate = monthlyRates[yearMonth];
  const savedRateStr = savedRate !== undefined ? String(savedRate) : "";
  const isRateDirty = ttmRate.trim() !== "" && ttmRate !== savedRateStr;

  async function reloadMonthlyRates() {
    try {
      setMonthlyRates(await fetchMonthlyExchangeRates());
    } catch {
      /* 為替レート一覧の取得失敗は致命的でないため無視 */
    }
  }

  useEffect(() => {
    void reloadMonthlyRates();
  }, []);

  // 対象年月が変わったとき、既に保存済みのレートがあればTTMレート欄に自動反映する。
  useEffect(() => {
    const rate = monthlyRates[yearMonth];
    if (rate !== undefined) {
      setTtmRate(String(rate));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yearMonth, monthlyRates]);

  async function handleFetchMufgRate() {
    setFetchingMufgRate(true);
    setMufgFetchMessage(null);
    try {
      const result = await fetchLatestMufgTtm(yearMonth);
      setTtmRate(String(result.ttm));
      setMufgFetchMessage(
        `${result.source_text}のUSD月末TTM: ${result.ttm}(TTS ${result.tts} / TTB ${result.ttb})を反映しました。内容を確認のうえ「保存」を押してください。`,
      );
    } catch (err) {
      setMufgFetchMessage("取得に失敗しました: " + (err instanceof Error ? err.message : "不明なエラー"));
    } finally {
      setFetchingMufgRate(false);
    }
  }

  async function handleSaveRate() {
    const value = Number(ttmRate);
    if (Number.isNaN(value) || value <= 0) return;
    setSavingRate(true);
    try {
      await upsertMonthlyExchangeRate(yearMonth, value);
      await reloadMonthlyRates();
    } catch {
      /* 保存失敗はこのセクション内で完結させ、取込フロー自体は妨げない */
    } finally {
      setSavingRate(false);
    }
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setAnalyzing(true);
    setMessage(null);
    setAnalysis(null);
    setManualRates({});
    try {
      const csv = await parseCsvFile(file, ["Fee group", "Fee type", "JCT"]);
      const result = await analyzeEbayTaxInvoiceCsv(csv);
      setAnalysis(result);
      setPendingFile(file);
      if (result.unresolvedCurrencies.length === 0) {
        setIsError(false);
        setMessage(
          Object.keys(result.currencyCounts).length > 0
            ? `解析完了。USD以外の通貨(${Object.keys(result.currencyCounts).join("、")})はすべてebay_transaction_linesから換算レートを自動取得できました。内容を確認のうえ「取込実行」を押してください。`
            : "解析完了。全行USD建てです。「取込実行」を押してください。",
        );
      } else {
        setIsError(false);
        setMessage(
          `解析完了。${result.unresolvedCurrencies.join("、")}は換算レートを自動取得できなかったため、下記に手動でレートを入力してから「取込実行」を押してください。`,
        );
      }
    } catch (err) {
      setIsError(true);
      setMessage(err instanceof Error ? err.message : "解析に失敗しました");
      setAnalysis(null);
      setPendingFile(null);
    } finally {
      setAnalyzing(false);
      e.target.value = "";
    }
  }

  async function handleExecuteImport() {
    if (!analysis || !pendingFile) return;
    setBusy(true);
    setMessage(null);
    try {
      const manualRatesByCurrency: Record<string, number> = {};
      for (const currency of analysis.unresolvedCurrencies) {
        const value = Number(manualRates[currency]);
        if (!Number.isFinite(value) || value <= 0) {
          throw new Error(`${currency}のレートを正しく入力してください`);
        }
        manualRatesByCurrency[currency] = value;
      }
      const result = await importEbayTaxInvoiceRows(analysis, account, pendingFile.name, manualRatesByCurrency);
      setIsError(result.unconvertedWarnings.length > 0);
      setMessage(
        `${result.rowCount}件取込完了(${result.periodStart} 〜 ${result.periodEnd})` +
          (result.unconvertedWarnings.length > 0
            ? ` / 警告: ${result.unconvertedWarnings.join(" / ")}`
            : ""),
      );
      setAnalysis(null);
      setPendingFile(null);
      setManualRates({});
      onImported();
    } catch (err) {
      setIsError(true);
      setMessage(err instanceof Error ? err.message : "取込に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard title="eBay Tax Invoices(CSV)">
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
        <select value={account} onChange={(e) => setAccount(e.target.value)}>
          {EBAY_ACCOUNTS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>対象年月:</label>
        <input
          type="month"
          value={yearMonth}
          onChange={(e) => setYearMonth(e.target.value)}
        />
        <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>月次TTMレート(円/USD):</label>
        <input
          type="number"
          value={ttmRate}
          onChange={(e) => setTtmRate(e.target.value)}
          style={{ width: 80 }}
        />
        <button onClick={handleFetchMufgRate} disabled={fetchingMufgRate} style={{ fontSize: 11, padding: "3px 8px" }}>
          {fetchingMufgRate ? "取得中..." : "三菱UFJ公表レートを取得(対象月末)"}
        </button>
        {isRateDirty && (
          <button onClick={handleSaveRate} disabled={savingRate} style={{ fontSize: 11, padding: "3px 8px" }}>
            {savingRate ? "保存中..." : `保存(${yearMonth}分)`}
          </button>
        )}
        <input type="file" accept=".csv" onChange={handleFileSelected} disabled={analyzing || busy} />
      </div>
      <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "0 0 8px" }}>
        対象年月({yearMonth})の月末時点の三菱UFJ銀行TTM(仲値)が保存済みであれば自動反映します(未保存の場合は前回入力値のまま)。このレートは「月次為替レート」機能(freee CSV出力等)専用で、下記のUSD以外通貨→USD換算には使用しません。
        Fee Typeに「Final value」「International」を含む行は`fvf_international`、「Ad」「Advertising」「Promoted」を含む行は`ad_fee`として自動分類します。
        {mufgFetchMessage && (
          <>
            <br />
            {mufgFetchMessage}
          </>
        )}
      </p>
      {analysis && (
        <div
          style={{
            marginBottom: 10,
            padding: "10px 12px",
            border: "0.5px solid var(--border)",
            borderRadius: 8,
          }}
        >
          <p style={{ fontSize: 12, margin: "0 0 8px" }}>
            解析結果: {analysis.rows.length}行
            {Object.keys(analysis.currencyCounts).length > 0 && (
              <>
                (USD以外:{" "}
                {Object.entries(analysis.currencyCounts)
                  .map(([c, n]) => `${c} ${n}件`)
                  .join("、")}
                )
              </>
            )}
          </p>
          {analysis.unresolvedCurrencies.length > 0 && (
            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                自動取得できなかった通貨のレート(→USD)を入力してください:
              </span>
              {analysis.unresolvedCurrencies.map((currency) => (
                <label key={currency} style={{ fontSize: 12, display: "flex", gap: 4, alignItems: "center" }}>
                  {currency}→USD:
                  <input
                    type="number"
                    step="0.0001"
                    value={manualRates[currency] ?? ""}
                    onChange={(e) => setManualRates((prev) => ({ ...prev, [currency]: e.target.value }))}
                    style={{ width: 90 }}
                  />
                </label>
              ))}
            </div>
          )}
          <button onClick={handleExecuteImport} disabled={busy}>
            {busy ? "取込実行中..." : "取込実行"}
          </button>
        </div>
      )}
      {message && (
        <p style={{ fontSize: 12, color: isError ? "var(--danger-text)" : "var(--text-secondary)" }}>{message}</p>
      )}
    </SectionCard>
  );
}

function PayoneerSection({ onImported }: { onImported: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      const csv = await parseCsvFile(file, ["Currency", "Payout method", "Running balance"]);
      const result = await importPayoneerReport(csv, file.name);
      setIsError(false);
      setMessage(`${result.rowCount}件取込完了(${result.periodStart} 〜 ${result.periodEnd})。月次サマリーも自動計算しました。`);
      onImported();
    } catch (err) {
      setIsError(true);
      setMessage(err instanceof Error ? err.message : "取込に失敗しました");
    } finally {
      setBusy(false);
      e.target.value = "";
    }
  }

  return (
    <SectionCard title="Payoneer Transaction Report(CSV・2アカウント統合)">
      <input type="file" accept=".csv" onChange={handleFile} disabled={busy} />
      {message && (
        <p style={{ fontSize: 12, color: isError ? "var(--danger-text)" : "var(--text-secondary)", marginTop: 8 }}>
          {message}
        </p>
      )}
    </SectionCard>
  );
}

function FinancialStatementSection({ onImported }: { onImported: () => void }) {
  const [account, setAccount] = useState(EBAY_ACCOUNTS[0]);
  const [yearMonth, setYearMonth] = useState(new Date().toISOString().slice(0, 7));
  const [payout, setPayout] = useState("");
  const [closingFunds, setClosingFunds] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  async function handleSave() {
    setBusy(true);
    setMessage(null);
    try {
      await saveFinancialStatementManualEntry({
        ebayAccount: account,
        yearMonth,
        payoutUsd: Number(payout) || 0,
        closingFundsUsd: Number(closingFunds) || 0,
      });
      setIsError(false);
      setMessage("保存しました");
      onImported();
    } catch (err) {
      setIsError(true);
      setMessage(err instanceof Error ? err.message : "保存に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard title="eBay Financial Statement(PDF・手動入力)">
      <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "0 0 8px" }}>
        PDF形式のため自動解析は未対応です。PDFの1ページ目に記載のPayout・Closing fundsを見て入力してください。
      </p>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <select value={account} onChange={(e) => setAccount(e.target.value)}>
          {EBAY_ACCOUNTS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <input type="month" value={yearMonth} onChange={(e) => setYearMonth(e.target.value)} />
        <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>Payout(USD):</label>
        <input type="number" value={payout} onChange={(e) => setPayout(e.target.value)} style={{ width: 100 }} />
        <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>Closing funds(USD):</label>
        <input
          type="number"
          value={closingFunds}
          onChange={(e) => setClosingFunds(e.target.value)}
          style={{ width: 100 }}
        />
        <button onClick={handleSave} disabled={busy}>
          保存
        </button>
      </div>
      {message && (
        <p style={{ fontSize: 12, color: isError ? "var(--danger-text)" : "var(--text-secondary)", marginTop: 8 }}>
          {message}
        </p>
      )}
    </SectionCard>
  );
}
