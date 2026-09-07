import { useEffect, useState } from "react";
import {
  buildFreeeCsv,
  fetchSalesFreeeRows,
  fetchPurchasesFreeeRows,
  fetchExpensesFreeeRows,
  type FreeeCsvRow,
  type SettlementInfo,
} from "../lib/api/freeeExport";
import { fetchMonthlyExchangeRates, upsertMonthlyExchangeRate } from "../lib/api/exchangeRates";
import { fetchLatestMufgTtm } from "../lib/api/mufgRate";
import DirectSalesCsvPanel from "../components/csvExport/DirectSalesCsvPanel";

/** "YYYY-MM" を delta ヶ月分シフトした "YYYY-MM" を返す(delta=-1で前月)。 */
function shiftMonth(yearMonth: string, delta: number): string {
  const [y, m] = yearMonth.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

type ExportKind = "sales" | "purchases" | "expenses";

function settlementOf(date: string, account: string): SettlementInfo | undefined {
  return date && account ? { date, account } : undefined;
}

export default function ExportPage() {
  const [yearMonth, setYearMonth] = useState(new Date().toISOString().slice(0, 7));
  const [ttmRate, setTtmRate] = useState("150");
  const [exportingKind, setExportingKind] = useState<ExportKind | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // 円換算用TTMレート(対象月の前月末日のレート)。売上・粗利タブと同じ考え方で
  // monthly_exchange_rates テーブル(月ごとの確定月末TTM)を参照・保存する。
  // ※下記3つのCSV出力自体はこの値を直接は使用しない(売上は各取引時点の為替レートで既に円換算済み、
  //   仕入・経費はもともと円建てのため)。ここでは参考レートの保存・確認用として残している。
  const [monthlyRates, setMonthlyRates] = useState<Record<string, number>>({});
  const [fetchingMufgRate, setFetchingMufgRate] = useState(false);
  const [mufgFetchMessage, setMufgFetchMessage] = useState<string | null>(null);
  const [savingRate, setSavingRate] = useState(false);

  // 決済情報(任意)。指定した場合のみ、各CSVの決済日・決済口座・決済金額列を埋める(未指定なら従来通り空欄)。
  const [salesSettleDate, setSalesSettleDate] = useState("");
  const [salesSettleJpAccount, setSalesSettleJpAccount] = useState("");
  const [salesSettleEbayAccount, setSalesSettleEbayAccount] = useState("");
  const [purchaseSettleDate, setPurchaseSettleDate] = useState("");
  const [purchaseSettleAccount, setPurchaseSettleAccount] = useState("");
  const [expenseSettleDate, setExpenseSettleDate] = useState("");
  const [expenseSettleAccount, setExpenseSettleAccount] = useState("");

  const prevMonth = shiftMonth(yearMonth, -1);
  const savedRate = monthlyRates[prevMonth];
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

  // 対象月(≒その前月)が変わったとき、既に保存済みのレートがあればそれを表示に反映する。
  useEffect(() => {
    const rate = monthlyRates[prevMonth];
    if (rate !== undefined) {
      setTtmRate(String(rate));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yearMonth, monthlyRates]);

  async function handleFetchMufgRate() {
    setFetchingMufgRate(true);
    setMufgFetchMessage(null);
    try {
      const result = await fetchLatestMufgTtm(prevMonth);
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
      await upsertMonthlyExchangeRate(prevMonth, value);
      await reloadMonthlyRates();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "為替レートの保存に失敗しました");
    } finally {
      setSavingRate(false);
    }
  }

  function downloadRows(fileTag: string, rows: FreeeCsvRow[]) {
    const csv = buildFreeeCsv(rows);
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `freee_${fileTag}_${yearMonth}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleExportSales() {
    setExportingKind("sales");
    setErrorMessage(null);
    try {
      const rows = await fetchSalesFreeeRows(yearMonth, {
        jp: settlementOf(salesSettleDate, salesSettleJpAccount),
        ebay: settlementOf(salesSettleDate, salesSettleEbayAccount),
      });
      downloadRows("sales", rows);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "CSV出力に失敗しました");
    } finally {
      setExportingKind(null);
    }
  }

  async function handleExportPurchases() {
    setExportingKind("purchases");
    setErrorMessage(null);
    try {
      const rows = await fetchPurchasesFreeeRows(yearMonth, settlementOf(purchaseSettleDate, purchaseSettleAccount));
      downloadRows("purchases", rows);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "CSV出力に失敗しました");
    } finally {
      setExportingKind(null);
    }
  }

  async function handleExportExpenses() {
    setExportingKind("expenses");
    setErrorMessage(null);
    try {
      const rows = await fetchExpensesFreeeRows(yearMonth, settlementOf(expenseSettleDate, expenseSettleAccount));
      downloadRows("expenses", rows);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "CSV出力に失敗しました");
    } finally {
      setExportingKind(null);
    }
  }

  const busy = exportingKind !== null;

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "1.5rem", paddingBottom: "3rem", boxSizing: "border-box" }}>
      <DirectSalesCsvPanel />

      <hr style={{ margin: "8px 0 24px", border: "none", borderTop: "1px solid var(--border)" }} />

      <div
        style={{
          marginBottom: 16,
          padding: "10px 12px",
          border: "0.5px solid var(--border)",
          borderRadius: 8,
          background: "var(--surface-1)",
        }}
      >
        <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: 0 }}>
          freeeの「取引の一括登録」インポートCSV形式(21列)に準拠した売上・仕入・経費データを、対象月ごとに個別のCSVとして出力します。取引ごとに1行、freeeへそのまま取り込めます。
          売上は国内プラットフォーム分/eBay分を自動で分けて、eBay分は輸出免税(「輸出売上」)として出力します。仕入はインボイス経過措置の控除率(課税仕入10%/課対仕入(控80)10%/課対仕入(控50)10%/対象外)を取引先区分と仕入日から自動判定します。
          いずれも簡略化した自動判定のため、freee取込後に念のため内容をご確認ください。決済日・決済口座は下記の欄に入力した場合のみCSVに反映されます(未入力なら空欄のまま出力され、freee側で「未決済」として扱われます)。
        </p>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
        <label style={{ fontSize: 13, color: "var(--text-secondary)" }}>対象月</label>
        <input type="month" value={yearMonth} onChange={(e) => setYearMonth(e.target.value)} />
        <label style={{ fontSize: 13, color: "var(--text-secondary)" }}>円換算用TTMレート(円/USD・参考)</label>
        <input type="number" value={ttmRate} onChange={(e) => setTtmRate(e.target.value)} style={{ width: 80 }} />
        <button onClick={handleFetchMufgRate} disabled={fetchingMufgRate} style={{ fontSize: 11, padding: "3px 8px" }}>
          {fetchingMufgRate ? "取得中..." : "三菱UFJ公表レートを取得(対象月末)"}
        </button>
        {isRateDirty && (
          <button onClick={handleSaveRate} disabled={savingRate} style={{ fontSize: 11, padding: "3px 8px" }}>
            {savingRate ? "保存中..." : `保存(${prevMonth}分)`}
          </button>
        )}
      </div>

      <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "0 0 16px" }}>
        対象月({yearMonth})の前月末日({prevMonth}末)時点の三菱UFJ銀行TTM(仲値)を表示しています。金額は手動で編集できます。
        このレート自体は下記のCSV出力には使用されません(売上は各取引時点の為替レートで既に円換算済み、仕入・経費は円建てのため)。参考値として保存できます。
        {mufgFetchMessage && (
          <>
            <br />
            {mufgFetchMessage}
          </>
        )}
      </p>

      {errorMessage && <p style={{ color: "var(--danger-text)", fontSize: 13 }}>{errorMessage}</p>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
        <ExportCard title="売上データCSV" onExport={handleExportSales} exporting={exportingKind === "sales"} disabled={busy}>
          <SettleRow label="決済日" type="date" value={salesSettleDate} onChange={setSalesSettleDate} />
          <SettleRow label="国内決済口座" value={salesSettleJpAccount} onChange={setSalesSettleJpAccount} placeholder="例: 楽天銀行" />
          <SettleRow label="eBay決済口座" value={salesSettleEbayAccount} onChange={setSalesSettleEbayAccount} placeholder="例: Payoneer" />
        </ExportCard>

        <ExportCard title="仕入データCSV" onExport={handleExportPurchases} exporting={exportingKind === "purchases"} disabled={busy}>
          <SettleRow label="決済日" type="date" value={purchaseSettleDate} onChange={setPurchaseSettleDate} />
          <SettleRow label="決済口座" value={purchaseSettleAccount} onChange={setPurchaseSettleAccount} placeholder="例: 楽天銀行" />
        </ExportCard>

        <ExportCard title="経費データCSV" onExport={handleExportExpenses} exporting={exportingKind === "expenses"} disabled={busy}>
          <SettleRow label="決済日" type="date" value={expenseSettleDate} onChange={setExpenseSettleDate} />
          <SettleRow label="決済口座" value={expenseSettleAccount} onChange={setExpenseSettleAccount} placeholder="例: 楽天銀行" />
        </ExportCard>
      </div>
    </div>
  );
}

function ExportCard({
  title,
  onExport,
  exporting,
  disabled,
  children,
}: {
  title: string;
  onExport: () => void;
  exporting: boolean;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <div style={{ background: "var(--surface-1)", borderRadius: 8, padding: "1rem", border: "0.5px solid var(--border)" }}>
      <p style={{ fontSize: 13, fontWeight: 500, margin: "0 0 8px" }}>{title}</p>
      <div style={{ marginBottom: 10 }}>{children}</div>
      <p style={{ fontSize: 10, color: "var(--text-muted)", margin: "0 0 8px" }}>
        決済日・決済口座は任意です。両方入力した場合のみCSVの決済日・決済口座・決済金額列に反映されます(決済金額は金額と同額として扱います)。
      </p>
      <button onClick={onExport} disabled={disabled}>
        {exporting ? "出力中..." : `${title}をダウンロード`}
      </button>
    </div>
  );
}

function SettleRow({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
      <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>{label}</label>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: 150, fontSize: 12 }}
      />
    </div>
  );
}
