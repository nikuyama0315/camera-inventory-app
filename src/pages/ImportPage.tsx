import { useEffect, useState } from "react";
import { parseCsvFile } from "../lib/csvUtils";
import { fetchMonthlyExchangeRates, upsertMonthlyExchangeRate } from "../lib/api/exchangeRates";
import { fetchLatestMufgTtm, fetchMufgCrossRate } from "../lib/api/mufgRate";
import { parsePayoneerForLedger, updateMonthlyLedgerWorkbook } from "../lib/api/monthlyLedger";
import {
  clearAllReportImportData,
  fetchImportHistory,
  fetchMonthlyImportStatus,
  fetchMonthlyReconciliationSummary,
  reportImportRowHasAlert,
  fetchReportImportClearLog,
  getReportImportDataCounts,
  analyzeEbayTaxInvoiceCsv,
  importEbayTaxInvoiceRows,
  importEbayTransactionReport,
  importPayoneerReport,
  parseFinancialStatementXlsx,
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


  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "1.5rem", paddingBottom: "3rem", boxSizing: "border-box" }}>
      <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 0, marginBottom: 20 }}>
        各レポートのCSVは実データで列名・ヘッダー行の位置(先頭の請求書番号等のメタデータ行を自動で読み飛ばします)を確認済みです。それでも取込件数が0件、または想定と異なる場合はCSVの列名をご確認ください。
      </p>

      <h3 style={{ fontSize: 14, fontWeight: 500, marginTop: 0 }}>取込状況(当年1月〜当月)</h3>
      <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "0 0 8px" }}>
        各レポート・アカウントについて、月ごとに取込済みかどうかを表示します(対象月とデータ期間が重なる取込が1件でもあれば「済」。eBay Financial StatementのみPayout/Closing fundsを実際に保存した月のみ「済」)。
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
              // 当月の7日目以降(6日経過後)、当月分が未取込ならこの行に警告を出す(App.tsxの
              // 全ページ共通バナーと同じ判定基準をreportImportRowHasAlert()で共有する)。
              const rowAlert = reportImportRowHasAlert(row);
              const groupIndex = platformOrder.indexOf(row.platform);
              const zebraBackground = groupIndex % 2 === 1 ? "var(--surface-1)" : undefined;
              return (
                <tr
                  key={`${row.platform}-${row.account ?? "all"}`}
                  style={{
                    borderTop: "0.5px solid var(--border)",
                    background: zebraBackground,
                  }}
                >
                <td style={{ padding: "6px 4px" }}>
                  {PLATFORM_LABELS[row.platform]}
                  {rowAlert && (
                    <span
                      style={{ marginLeft: 6, color: "var(--danger-text)", fontWeight: 700 }}
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
  // 2026-09-09追加: 自動取得できなかった通貨について、三菱UFJ公表レートから算出した
  // 「通貨→USD」クロスレートを取得し、手動レート入力欄に反映する(ユーザー指示。
  // 「米ドルと同じ手法で米ドル以外の通貨の該当日のレートを取得して表示」)。
  const [crossRateFetching, setCrossRateFetching] = useState<Record<string, boolean>>({});
  const [crossRateMessages, setCrossRateMessages] = useState<Record<string, string>>({});

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

  /**
   * 2026-09-09追加: 指定した通貨について、analysis.rows内でその通貨かつ自動取得(注文番号一致・
   * 同日一致)できなかった行のうち、最も早い日付を代表日として選ぶ(unresolvedCurrenciesに
   * 挙がる通貨は、この2段階のどちらでも解決できない行を少なくとも1つ含むため必ず見つかる)。
   */
  function representativeUnresolvedDate(currency: string): string | null {
    if (!analysis) return null;
    const resolvedRates = new Map(Object.entries(analysis.resolvedRates));
    const dateResolvedRates = new Map(Object.entries(analysis.dateResolvedRates));
    const dates = analysis.rows
      .filter((r) => r.currency.toUpperCase() === currency && r.line_date)
      .filter((r) => {
        const orderKey = `${r.order_number ?? ""}::${currency}`;
        const dateKey = `${r.line_date ?? ""}::${currency}`;
        return !resolvedRates.has(orderKey) && !dateResolvedRates.has(dateKey);
      })
      .map((r) => r.line_date as string)
      .sort();
    return dates[0] ?? null;
  }

  async function handleFetchCrossRate(currency: string) {
    const date = representativeUnresolvedDate(currency);
    if (!date) return;
    setCrossRateFetching((prev) => ({ ...prev, [currency]: true }));
    setCrossRateMessages((prev) => ({ ...prev, [currency]: "" }));
    try {
      const result = await fetchMufgCrossRate(date, currency);
      setManualRates((prev) => ({ ...prev, [currency]: String(result.rate_to_usd) }));
      setCrossRateMessages((prev) => ({
        ...prev,
        [currency]:
          result.date_used === date
            ? `三菱UFJ公表レート(${result.date_used}時点)から算出。内容を確認してください。`
            : `${date}はデータが無いため、直近の営業日(${result.date_used}時点)の三菱UFJ公表レートから算出。内容を確認してください。`,
      }));
    } catch (err) {
      setCrossRateMessages((prev) => ({
        ...prev,
        [currency]: err instanceof Error ? err.message : "取得に失敗しました",
      }));
    } finally {
      setCrossRateFetching((prev) => ({ ...prev, [currency]: false }));
    }
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setAnalyzing(true);
    setMessage(null);
    setAnalysis(null);
    setManualRates({});
    setCrossRateFetching({});
    setCrossRateMessages({});
    try {
      const csv = await parseCsvFile(file, ["Fee group", "Fee type", "JCT"]);
      const result = await analyzeEbayTaxInvoiceCsv(csv);
      setAnalysis(result);
      setPendingFile(file);
      const excludedNote =
        result.excludedOtherMonthCount > 0
          ? ` (対象月を${result.targetYearMonth.slice(0, 7)}と判定し、それ以外の日付の行${result.excludedOtherMonthCount}件は取込対象から除外しました)`
          : "";
      if (result.unresolvedCurrencies.length === 0) {
        setIsError(false);
        setMessage(
          (Object.keys(result.currencyCounts).length > 0
            ? `解析完了。USD以外の通貨(${Object.keys(result.currencyCounts).join("、")})はすべてebay_transaction_linesから換算レートを自動取得できました。内容を確認のうえ「取込実行」を押してください。`
            : "解析完了。全行USD建てです。「取込実行」を押してください。") + excludedNote,
        );
      } else {
        setIsError(false);
        setMessage(
          `解析完了。${result.unresolvedCurrencies.join("、")}は換算レートを自動取得できなかったため、下記に手動でレートを入力してから「取込実行」を押してください。` +
            excludedNote,
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
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                自動取得できなかった通貨のレート(→USD)を入力してください(「取得」で三菱UFJ公表レートから算出した参考値を反映できます):
              </span>
              {analysis.unresolvedCurrencies.map((currency) => (
                <div key={currency} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <label style={{ fontSize: 12, display: "flex", gap: 4, alignItems: "center" }}>
                    {currency}→USD:
                    <input
                      type="number"
                      step="0.0001"
                      value={manualRates[currency] ?? ""}
                      onChange={(e) => setManualRates((prev) => ({ ...prev, [currency]: e.target.value }))}
                      style={{ width: 90 }}
                    />
                  </label>
                  <button
                    onClick={() => handleFetchCrossRate(currency)}
                    disabled={crossRateFetching[currency]}
                    style={{ fontSize: 11, padding: "2px 8px" }}
                  >
                    {crossRateFetching[currency] ? "取得中..." : "取得"}
                  </button>
                  {crossRateMessages[currency] && (
                    <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                      {crossRateMessages[currency]}
                    </span>
                  )}
                </div>
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
  // 2026-09-09追加: PDFをExcel(.xlsx)に変換したファイルを解析し、Payout・Closing funds・
  // 対象年月・アカウントの候補値を入力欄に反映する(値はそのまま自動保存せず、確認・編集してから
  // 「保存」を押す必要がある。ユーザー指示: 「PDFをWord、Excelに変換したファイルでも解析できないか」)。
  const [parsingXlsx, setParsingXlsx] = useState(false);

  // 2026-09-09追加(ユーザー指示): eBay Financial Statement(上記で解析したPayout・Closing funds)、
  // Payoneer Transaction Report(CSV)、三菱UFJ公表の対象月末レートを、既存の月次売掛金Excel
  // (仕入・販売帳)の該当セルに書き込み、更新後のファイルをダウンロードする機能。
  const [ledgerFile, setLedgerFile] = useState<File | null>(null);
  const [payoneerFile, setPayoneerFile] = useState<File | null>(null);
  const [ledgerBusy, setLedgerBusy] = useState(false);
  const [ledgerMessage, setLedgerMessage] = useState<string | null>(null);
  const [ledgerIsError, setLedgerIsError] = useState(false);

  async function handleXlsxSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setParsingXlsx(true);
    setMessage(null);
    try {
      const buffer = await file.arrayBuffer();
      const result = await parseFinancialStatementXlsx(buffer);
      if (result.payoutUsd == null && result.closingFundsUsd == null) {
        setIsError(true);
        setMessage(
          "Payout・Closing fundsの数値が見つかりませんでした。想定と異なる形式のファイルの可能性があります。手動で入力してください。",
        );
      } else {
        if (result.payoutUsd != null) setPayout(String(result.payoutUsd));
        if (result.closingFundsUsd != null) setClosingFunds(String(result.closingFundsUsd));
        if (result.yearMonth) setYearMonth(result.yearMonth);
        if (result.ebayAccount && (EBAY_ACCOUNTS as string[]).includes(result.ebayAccount)) {
          setAccount(result.ebayAccount);
        }
        setIsError(false);
        setMessage("解析結果を入力欄に反映しました。内容を確認のうえ「保存」を押してください。");
      }
    } catch (err) {
      setIsError(true);
      setMessage(err instanceof Error ? err.message : "解析に失敗しました");
    } finally {
      setParsingXlsx(false);
      e.target.value = "";
    }
  }

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

  async function handleUpdateLedger() {
    setLedgerIsError(false);
    setLedgerMessage(null);
    if (!ledgerFile) {
      setLedgerIsError(true);
      setLedgerMessage("月次売掛金Excelファイルを選択してください");
      return;
    }
    if (!payoneerFile) {
      setLedgerIsError(true);
      setLedgerMessage("Payoneer Transaction Report(CSV)を選択してください");
      return;
    }
    const payoutUsd = Number(payout);
    const closingFundsUsd = Number(closingFunds);
    if (!payout.trim() || !Number.isFinite(payoutUsd) || !closingFunds.trim() || !Number.isFinite(closingFundsUsd)) {
      setLedgerIsError(true);
      setLedgerMessage(
        "Payout・Closing fundsが未入力です。上のPDF変換ファイルを解析するか、手動で入力してください。",
      );
      return;
    }

    setLedgerBusy(true);
    try {
      const payoneerCsv = await parseCsvFile(payoneerFile, ["Currency", "Payout method", "Running balance"]);
      const { creditAmountSum, latestRunningBalance } = parsePayoneerForLedger(payoneerCsv);

      const mufg = await fetchLatestMufgTtm(yearMonth);

      const ledgerBuffer = await ledgerFile.arrayBuffer();
      const { buffer, updatedRowLabels } = await updateMonthlyLedgerWorkbook({
        ledgerBuffer,
        ebayAccount: account,
        yearMonth,
        payoutUsd,
        closingFundsUsd,
        payoneerCreditAmountSum: creditAmountSum,
        payoneerLatestRunningBalance: latestRunningBalance,
        mufgRate: mufg.ttm,
      });

      // 月次売掛金Excelへの反映と合わせて、取込状況(済/未表示)用のDB保存も行う
      await saveFinancialStatementManualEntry({ ebayAccount: account, yearMonth, payoutUsd, closingFundsUsd });
      onImported();

      const blob = new Blob([buffer as BlobPart], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = ledgerFile.name;
      a.click();
      URL.revokeObjectURL(url);

      setLedgerIsError(false);
      setLedgerMessage(
        `更新して ${mufg.source_text}時点の三菱UFJ公表レート(${mufg.ttm})を反映し、ダウンロードしました(更新行: ${updatedRowLabels.join("、")})。`,
      );
    } catch (err) {
      setLedgerIsError(true);
      setLedgerMessage(err instanceof Error ? err.message : "月次売掛金Excelの更新に失敗しました");
    } finally {
      setLedgerBusy(false);
    }
  }

  return (
    <SectionCard title="eBay Financial Statement(PDF・手動入力)">
      <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "0 0 8px" }}>
        PDF自体の自動解析は未対応ですが、PDFをExcel(.xlsx)に変換したファイルであれば下記で解析できます。
        PDFの1ページ目に記載のPayout・Closing fundsを見て入力するか、変換ファイルを選択してください。
      </p>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
        <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          PDFをExcelに変換したファイル(.xlsx):
        </label>
        <input type="file" accept=".xlsx" onChange={handleXlsxSelected} disabled={parsingXlsx} />
        {parsingXlsx && <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>解析中...</span>}
      </div>
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

      <hr style={{ margin: "16px 0", border: "none", borderTop: "0.5px solid var(--border)" }} />

      <p style={{ fontSize: 13, fontWeight: 700, margin: "0 0 8px" }}>月次売掛金Excelの更新</p>
      <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "0 0 8px" }}>
        上記のPayout・Closing funds(アカウント・対象年月含む)と、Payoneer Transaction
        Report(CSV)、三菱UFJ公表の対象月末レートを、アップロードした月次売掛金Excel(仕入・販売帳)の
        該当行に書き込み、更新後のファイルをダウンロードします。対象月・アカウントの行があらかじめ
        用意されているファイルを使用してください(新規行の自動追加はしません)。
      </p>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
        <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>月次売掛金Excel(.xlsx):</label>
        <input
          type="file"
          accept=".xlsx"
          onChange={(e) => setLedgerFile(e.target.files?.[0] ?? null)}
          disabled={ledgerBusy}
        />
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
        <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          Payoneer Transaction Report(CSV):
        </label>
        <input
          type="file"
          accept=".csv"
          onChange={(e) => setPayoneerFile(e.target.files?.[0] ?? null)}
          disabled={ledgerBusy}
        />
      </div>
      <button onClick={handleUpdateLedger} disabled={ledgerBusy}>
        {ledgerBusy ? "更新中..." : "月次売掛金Excelを更新してダウンロード"}
      </button>
      {ledgerMessage && (
        <p
          style={{
            fontSize: 12,
            color: ledgerIsError ? "var(--danger-text)" : "var(--text-secondary)",
            marginTop: 8,
          }}
        >
          {ledgerMessage}
        </p>
      )}
    </SectionCard>
  );
}
