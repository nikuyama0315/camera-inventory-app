import { useEffect, useMemo, useRef, useState } from "react";
import {
  bulkUpdateExchangeRateForMonth,
  createSale,
  deleteSale,
  fetchItemForSaleById,
  fetchSalesList,
  fetchSalesSummaryBreakdown,
  searchItemsForSale,
  searchItemsByCustomLabel,
  updateSale,
  type ItemForSale,
  type SalesPeriodFilter,
  type SalesSummary,
  type MonthlySalesSummary,
  type SaleWithItem,
} from "../lib/api/sales";
import { fetchMonthlyExchangeRates, upsertMonthlyExchangeRate } from "../lib/api/exchangeRates";
import { fetchLatestMufgTtm } from "../lib/api/mufgRate";
import {
  ebayRowToUsd,
  fetchEbayReviewQueue,
  ignoreEbayTransactionLine,
  linkEbayTransactionLineToItem,
  markEbayTransactionLineRegistered,
  triggerEbaySync,
  type EbayReviewRow,
} from "../lib/api/ebaySync";
import {
  executeCpassImport,
  parseCpassFile,
  previewCpassRows,
  upsertManualShippingFee,
  type CpassPreviewRow,
} from "../lib/api/cpassImport";
import { getSalesTabDataCounts, clearAllSalesTabData, type SalesTabDataCounts } from "../lib/api/ebaySync";
import { EBAY_ACCOUNT_LABELS, EBAY_ACCOUNT_OPTIONS, EBAY_SYNC_SHOP_IDS } from "../lib/types";
import EbayXlsxFillPanel from "../components/sales/EbayXlsxFillPanel";

const CLEAR_SALES_TAB_CONFIRM_PHRASE = "売上データ削除";

const CURRENT_YEAR = new Date().getFullYear();
const CURRENT_MONTH = new Date().getMonth() + 1;
const YEAR_OPTIONS = [CURRENT_YEAR, CURRENT_YEAR - 1, CURRENT_YEAR - 2];
const MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => i + 1);

interface FormState {
  itemQuery: string;
  selectedItem: ItemForSale | null;
  sale_date: string;
  sale_item_title: string;
  tracking_info: string;
  jp_platform_price: string;
  jp_platform_fee: string;
  jp_platform_shipping_collected: string;
  shipping_cost_paid: string;
  ebay_price_usd: string;
  ebay_shipping_collected_usd: string;
  ebay_handling_fee_usd: string;
  ebay_ad_fee_usd: string;
  exchange_rate: string;
  account: string;
}

const EMPTY_FORM: FormState = {
  itemQuery: "",
  selectedItem: null,
  sale_date: new Date().toISOString().slice(0, 10),
  sale_item_title: "",
  tracking_info: "",
  jp_platform_price: "0",
  jp_platform_fee: "0",
  jp_platform_shipping_collected: "0",
  shipping_cost_paid: "0",
  ebay_price_usd: "0",
  ebay_shipping_collected_usd: "0",
  ebay_handling_fee_usd: "0",
  ebay_ad_fee_usd: "0",
  exchange_rate: "150",
  account: "",
};

function num(v: string): number {
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

type SalesSortColumn = "sale_date" | "management_no";

function salesSortValue(s: SaleWithItem, column: SalesSortColumn): string {
  if (column === "sale_date") return s.sale_date ?? "";
  return s.items?.management_no ?? "";
}

export default function SalesPage() {
  const [periodType, setPeriodType] = useState<"all" | "year" | "month">("month");
  const [year, setYear] = useState(CURRENT_YEAR);
  const [month, setMonth] = useState(CURRENT_MONTH);
  const [toYear, setToYear] = useState(CURRENT_YEAR);
  const [toMonth, setToMonth] = useState(CURRENT_MONTH);

  const [summary, setSummary] = useState<SalesSummary | null>(null);
  const [monthlySummaries, setMonthlySummaries] = useState<MonthlySalesSummary[]>([]);
  const [list, setList] = useState<SaleWithItem[]>([]);
  const [salesSortColumn, setSalesSortColumn] = useState<SalesSortColumn | null>(null);
  const [salesSortDirection, setSalesSortDirection] = useState<"asc" | "desc">("asc");
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [candidates, setCandidates] = useState<ItemForSale[]>([]);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [editingSaleId, setEditingSaleId] = useState<string | null>(null);
  const formSectionRef = useRef<HTMLDivElement>(null);
  /** 売上一覧テーブルの折りたたみ表示(2026-09-04追加、直販プラットフォーム登録用CSV作成の一覧折りたたみと同じパターン)。 */
  const [isSalesListCollapsed, setIsSalesListCollapsed] = useState(false);

  function scrollToFormSection() {
    formSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // 月次為替レート(対象月ごとに指定できる参照テーブル)
  const [monthlyRates, setMonthlyRates] = useState<Record<string, number>>({});
  const [monthlyRateEdits, setMonthlyRateEdits] = useState<Record<string, string>>({});
  const [savingMonthlyRate, setSavingMonthlyRate] = useState<string | null>(null);
  const [justSavedMonth, setJustSavedMonth] = useState<string | null>(null);
  const [bulkApplying, setBulkApplying] = useState<string | null>(null);
  const [bulkApplyMessage, setBulkApplyMessage] = useState<string | null>(null);
  const [fetchingMufgRate, setFetchingMufgRate] = useState<string | null>(null);
  const [mufgFetchMessage, setMufgFetchMessage] = useState<string | null>(null);

  // eBay自動取得(受注同期・レビューキュー)
  const [reviewQueue, setReviewQueue] = useState<EbayReviewRow[]>([]);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [ebaySyncing, setEbaySyncing] = useState(false);
  const [ebaySyncMessage, setEbaySyncMessage] = useState<string | null>(null);
  const [pendingEbayLineId, setPendingEbayLineId] = useState<string | null>(null);
  const [unmatchedQuery, setUnmatchedQuery] = useState<Record<string, string>>({});
  const [unmatchedCandidates, setUnmatchedCandidates] = useState<Record<string, ItemForSale[]>>({});
  const [linkingRowId, setLinkingRowId] = useState<string | null>(null);
  const [rematchingRowId, setRematchingRowId] = useState<string | null>(null);
  const [syncShopId, setSyncShopId] = useState<"soulcamera" | "soulmenjapan">("soulmenjapan");
  /** eBay受注レビュー一覧(reviewQueue)の折りたたみ表示(2026-09-04追加、件数が多いと登録フォームまで遠くなるため)。 */
  const [isReviewQueueCollapsed, setIsReviewQueueCollapsed] = useState(false);
  const [accountFilter, setAccountFilter] = useState<string>("");

  const [cpassFile, setCpassFile] = useState<File | null>(null);
  const [cpassBusy, setCpassBusy] = useState(false);
  const [cpassError, setCpassError] = useState<string | null>(null);
  const [cpassPreview, setCpassPreview] = useState<CpassPreviewRow[] | null>(null);
  const [cpassImporting, setCpassImporting] = useState(false);
  const [cpassMessage, setCpassMessage] = useState<string | null>(null);
  const [cpassFeeEdits, setCpassFeeEdits] = useState<Record<string, string>>({});
  const [savingCpassFee, setSavingCpassFee] = useState<string | null>(null);

  // 危険な操作: 売上・粗利タブデータ全クリア(2026-08-31追加)
  const [salesTabCounts, setSalesTabCounts] = useState<SalesTabDataCounts | null>(null);
  const [salesTabCountsLoading, setSalesTabCountsLoading] = useState(false);
  const [salesTabCountsError, setSalesTabCountsError] = useState<string | null>(null);
  const [clearSalesTabConfirmText, setClearSalesTabConfirmText] = useState("");
  const [clearingSalesTab, setClearingSalesTab] = useState(false);
  const [clearSalesTabMessage, setClearSalesTabMessage] = useState<string | null>(null);
  const [clearSalesTabError, setClearSalesTabError] = useState<string | null>(null);

  async function handleFetchMufgRate(ym: string) {
    setFetchingMufgRate(ym);
    setMufgFetchMessage(null);
    try {
      const result = await fetchLatestMufgTtm(ym);
      setMonthlyRateEdits((prev) => ({ ...prev, [result.year_month]: String(result.ttm) }));
      setMufgFetchMessage(
        `${result.source_text}のUSD月末TTM: ${result.ttm}(TTS ${result.tts} / TTB ${result.ttb})を「${result.year_month}」欄に反映しました。内容を確認のうえ「保存」を押してください。`,
      );
    } catch (err) {
      setMufgFetchMessage(
        `${ym}分の取得に失敗しました: ` + (err instanceof Error ? err.message : "不明なエラー"),
      );
    } finally {
      setFetchingMufgRate(null);
    }
  }

  async function reloadMonthlyRates() {
    try {
      const rates = await fetchMonthlyExchangeRates();
      setMonthlyRates(rates);
    } catch {
      /* 為替レート一覧の取得失敗は致命的でないため無視 */
    }
  }

  async function handleSaveMonthlyRate(ym: string) {
    const value = Number(monthlyRateEdits[ym]);
    if (Number.isNaN(value) || value <= 0) return;
    setSavingMonthlyRate(ym);
    try {
      await upsertMonthlyExchangeRate(ym, value);
      await reloadMonthlyRates();
      setJustSavedMonth(ym);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "為替レートの保存に失敗しました");
    } finally {
      setSavingMonthlyRate(null);
    }
  }

  async function handleBulkApplyRate(ym: string) {
    const rate = monthlyRates[ym];
    if (rate === undefined) return;
    setBulkApplying(ym);
    setBulkApplyMessage(null);
    try {
      const count = await bulkUpdateExchangeRateForMonth(ym, rate);
      setBulkApplyMessage(`${ym}分の登録済み売上${count}件のレートを${rate}に更新しました。`);
      setJustSavedMonth(null);
      await reload();
    } catch (err) {
      setBulkApplyMessage(
        "一括更新に失敗しました: " + (err instanceof Error ? err.message : "不明なエラー"),
      );
    } finally {
      setBulkApplying(null);
    }
  }

  async function reloadReviewQueue() {
    setReviewLoading(true);
    try {
      const rows = await fetchEbayReviewQueue();
      setReviewQueue(rows);
    } catch {
      /* レビューキューの取得失敗は致命的でないため無視(次回同期時に再取得される) */
    } finally {
      setReviewLoading(false);
    }
  }

  async function handleEbaySync() {
    setEbaySyncing(true);
    setEbaySyncMessage(null);
    try {
      const result = await triggerEbaySync(syncShopId, 90);
      setEbaySyncMessage(
        `[${EBAY_ACCOUNT_LABELS[syncShopId]}] ${result.periodStart}〜${result.periodEnd}の受注${result.ordersFetched}件を確認し、${result.lineItemsSynced}件の明細を同期しました(自動突合${result.matchedCount}件・要確認${result.unmatchedCount}件)。`,
      );
      await reloadReviewQueue();
    } catch (err) {
      setEbaySyncMessage("同期に失敗しました: " + (err instanceof Error ? err.message : "不明なエラー"));
    } finally {
      setEbaySyncing(false);
    }
  }

  async function handleCpassDryRun() {
    if (!cpassFile) {
      setCpassError("CPaSSのエクスポートファイル(.xlsx)を選択してください");
      return;
    }
    setCpassBusy(true);
    setCpassError(null);
    setCpassPreview(null);
    setCpassMessage(null);
    try {
      const rawRows = await parseCpassFile(cpassFile);
      const preview = await previewCpassRows(rawRows);
      setCpassPreview(preview);
    } catch (err) {
      setCpassError(err instanceof Error ? err.message : "ファイルの読み込みに失敗しました");
    } finally {
      setCpassBusy(false);
    }
  }

  async function handleCpassImport() {
    if (!cpassPreview || !cpassFile) return;
    const targets = cpassPreview.filter((r) => r.outcome !== "error");
    if (targets.length === 0) return;
    if (!window.confirm(`${targets.length}件の配送情報を取り込みます。既存の同じOrder番号のデータは上書きされます。よろしいですか?`)) {
      return;
    }
    setCpassImporting(true);
    try {
      const result = await executeCpassImport(cpassPreview, cpassFile.name);
      setCpassMessage(`${result.imported}件を取り込みました(スキップ${result.skipped}件)。`);
      setCpassPreview(null);
      setCpassFile(null);
      await reloadReviewQueue();
    } catch (err) {
      setCpassMessage("取込に失敗しました: " + (err instanceof Error ? err.message : "不明なエラー"));
    } finally {
      setCpassImporting(false);
    }
  }

  async function handleSaveCpassFee(row: EbayReviewRow) {
    if (!row.order_number) return;
    const key = `${row.order_number}::${row.item_id ?? ""}`;
    const raw = cpassFeeEdits[key];
    const trimmed = (raw ?? "").trim();
    const value = trimmed === "" ? null : Number(trimmed);
    if (value !== null && (Number.isNaN(value) || value < 0)) return;
    setSavingCpassFee(key);
    try {
      await upsertManualShippingFee(row.order_number, row.item_id, value, value === null ? null : "USD");
      setCpassFeeEdits((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      await reloadReviewQueue();
    } catch (err) {
      setCpassMessage("送料の保存に失敗しました: " + (err instanceof Error ? err.message : "不明なエラー"));
    } finally {
      setSavingCpassFee(null);
    }
  }

  function handleUnmatchedQueryChange(rowId: string, value: string) {
    setUnmatchedQuery((prev) => ({ ...prev, [rowId]: value }));
    if (!value.trim()) {
      setUnmatchedCandidates((prev) => ({ ...prev, [rowId]: [] }));
      return;
    }
    searchItemsForSale(value)
      .then((results) => setUnmatchedCandidates((prev) => ({ ...prev, [rowId]: results })))
      .catch(() => setUnmatchedCandidates((prev) => ({ ...prev, [rowId]: [] })));
  }

  async function handleLinkUnmatched(rowId: string, item: ItemForSale) {
    setLinkingRowId(rowId);
    try {
      await linkEbayTransactionLineToItem(rowId, item.id);
      setUnmatchedQuery((prev) => ({ ...prev, [rowId]: "" }));
      setUnmatchedCandidates((prev) => ({ ...prev, [rowId]: [] }));
      await reloadReviewQueue();
    } catch (err) {
      setEbaySyncMessage("突合に失敗しました: " + (err instanceof Error ? err.message : "不明なエラー"));
    } finally {
      setLinkingRowId(null);
    }
  }

  /**
   * 「SKU再照合」ボタン(2026-09-04追加)。自動突合できなかった行のeBay SKU(custom_label)から
   * 対応するitems.management_noの候補を推測して検索し、候補一覧に表示する(紐付け自体は従来通り
   * ユーザーが候補をクリックして確定する)。「管理番号で検索して紐付け」欄への手入力が不要になる。
   */
  async function handleRematchByCustomLabel(row: EbayReviewRow) {
    if (!row.custom_label) return;
    setRematchingRowId(row.id);
    try {
      const results = await searchItemsByCustomLabel(row.custom_label);
      setUnmatchedCandidates((prev) => ({ ...prev, [row.id]: results }));
      if (results.length === 0) {
        setEbaySyncMessage(`SKU再照合: 候補が見つかりませんでした(SKU: ${row.custom_label})。管理番号で手動検索してください。`);
      }
    } catch (err) {
      setEbaySyncMessage("SKU再照合に失敗しました: " + (err instanceof Error ? err.message : "不明なエラー"));
    } finally {
      setRematchingRowId(null);
    }
  }

  async function handleIgnoreEbayRow(rowId: string) {
    try {
      await ignoreEbayTransactionLine(rowId);
      await reloadReviewQueue();
    } catch (err) {
      setEbaySyncMessage("除外に失敗しました: " + (err instanceof Error ? err.message : "不明なエラー"));
    }
  }

  async function handlePrefillFromEbay(row: EbayReviewRow) {
    if (!row.matched_item_id) return;
    try {
      const item = await fetchItemForSaleById(row.matched_item_id);
      if (!item) {
        setEbaySyncMessage("紐付け先の商品が見つかりませんでした(削除された可能性があります)");
        return;
      }
      const ym = row.transaction_date.slice(0, 7);
      // 取扱手数料(2026-09-06修正: final_value_fee+international_feeのみだとFINAL_VALUE_FEE_FIXED_PER_ORDER
      // 等のTax Invoice側にしか無い内訳が漏れて過少計上になる不具合(管理番号260521-06で発見)があったため、
      // ebay_tax_invoice_lines側の実額(取り込み済みなら)を優先するtransaction_fee_usdを使うよう変更。
      // フォームには独立した「広告料($)」欄があるため、取扱手数料にAd Feeを合算するのは誤り(2026-09-05修正、
      // ユーザー指摘により2026-09-04の変更を撤回済み)。
      // 広告料($) = Ad Fee General(ad_fee_usd)をそのまま設定する(合算・ゼロリセットはしない)。
      // どちらも浮動小数点誤差(例: 25.759999999999998)を避けるため小数点第2位に丸める。
      const handlingFeeUsd = Math.round(row.transaction_fee_usd * 100) / 100;
      const adFeeUsd = Math.round(row.ad_fee_usd * 100) / 100;
      setForm({
        ...EMPTY_FORM,
        selectedItem: item,
        itemQuery: item.management_no,
        sale_date: row.transaction_date,
        sale_item_title: row.item_title ?? "",
        ebay_price_usd: String(ebayRowToUsd(row, row.item_subtotal)),
        ebay_shipping_collected_usd: String(ebayRowToUsd(row, row.shipping_and_handling)),
        ebay_handling_fee_usd: String(handlingFeeUsd),
        ebay_ad_fee_usd: String(adFeeUsd),
        exchange_rate: monthlyRates[ym] !== undefined ? String(monthlyRates[ym]) : EMPTY_FORM.exchange_rate,
        account: row.account ?? "",
      });
      setPendingEbayLineId(row.id);
      setFormError(null);
    } catch (err) {
      setEbaySyncMessage("フォームへの反映に失敗しました: " + (err instanceof Error ? err.message : "不明なエラー"));
    }
  }

  // 現在表示中の一覧に含まれる対象月(重複なし・昇順)
  const targetMonths = Array.from(new Set(list.map((s) => s.year_month.slice(0, 7)))).sort();

  const filter: SalesPeriodFilter =
    periodType === "all"
      ? { type: "all" }
      : periodType === "year"
      ? { type: "year", year }
      : { type: "month", year, month, toYear, toMonth };

  async function reload() {
    setLoading(true);
    setErrorMessage(null);
    try {
      const [breakdown, l] = await Promise.all([
        fetchSalesSummaryBreakdown(filter, accountFilter || undefined),
        fetchSalesList(filter, undefined, accountFilter || undefined),
      ]);
      setSummary(breakdown.total);
      setMonthlySummaries(breakdown.months);
      setList(l);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    void reloadMonthlyRates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodType, year, month, toYear, toMonth, accountFilter]);

  useEffect(() => {
    void reloadReviewQueue();
  }, []);

  async function reloadSalesTabCounts() {
    setSalesTabCountsLoading(true);
    setSalesTabCountsError(null);
    try {
      setSalesTabCounts(await getSalesTabDataCounts());
    } catch (err) {
      setSalesTabCountsError(err instanceof Error ? err.message : "件数の取得に失敗しました");
    } finally {
      setSalesTabCountsLoading(false);
    }
  }

  useEffect(() => {
    void reloadSalesTabCounts();
  }, []);

  async function handleClearSalesTabData() {
    if (clearSalesTabConfirmText !== CLEAR_SALES_TAB_CONFIRM_PHRASE) return;
    const totalCount = salesTabCounts
      ? salesTabCounts.sales +
        salesTabCounts.ebayTransactionLines +
        salesTabCounts.ebayTaxInvoiceLines +
        salesTabCounts.platformSettlementImports +
        salesTabCounts.cpassShipments
      : null;
    const countText = totalCount != null ? `売上・粗利タブのデータ計${totalCount}件` : "売上・粗利タブのデータ";
    if (!window.confirm(`${countText}を完全に削除します。この操作は取り消せません。本当によろしいですか?`)) {
      return;
    }
    setClearingSalesTab(true);
    setClearSalesTabError(null);
    setClearSalesTabMessage(null);
    try {
      await clearAllSalesTabData();
      setClearSalesTabMessage("売上・粗利タブのデータを全て削除しました");
      setClearSalesTabConfirmText("");
      await reloadSalesTabCounts();
      await reload();
      await reloadReviewQueue();
    } catch (err) {
      setClearSalesTabError(err instanceof Error ? err.message : "削除に失敗しました");
    } finally {
      setClearingSalesTab(false);
    }
  }

  useEffect(() => {
    if (!form.itemQuery.trim()) {
      setCandidates([]);
      return;
    }
    const handle = setTimeout(() => {
      searchItemsForSale(form.itemQuery)
        .then(setCandidates)
        .catch(() => setCandidates([]));
    }, 300);
    return () => clearTimeout(handle);
  }, [form.itemQuery]);

  function updateForm<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function selectItem(item: ItemForSale) {
    setForm((prev) => ({ ...prev, selectedItem: item, itemQuery: item.management_no }));
    setCandidates([]);
  }

  const jpSubtotal = num(form.jp_platform_price) - num(form.jp_platform_fee) + num(form.jp_platform_shipping_collected);
  const usdSubtotal =
    num(form.ebay_price_usd) + num(form.ebay_shipping_collected_usd) - num(form.ebay_handling_fee_usd) - num(form.ebay_ad_fee_usd);
  const usdSubtotalJpy = usdSubtotal * num(form.exchange_rate);
  const totalJpy = jpSubtotal + usdSubtotalJpy;
  const grossProfit = totalJpy - num(form.shipping_cost_paid) - (form.selectedItem?.purchase_price ?? 0);

  async function handleSubmit() {
    setFormError(null);
    if (!form.selectedItem) {
      setFormError("管理番号で商品を検索して選択してください");
      return;
    }
    if (!form.sale_date) {
      setFormError("販売日を入力してください");
      return;
    }
    setSaving(true);
    try {
      if (editingSaleId) {
        // 編集時: eBay明細の紐付け(ebay_transaction_line_id)はここで指定した場合のみ上書きし、
        // 指定しなければ既存の紐付けをそのまま維持する(nullで意図せず消してしまわないため)。
        await updateSale(editingSaleId, {
          item_id: form.selectedItem.id,
          sale_date: form.sale_date,
          sale_item_title: form.sale_item_title || null,
          tracking_info: form.tracking_info || null,
          jp_platform_price: num(form.jp_platform_price),
          jp_platform_fee: num(form.jp_platform_fee),
          jp_platform_shipping_collected: num(form.jp_platform_shipping_collected),
          shipping_cost_paid: num(form.shipping_cost_paid),
          ebay_price_usd: num(form.ebay_price_usd),
          ebay_shipping_collected_usd: num(form.ebay_shipping_collected_usd),
          ebay_handling_fee_usd: num(form.ebay_handling_fee_usd),
          ebay_ad_fee_usd: num(form.ebay_ad_fee_usd),
          ...(pendingEbayLineId ? { ebay_transaction_line_id: pendingEbayLineId } : {}),
          account: form.account || null,
          exchange_rate: num(form.exchange_rate),
          purchase_price_snapshot: form.selectedItem.purchase_price,
        });
        if (pendingEbayLineId) {
          try {
            await markEbayTransactionLineRegistered(pendingEbayLineId);
          } catch {
            /* レビューキュー側の状態更新失敗は致命的でないため無視(売上自体は更新済み) */
          }
          setPendingEbayLineId(null);
          await reloadReviewQueue();
        }
        setEditingSaleId(null);
      } else {
        await createSale(
          {
            item_id: form.selectedItem.id,
            sale_date: form.sale_date,
            sale_item_title: form.sale_item_title || undefined,
            tracking_info: form.tracking_info || undefined,
            jp_platform_price: num(form.jp_platform_price),
            jp_platform_fee: num(form.jp_platform_fee),
            jp_platform_shipping_collected: num(form.jp_platform_shipping_collected),
            shipping_cost_paid: num(form.shipping_cost_paid),
            ebay_price_usd: num(form.ebay_price_usd),
            ebay_shipping_collected_usd: num(form.ebay_shipping_collected_usd),
            ebay_handling_fee_usd: num(form.ebay_handling_fee_usd),
            ebay_ad_fee_usd: num(form.ebay_ad_fee_usd),
            ebay_transaction_line_id: pendingEbayLineId ?? undefined,
            account: form.account || null,
            exchange_rate: num(form.exchange_rate),
          },
          form.selectedItem.purchase_price,
        );
        if (pendingEbayLineId) {
          try {
            await markEbayTransactionLineRegistered(pendingEbayLineId);
          } catch {
            /* レビューキュー側の状態更新失敗は致命的でないため無視(売上自体は登録済み) */
          }
          setPendingEbayLineId(null);
          await reloadReviewQueue();
        }
      }
      setForm(EMPTY_FORM);
      await reload();
    } catch (err) {
      const fallbackMessage = editingSaleId ? "更新に失敗しました" : "登録に失敗しました";
      const errMessage =
        err instanceof Error
          ? err.message
          : err && typeof err === "object" && "message" in err && typeof (err as { message?: unknown }).message === "string"
            ? (err as { message: string }).message
            : fallbackMessage;
      setFormError(errMessage);
    } finally {
      setSaving(false);
    }
  }

  /** 一覧の「編集」ボタンから、既存の売上データを登録フォームに読み込んで編集モードに入る。 */
  function startEditSale(s: SaleWithItem) {
    setFormError(null);
    setPendingEbayLineId(null);
    setEditingSaleId(s.id);
    setForm({
      itemQuery: s.items?.management_no ?? "",
      selectedItem: {
        id: s.item_id,
        management_no: s.items?.management_no ?? "",
        title: s.items?.title ?? null,
        // 仕入高は登録時点のスナップショット値をそのまま引き継ぐ(現在の仕入高で上書きしない)。
        purchase_price: s.purchase_price_snapshot,
      },
      sale_date: s.sale_date,
      sale_item_title: s.sale_item_title ?? "",
      tracking_info: s.tracking_info ?? "",
      jp_platform_price: String(s.jp_platform_price),
      jp_platform_fee: String(s.jp_platform_fee),
      jp_platform_shipping_collected: String(s.jp_platform_shipping_collected),
      shipping_cost_paid: String(s.shipping_cost_paid),
      ebay_price_usd: String(s.ebay_price_usd),
      ebay_shipping_collected_usd: String(s.ebay_shipping_collected_usd),
      ebay_handling_fee_usd: String(s.ebay_handling_fee_usd),
      ebay_ad_fee_usd: String(s.ebay_ad_fee_usd),
      exchange_rate: String(s.exchange_rate),
      account: s.account ?? "",
    });
  }

  function cancelEditSale() {
    setEditingSaleId(null);
    setPendingEbayLineId(null);
    setFormError(null);
    setForm(EMPTY_FORM);
  }

  async function handleDelete(id: string) {
    try {
      await deleteSale(id);
      if (editingSaleId === id) cancelEditSale();
      await reload();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "削除に失敗しました");
    }
  }

  function handleSalesSort(column: SalesSortColumn) {
    if (salesSortColumn === column) {
      setSalesSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSalesSortColumn(column);
      setSalesSortDirection("asc");
    }
  }

  // 期間の末尾が今月を含む場合は「進行中」の注記を出す(単月・範囲どちらにも対応)
  const isCurrentMonth =
    periodType === "month" && toYear === CURRENT_YEAR && toMonth === CURRENT_MONTH;

  const sortedList = useMemo(() => {
    if (!salesSortColumn) return list;
    const sorted = [...list].sort((a, b) => {
      const va = salesSortValue(a, salesSortColumn);
      const vb = salesSortValue(b, salesSortColumn);
      // 空欄は常に末尾に置く(昇順・降順にかかわらず)
      if (!va && !vb) return 0;
      if (!va) return 1;
      if (!vb) return -1;
      return va < vb ? -1 : va > vb ? 1 : 0;
    });
    if (salesSortDirection === "desc") sorted.reverse();
    return sorted;
  }, [list, salesSortColumn, salesSortDirection]);

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "1.5rem", paddingBottom: "3rem", boxSizing: "border-box" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16 }}>
        <select value={periodType} onChange={(e) => setPeriodType(e.target.value as "all" | "year" | "month")}>
          <option value="all">全期間</option>
          <option value="year">年単位</option>
          <option value="month">年月単位</option>
        </select>
        {(periodType === "year" || periodType === "month") && (
          <select
            value={year}
            onChange={(e) => {
              const newYear = Number(e.target.value);
              setYear(newYear);
              if (periodType === "month" && (newYear > toYear || (newYear === toYear && month > toMonth))) {
                setToYear(newYear);
                setToMonth(month);
              }
            }}
          >
            {YEAR_OPTIONS.map((y) => (
              <option key={y} value={y}>
                {y}年
              </option>
            ))}
          </select>
        )}
        {periodType === "month" && (
          <select
            value={month}
            onChange={(e) => {
              const newMonth = Number(e.target.value);
              setMonth(newMonth);
              // 開始年月が終了年月より後になった場合は終了側を追従させる
              if (year > toYear || (year === toYear && newMonth > toMonth)) {
                setToYear(year);
                setToMonth(newMonth);
              }
            }}
          >
            {MONTH_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {m}月
              </option>
            ))}
          </select>
        )}
        {periodType === "month" && (
          <>
            <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>〜</span>
            <select value={toYear} onChange={(e) => setToYear(Number(e.target.value))}>
              {YEAR_OPTIONS.map((y) => (
                <option key={y} value={y}>
                  {y}年
                </option>
              ))}
            </select>
            <select value={toMonth} onChange={(e) => setToMonth(Number(e.target.value))}>
              {MONTH_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m}月
                </option>
              ))}
            </select>
          </>
        )}
        <select
          value={accountFilter}
          onChange={(e) => setAccountFilter(e.target.value)}
          style={{ marginLeft: 8 }}
        >
          <option value="">アカウント: すべて</option>
          {EBAY_ACCOUNT_OPTIONS.map((a) => (
            <option key={a} value={a}>
              {EBAY_ACCOUNT_LABELS[a]}
            </option>
          ))}
        </select>
        {isCurrentMonth && (
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>進行中の月は月初〜本日までを集計</span>
        )}
      </div>

      {targetMonths.length > 0 && (
        <div
          style={{
            marginBottom: 16,
            padding: "10px 12px",
            border: "0.5px dashed var(--border-strong)",
            borderRadius: 8,
            background: "var(--surface-1)",
          }}
        >
          <div style={{ marginBottom: 8 }}>
            <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: 0, fontWeight: 500 }}>
              対象月ごとの為替レート({targetMonths.length}ヶ月分) — 各月の「取得」ボタンでその月末営業日の三菱UFJ公表TTMを反映します
            </p>
          </div>
          {mufgFetchMessage && (
            <p style={{ fontSize: 11, color: "var(--text-secondary)", margin: "0 0 8px" }}>{mufgFetchMessage}</p>
          )}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {targetMonths.map((ym) => {
              const savedRate = monthlyRates[ym];
              const editValue = monthlyRateEdits[ym] ?? (savedRate !== undefined ? String(savedRate) : "");
              const isDirty = editValue !== (savedRate !== undefined ? String(savedRate) : "");
              return (
                <div key={ym} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>{ym}</label>
                  <input
                    type="number"
                    placeholder="未設定"
                    value={editValue}
                    onChange={(e) =>
                      setMonthlyRateEdits((prev) => ({ ...prev, [ym]: e.target.value }))
                    }
                    style={{ width: 80 }}
                  />
                  <button
                    onClick={() => handleFetchMufgRate(ym)}
                    disabled={fetchingMufgRate === ym}
                    style={{ fontSize: 11, padding: "3px 6px" }}
                  >
                    {fetchingMufgRate === ym ? "取得中..." : "取得"}
                  </button>
                  {isDirty && (
                    <button
                      onClick={() => handleSaveMonthlyRate(ym)}
                      disabled={savingMonthlyRate === ym}
                      style={{ fontSize: 11, padding: "3px 8px" }}
                    >
                      {savingMonthlyRate === ym ? "保存中..." : "保存"}
                    </button>
                  )}
                  {!isDirty && justSavedMonth === ym && savedRate !== undefined && (
                    <button
                      onClick={() => handleBulkApplyRate(ym)}
                      disabled={bulkApplying === ym}
                      style={{ fontSize: 11, padding: "3px 8px", color: "var(--danger-text)" }}
                    >
                      {bulkApplying === ym
                        ? "更新中..."
                        : `登録済み売上(${list.filter((s) => s.year_month.slice(0, 7) === ym).length}件)にも一括反映`}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {bulkApplyMessage && (
            <p style={{ fontSize: 11, color: "var(--text-secondary)", margin: "6px 0 0" }}>{bulkApplyMessage}</p>
          )}
          <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "8px 0 0" }}>
            ここで設定したレートは、新規登録フォームで該当月の販売日を選択した際に自動入力されます。保存直後は「登録済み売上にも一括反映」ボタンが表示され、押すとその月の既存データの為替レートも一括更新されます(粗利等も自動的に再計算されます)。
          </p>
        </div>
      )}

      {errorMessage && <p style={{ color: "var(--danger-text)", fontSize: 13 }}>{errorMessage}</p>}

      {summary && (
        <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: "0 0 8px" }}>
          対象件数: {summary.count}件
        </p>
      )}

      {summary && (
        <div style={{ overflowX: "auto", marginBottom: 24 }}>
          <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse", whiteSpace: "nowrap" }}>
            <thead>
              <tr style={{ textAlign: "right", color: "var(--text-secondary)" }}>
                <th style={{ padding: "6px 8px", textAlign: "left" }}>対象月</th>
                <th style={{ padding: "6px 8px" }}>件数</th>
                <th style={{ padding: "6px 8px" }}>邦売上高</th>
                <th style={{ padding: "6px 8px" }}>邦手数料</th>
                <th style={{ padding: "6px 8px" }}>eBay売上高</th>
                <th style={{ padding: "6px 8px" }}>eBay手数料</th>
                <th style={{ padding: "6px 8px" }}>送料</th>
                <th style={{ padding: "6px 8px" }}>仕入高</th>
                <th style={{ padding: "6px 8px" }}>粗利</th>
              </tr>
            </thead>
            <tbody>
              {monthlySummaries.map((m) => (
                <tr key={m.year_month} style={{ borderTop: "0.5px solid var(--border)" }}>
                  <td style={{ padding: "8px" }}>{m.year_month}</td>
                  <td style={{ padding: "8px", textAlign: "right" }}>{m.count}</td>
                  <td style={{ padding: "8px", textAlign: "right" }}>¥{Math.round(m.jpPlatformRevenue).toLocaleString()}</td>
                  <td style={{ padding: "8px", textAlign: "right" }}>¥{Math.round(m.jpPlatformFee).toLocaleString()}</td>
                  <td style={{ padding: "8px", textAlign: "right" }}>¥{Math.round(m.ebayRevenueJpy).toLocaleString()}</td>
                  <td style={{ padding: "8px", textAlign: "right" }}>¥{Math.round(m.ebayFeeJpy).toLocaleString()}</td>
                  <td style={{ padding: "8px", textAlign: "right" }}>¥{Math.round(m.shippingCost).toLocaleString()}</td>
                  <td style={{ padding: "8px", textAlign: "right" }}>¥{Math.round(m.purchaseCost).toLocaleString()}</td>
                  <td style={{ padding: "8px", textAlign: "right", fontWeight: 500 }}>¥{Math.round(m.grossProfit).toLocaleString()}</td>
                </tr>
              ))}
              <tr style={{ borderTop: "1.5px solid var(--border-strong)", background: "var(--surface-1)", fontWeight: 500 }}>
                <td style={{ padding: "8px" }}>期間合計</td>
                <td style={{ padding: "8px", textAlign: "right" }}>{summary.count}</td>
                <td style={{ padding: "8px", textAlign: "right" }}>¥{Math.round(summary.jpPlatformRevenue).toLocaleString()}</td>
                <td style={{ padding: "8px", textAlign: "right" }}>¥{Math.round(summary.jpPlatformFee).toLocaleString()}</td>
                <td style={{ padding: "8px", textAlign: "right" }}>¥{Math.round(summary.ebayRevenueJpy).toLocaleString()}</td>
                <td style={{ padding: "8px", textAlign: "right" }}>¥{Math.round(summary.ebayFeeJpy).toLocaleString()}</td>
                <td style={{ padding: "8px", textAlign: "right" }}>¥{Math.round(summary.shippingCost).toLocaleString()}</td>
                <td style={{ padding: "8px", textAlign: "right" }}>¥{Math.round(summary.purchaseCost).toLocaleString()}</td>
                <td style={{ padding: "8px", textAlign: "right" }}>¥{Math.round(summary.grossProfit).toLocaleString()}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <div style={{ background: "var(--surface-2)", border: "0.5px solid var(--border)", borderRadius: 12, padding: "1rem 1.25rem", marginBottom: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <p style={{ fontSize: 14, fontWeight: 500, margin: 0 }}>
            eBayから売上を取得{reviewQueue.length > 0 ? `(要確認 ${reviewQueue.length}件)` : ""}
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <select
              value={syncShopId}
              onChange={(e) => setSyncShopId(e.target.value as "soulcamera" | "soulmenjapan")}
              style={{ fontSize: 12 }}
            >
              {EBAY_SYNC_SHOP_IDS.map((s) => (
                <option key={s} value={s}>
                  {EBAY_ACCOUNT_LABELS[s]}
                </option>
              ))}
            </select>
            <button onClick={handleEbaySync} disabled={ebaySyncing} style={{ fontSize: 12, padding: "4px 10px" }}>
              {ebaySyncing ? "同期中..." : "eBay受注を同期(直近90日)"}
            </button>
            <button onClick={scrollToFormSection} style={{ fontSize: 12, padding: "4px 10px" }}>
              フォームへ移動
            </button>
            {reviewQueue.length > 0 && (
              <button onClick={() => setIsReviewQueueCollapsed((v) => !v)} style={{ fontSize: 12, padding: "4px 10px" }}>
                {isReviewQueueCollapsed ? `一覧を展開する(${reviewQueue.length}件)` : "一覧を折りたたむ"}
              </button>
            )}
          </div>
        </div>
        <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "0 0 10px" }}>
          同期対象アカウント(soulcamera/soulmenjapan)を選んでから実行してください。eBayのSKU(Custom Label)の先頭9文字が管理番号と完全一致する受注は自動で商品と紐付きます。一致しない受注は下記で手動検索して紐付けてください。「フォームに反映」を押すと下の登録フォームに値が入りますので、内容を確認・修正のうえ「登録する」を押してください(このAPI単体では売上は登録されません)。
        </p>
        {ebaySyncMessage && (
          <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: "0 0 10px" }}>{ebaySyncMessage}</p>
        )}

        <div
          style={{
            border: "0.5px dashed var(--border)",
            borderRadius: 10,
            padding: "10px 12px",
            marginBottom: 14,
            background: "var(--surface-1)",
          }}
        >
          <p style={{ fontSize: 12, fontWeight: 500, margin: "0 0 6px" }}>CPaSS配送情報を取り込む(追跡番号・送料)</p>
          <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "0 0 8px" }}>
            cpass.ebay.comからダウンロードしたエクスポート(.xlsx)を選択してください。「eBay order ID」列をOrder番号として突合します。
            現状のCPaSSエクスポート形式には送料(shipping fee)の列が含まれていないため、追跡番号・配送業者等はここから取り込めますが、送料は下の一覧の「送料」列に直接手入力・保存できます。
          </p>
          <p style={{ fontSize: 11, color: "var(--text-secondary)", margin: "0 0 8px" }}>
            追跡番号は「eBay受注を同期」実行時にAPIから自動取得されます(CPaSS/eLogiどちらの発送でも対応)。eLogiの送料は経費タブでCSVを取り込み済みなら自動反映されます。
          </p>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <input
              type="file"
              accept=".xlsx"
              onChange={(e) => {
                setCpassFile(e.target.files?.[0] ?? null);
                setCpassPreview(null);
                setCpassError(null);
                setCpassMessage(null);
              }}
              style={{ fontSize: 12 }}
            />
            <button onClick={handleCpassDryRun} disabled={cpassBusy || !cpassFile} style={{ fontSize: 12, padding: "4px 10px" }}>
              {cpassBusy ? "確認中..." : "内容を確認"}
            </button>
            {cpassPreview && (
              <button onClick={handleCpassImport} disabled={cpassImporting} style={{ fontSize: 12, padding: "4px 10px" }}>
                {cpassImporting ? "取込中..." : `取り込む(${cpassPreview.filter((r) => r.outcome !== "error").length}件)`}
              </button>
            )}
          </div>
          {cpassError && <p style={{ fontSize: 12, color: "var(--danger-text)", margin: "8px 0 0" }}>{cpassError}</p>}
          {cpassMessage && <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: "8px 0 0" }}>{cpassMessage}</p>}
          {cpassPreview && (
            <div style={{ marginTop: 8, overflowX: "auto" }}>
              <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "0 0 4px" }}>
                {cpassPreview.length}行中 突合OK {cpassPreview.filter((r) => r.outcome === "matched").length}件 / 未突合(Order番号が未同期)
                {" "}
                {cpassPreview.filter((r) => r.outcome === "unmatched_order").length}件 / エラー
                {" "}
                {cpassPreview.filter((r) => r.outcome === "error").length}件
              </p>
              <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--text-secondary)" }}>
                    <th style={{ padding: "4px 6px" }}>状態</th>
                    <th style={{ padding: "4px 6px" }}>Order番号</th>
                    <th style={{ padding: "4px 6px" }}>追跡番号</th>
                    <th style={{ padding: "4px 6px" }}>配送業者</th>
                    <th style={{ padding: "4px 6px" }}>商品名</th>
                  </tr>
                </thead>
                <tbody>
                  {cpassPreview.slice(0, 50).map((r) => (
                    <tr key={r.raw.rowNumber} style={{ borderTop: "0.5px solid var(--border)" }}>
                      <td style={{ padding: "4px 6px", whiteSpace: "nowrap" }}>
                        {r.outcome === "matched" ? "OK" : r.outcome === "unmatched_order" ? "未突合" : "エラー"}
                      </td>
                      <td style={{ padding: "4px 6px", whiteSpace: "nowrap" }}>{r.raw.orderNumber ?? "-"}</td>
                      <td style={{ padding: "4px 6px", whiteSpace: "nowrap" }}>{r.raw.trackingNumber ?? "-"}</td>
                      <td style={{ padding: "4px 6px", whiteSpace: "nowrap" }}>{r.raw.shippingCarrier ?? "-"}</td>
                      <td style={{ padding: "4px 6px" }}>{r.matchedItemTitle ?? (r.errors[0] ?? "-")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {cpassPreview.length > 50 && (
                <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "4px 0 0" }}>
                  ...他{cpassPreview.length - 50}件(表示は先頭50件まで)
                </p>
              )}
            </div>
          )}
        </div>

        {reviewLoading && <p style={{ fontSize: 12, color: "var(--text-secondary)" }}>読み込み中...</p>}
        {!reviewLoading && reviewQueue.length === 0 && (
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
            未登録のeBay受注はありません。「eBay受注を同期」を押すと最新の受注を取得します。
          </p>
        )}
        {!reviewLoading && reviewQueue.length > 0 && !isReviewQueueCollapsed && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--text-secondary)" }}>
                  <th style={{ padding: "6px 8px" }}>アカウント</th>
                  <th style={{ padding: "6px 8px" }}>受注日(Sold日付)</th>
                  <th style={{ padding: "6px 8px" }}>Order番号</th>
                  <th style={{ padding: "6px 8px" }}>Sales record no.</th>
                  <th style={{ padding: "6px 8px" }}>バイヤー居住国</th>
                  <th style={{ padding: "6px 8px" }}>SKU / 商品名</th>
                  <th style={{ padding: "6px 8px" }}>管理番号</th>
                  <th style={{ padding: "6px 8px", textAlign: "right" }}>販売価格</th>
                  <th style={{ padding: "6px 8px", textAlign: "right" }}>送料徴収額</th>
                  <th style={{ padding: "6px 8px", textAlign: "right" }}>手数料</th>
                  <th style={{ padding: "6px 8px", textAlign: "right" }}>広告料</th>
                  <th style={{ padding: "6px 8px" }}>追跡番号</th>
                  <th style={{ padding: "6px 8px", textAlign: "right" }}>送料</th>
                  <th style={{ padding: "6px 8px" }}>在庫アイテム</th>
                  <th style={{ padding: "6px 8px" }}></th>
                </tr>
              </thead>
              <tbody>
                {reviewQueue.map((row) => {
                  const cur = row.transaction_currency === "USD" ? "$" : row.transaction_currency + " ";
                  const isUsd = row.transaction_currency === "USD";
                  // USD以外の通貨の場合、原文通貨の金額に加えてUSD換算額(そのeBay取引自体のexchange_rateを使用)を併記する。
                  const usdSuffix = (localValue: number) =>
                    isUsd ? "" : ` (≈$${ebayRowToUsd(row, localValue).toFixed(2)})`;
                  return (
                    <tr key={row.id} style={{ borderTop: "0.5px solid var(--border)" }}>
                      <td style={{ padding: "8px", whiteSpace: "nowrap" }}>
                        {row.account ? EBAY_ACCOUNT_LABELS[row.account as keyof typeof EBAY_ACCOUNT_LABELS] ?? row.account : "-"}
                      </td>
                      <td style={{ padding: "8px", whiteSpace: "nowrap" }}>{row.transaction_date}</td>
                      <td style={{ padding: "8px", whiteSpace: "nowrap" }}>{row.order_number ?? "-"}</td>
                      <td style={{ padding: "8px", whiteSpace: "nowrap" }}>{row.sales_record_reference ?? "-"}</td>
                      <td style={{ padding: "8px", whiteSpace: "nowrap" }}>{row.buyer_country ?? "-"}</td>
                      <td style={{ padding: "8px" }}>
                        <div>{row.custom_label ?? "-"}</div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{row.item_title ?? "-"}</div>
                      </td>
                      <td style={{ padding: "8px", whiteSpace: "nowrap" }}>
                        {row.matched_item?.management_no ?? "-"}
                      </td>
                      <td style={{ padding: "8px", textAlign: "right", whiteSpace: "nowrap" }}>
                        {cur}
                        {row.item_subtotal.toFixed(2)}
                        {!isUsd && (
                          <span style={{ color: "var(--text-muted)" }}>{usdSuffix(row.item_subtotal)}</span>
                        )}
                      </td>
                      <td style={{ padding: "8px", textAlign: "right", whiteSpace: "nowrap" }}>
                        {cur}
                        {row.shipping_and_handling.toFixed(2)}
                        {!isUsd && (
                          <span style={{ color: "var(--text-muted)" }}>{usdSuffix(row.shipping_and_handling)}</span>
                        )}
                      </td>
                      <td style={{ padding: "8px", textAlign: "right", whiteSpace: "nowrap" }}>
                        {`$${row.transaction_fee_usd.toFixed(2)}`}
                      </td>
                      <td style={{ padding: "8px", textAlign: "right", whiteSpace: "nowrap" }}>
                        {row.ad_fee_usd > 0 ? `$${row.ad_fee_usd.toFixed(2)}` : "-"}
                      </td>
                      <td style={{ padding: "8px", whiteSpace: "nowrap" }}>
                        {row.resolved_tracking_number ?? "-"}
                        {(row.api_shipping_carrier ?? row.cpass_shipping_carrier) && (
                          <div style={{ fontSize: 10, color: "var(--text-muted)" }}>{row.api_shipping_carrier ?? row.cpass_shipping_carrier}</div>
                        )}
                      </td>
                      <td style={{ padding: "8px", textAlign: "right", whiteSpace: "nowrap" }}>
                        {(() => {
                          const key = `${row.order_number ?? ""}::${row.item_id ?? ""}`;
                          const savedValue = row.cpass_shipping_fee != null ? String(row.cpass_shipping_fee) : "";
                          const editValue = cpassFeeEdits[key] ?? savedValue;
                          const isDirty = editValue !== savedValue;
                          if (!savedValue && row.resolved_shipping_fee_source === "elogi") {
                            return (
                              <div>
                                {row.resolved_shipping_fee != null ? `\u00a5${row.resolved_shipping_fee.toLocaleString()}` : "-"}
                                <div style={{ fontSize: 10, color: "var(--text-muted)" }}>eLogi</div>
                              </div>
                            );
                          }
                          return (
                            <div style={{ display: "flex", alignItems: "center", gap: 4, justifyContent: "flex-end" }}>
                              {row.cpass_shipping_fee_currency && (
                                <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{row.cpass_shipping_fee_currency}</span>
                              )}
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                placeholder="手入力"
                                value={editValue}
                                disabled={!row.order_number}
                                onChange={(e) =>
                                  setCpassFeeEdits((prev) => ({ ...prev, [key]: e.target.value }))
                                }
                                style={{ width: 70, fontSize: 11, textAlign: "right" }}
                              />
                              {isDirty && (
                                <button
                                  onClick={() => handleSaveCpassFee(row)}
                                  disabled={savingCpassFee === key}
                                  style={{ fontSize: 10, padding: "2px 6px" }}
                                >
                                  {savingCpassFee === key ? "..." : "保存"}
                                </button>
                              )}
                            </div>
                          );
                        })()}
                      </td>
                      <td style={{ padding: "8px", minWidth: 180 }}>
                        {row.matched_item ? (
                          <span>
                            {row.matched_item.management_no} / {row.matched_item.title ?? "-"}
                          </span>
                        ) : (
                          <div style={{ position: "relative" }}>
                            {row.custom_label && (
                              <button
                                onClick={() => handleRematchByCustomLabel(row)}
                                disabled={rematchingRowId === row.id}
                                style={{ fontSize: 10, padding: "2px 6px", marginBottom: 4 }}
                              >
                                {rematchingRowId === row.id ? "照合中..." : `SKU再照合(${row.custom_label})`}
                              </button>
                            )}
                            <input
                              type="text"
                              placeholder="管理番号で検索して紐付け"
                              value={unmatchedQuery[row.id] ?? ""}
                              onChange={(e) => handleUnmatchedQueryChange(row.id, e.target.value)}
                              style={{ width: "100%", fontSize: 12 }}
                            />
                            {(unmatchedCandidates[row.id]?.length ?? 0) > 0 && (
                              <div
                                style={{
                                  position: "absolute",
                                  zIndex: 1,
                                  width: "100%",
                                  border: "0.5px solid var(--border)",
                                  borderRadius: 8,
                                  marginTop: 2,
                                  background: "var(--surface-2)",
                                }}
                              >
                                {unmatchedCandidates[row.id].map((c) => (
                                  <div
                                    key={c.id}
                                    onClick={() => handleLinkUnmatched(row.id, c)}
                                    style={{ padding: "4px 8px", fontSize: 12, cursor: "pointer", borderBottom: "0.5px solid var(--border)" }}
                                  >
                                    {c.management_no} / {c.title ?? "-"}
                                  </div>
                                ))}
                              </div>
                            )}
                            {linkingRowId === row.id && (
                              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>紐付け中...</span>
                            )}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: "8px", whiteSpace: "nowrap" }}>
                        <button
                          onClick={() => handlePrefillFromEbay(row)}
                          disabled={!row.matched_item_id}
                          style={{ fontSize: 11, padding: "3px 8px", marginRight: 4 }}
                        >
                          フォームに反映
                        </button>
                        <button onClick={() => handleIgnoreEbayRow(row.id)} style={{ fontSize: 11, padding: "3px 8px" }}>
                          無視
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {(editingSaleId || pendingEbayLineId) && (
        <div
          onClick={cancelEditSale}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            zIndex: 1000,
          }}
        />
      )}
      <div
        ref={formSectionRef}
        onClick={(e) => {
          if (editingSaleId || pendingEbayLineId) e.stopPropagation();
        }}
        style={
          (editingSaleId || pendingEbayLineId)
            ? {
                position: "fixed",
                top: "5vh",
                left: "50%",
                transform: "translateX(-50%)",
                width: "min(720px, calc(100% - 32px))",
                maxHeight: "90vh",
                overflowY: "auto",
                background: "var(--surface-2)",
                border: "1px solid var(--accent)",
                borderRadius: 12,
                padding: "1rem 1.25rem",
                boxShadow: "0 8px 24px rgba(0,0,0,0.2)",
                zIndex: 1001,
              }
            : {
                background: "var(--surface-2)",
                border: "0.5px solid var(--border)",
                borderRadius: 12,
                padding: "1rem 1.25rem",
                marginBottom: 24,
              }
        }
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <p style={{ fontSize: 14, fontWeight: 500, margin: 0 }}>
            {editingSaleId ? "売上を編集" : "売上を登録"}
          </p>
          {(editingSaleId || pendingEbayLineId) && (
            <button onClick={cancelEditSale} style={{ fontSize: 11, padding: "3px 10px" }}>
              {editingSaleId ? "編集をキャンセル" : "キャンセル"}
            </button>
          )}
        </div>

        <div style={{ position: "relative", marginBottom: 8 }}>
          <input
            type="text"
            placeholder="管理番号(Custom label)で商品を検索"
            value={form.itemQuery}
            onChange={(e) => updateForm("itemQuery", e.target.value)}
            style={{ width: "100%" }}
          />
          {candidates.length > 0 && (
            <div style={{ border: "0.5px solid var(--border)", borderRadius: 8, marginTop: 4, background: "var(--surface-2)" }}>
              {candidates.map((c) => (
                <div
                  key={c.id}
                  onClick={() => selectItem(c)}
                  style={{ padding: "6px 10px", fontSize: 13, cursor: "pointer", borderBottom: "0.5px solid var(--border)" }}
                >
                  {c.management_no} / {c.title ?? "-"} (仕入高 ¥{c.purchase_price.toLocaleString()})
                </div>
              ))}
            </div>
          )}
        </div>
        {form.selectedItem && (
          <div style={{ fontSize: 12, color: "var(--text-secondary)", background: "var(--surface-1)", borderRadius: 8, padding: "8px 10px", marginBottom: 14 }}>
            {form.selectedItem.management_no} / {form.selectedItem.title ?? "-"} ・ 仕入高 ¥{form.selectedItem.purchase_price.toLocaleString()}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 14 }}>
          <Field label="販売日">
            <input
              type="date"
              value={form.sale_date}
              onChange={(e) => {
                const newDate = e.target.value;
                updateForm("sale_date", newDate);
                const ym = newDate.slice(0, 7);
                if (monthlyRates[ym] !== undefined) {
                  updateForm("exchange_rate", String(monthlyRates[ym]));
                }
              }}
              style={{ width: "100%" }}
            />
          </Field>
          <Field label="追跡情報">
            <input type="text" value={form.tracking_info} onChange={(e) => updateForm("tracking_info", e.target.value)} style={{ width: "100%" }} />
          </Field>
          <Field label="アカウント">
            <select value={form.account} onChange={(e) => updateForm("account", e.target.value)} style={{ width: "100%" }}>
              <option value="">未設定</option>
              {EBAY_ACCOUNT_OPTIONS.map((a) => (
                <option key={a} value={a}>
                  {EBAY_ACCOUNT_LABELS[a]}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div style={{ marginBottom: 14 }}>
          <Field label="販売アイテム名(eBay等の出品タイトル)">
            <input
              type="text"
              value={form.sale_item_title}
              onChange={(e) => updateForm("sale_item_title", e.target.value)}
              style={{ width: "100%" }}
            />
          </Field>
        </div>

        <p style={{ fontSize: 12, fontWeight: 500, color: "var(--text-secondary)", margin: "0 0 8px" }}>邦プラットフォーム</p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 14 }}>
          <Field label="販売価格(円)">
            <input type="number" value={form.jp_platform_price} onChange={(e) => updateForm("jp_platform_price", e.target.value)} style={{ width: "100%" }} />
          </Field>
          <Field label="手数料(円)">
            <input type="number" value={form.jp_platform_fee} onChange={(e) => updateForm("jp_platform_fee", e.target.value)} style={{ width: "100%" }} />
          </Field>
          <Field label="送料徴収額(円)">
            <input
              type="number"
              value={form.jp_platform_shipping_collected}
              onChange={(e) => updateForm("jp_platform_shipping_collected", e.target.value)}
              style={{ width: "100%" }}
            />
          </Field>
        </div>

        <p style={{ fontSize: 12, fontWeight: 500, color: "var(--text-secondary)", margin: "0 0 8px" }}>eBay</p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10, marginBottom: 14 }}>
          <Field label="販売価格($)">
            <input type="number" value={form.ebay_price_usd} onChange={(e) => updateForm("ebay_price_usd", e.target.value)} style={{ width: "100%" }} />
          </Field>
          <Field label="送料徴収額($)">
            <input
              type="number"
              value={form.ebay_shipping_collected_usd}
              onChange={(e) => updateForm("ebay_shipping_collected_usd", e.target.value)}
              style={{ width: "100%" }}
            />
          </Field>
          <Field label="取扱手数料($)">
            <input
              type="number"
              value={form.ebay_handling_fee_usd}
              onChange={(e) => updateForm("ebay_handling_fee_usd", e.target.value)}
              style={{ width: "100%" }}
            />
          </Field>
          <Field label="広告料($)">
            <input type="number" value={form.ebay_ad_fee_usd} onChange={(e) => updateForm("ebay_ad_fee_usd", e.target.value)} style={{ width: "100%" }} />
          </Field>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
          <Field label="送料支払額(円)">
            <input type="number" value={form.shipping_cost_paid} onChange={(e) => updateForm("shipping_cost_paid", e.target.value)} style={{ width: "100%" }} />
          </Field>
          <Field label="為替レート(月末TTM)">
            <input type="number" value={form.exchange_rate} onChange={(e) => updateForm("exchange_rate", e.target.value)} style={{ width: "100%" }} />
          </Field>
        </div>

        <div style={{ borderTop: "0.5px solid var(--border)", paddingTop: 12, display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, marginBottom: 14 }}>
          <div>
            <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0 }}>円貨合計</p>
            <p style={{ fontSize: 14, fontWeight: 500, margin: "2px 0 0" }}>¥{Math.round(jpSubtotal).toLocaleString()}</p>
          </div>
          <div>
            <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0 }}>ドル貨合計円換算</p>
            <p style={{ fontSize: 14, fontWeight: 500, margin: "2px 0 0" }}>¥{Math.round(usdSubtotalJpy).toLocaleString()}</p>
          </div>
          <div>
            <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0 }}>円貨+ドル貨合計</p>
            <p style={{ fontSize: 14, fontWeight: 500, margin: "2px 0 0" }}>¥{Math.round(totalJpy).toLocaleString()}</p>
          </div>
        </div>
        <div style={{ background: "var(--bg-accent, var(--surface-1))", borderRadius: 8, padding: "10px 12px", marginBottom: 14, display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontSize: 12 }}>粗利(円貨+ドル貨-送料-仕入高)</span>
          <span style={{ fontSize: 18, fontWeight: 500 }}>¥{Math.round(grossProfit).toLocaleString()}</span>
        </div>

        {formError && <p style={{ color: "var(--danger-text)", fontSize: 13, marginBottom: 8 }}>{formError}</p>}
        <button onClick={handleSubmit} disabled={saving} style={{ width: "100%" }}>
          {saving ? (editingSaleId ? "更新中..." : "登録中...") : editingSaleId ? "更新する" : "登録する"}
        </button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <p style={{ fontSize: 14, fontWeight: 500, margin: 0 }}>売上一覧{summary ? `(${summary.count}件)` : ""}</p>
        <button onClick={scrollToFormSection} style={{ fontSize: 12, padding: "4px 10px", marginLeft: "auto" }}>
          フォームへ移動
        </button>
        <button onClick={() => setIsSalesListCollapsed((v) => !v)} style={{ fontSize: 12, padding: "4px 10px" }}>
          {isSalesListCollapsed ? `一覧を展開する${summary ? `(${summary.count}件)` : ""}` : "一覧を折りたたむ"}
        </button>
      </div>
      {loading && <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>読み込み中...</p>}
      {!loading && !isSalesListCollapsed && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse", whiteSpace: "nowrap", tableLayout: "fixed" }}>
            <colgroup>
              <col style={{ width: "7%" }} />
              <col style={{ width: "7%" }} />
              <col style={{ width: "8%" }} />
              <col style={{ width: "26%" }} />
              <col style={{ width: "9%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "9%" }} />
              <col style={{ width: "8%" }} />
              <col style={{ width: "8%" }} />
              <col style={{ width: "5%" }} />
            </colgroup>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--text-secondary)" }}>
                <th
                  onClick={() => handleSalesSort("sale_date")}
                  style={{ padding: "6px 8px", cursor: "pointer", userSelect: "none" }}
                >
                  販売日{salesSortColumn === "sale_date" && (salesSortDirection === "asc" ? " ▲" : " ▼")}
                </th>
                <th
                  onClick={() => handleSalesSort("management_no")}
                  style={{ padding: "6px 8px", cursor: "pointer", userSelect: "none" }}
                >
                  管理番号{salesSortColumn === "management_no" && (salesSortDirection === "asc" ? " ▲" : " ▼")}
                </th>
                <th style={{ padding: "6px 8px" }}>アカウント</th>
                <th style={{ padding: "6px 8px" }}>販売アイテム名</th>
                <th style={{ padding: "6px 8px" }}>追跡情報</th>
                <th style={{ padding: "6px 8px", textAlign: "right" }}>円貨+ドル貨合計</th>
                <th style={{ padding: "6px 8px", textAlign: "right" }}>送料支払</th>
                <th style={{ padding: "6px 8px", textAlign: "right" }}>仕入高</th>
                <th style={{ padding: "6px 8px", textAlign: "right" }}>粗利</th>
                <th style={{ padding: "6px 8px" }}></th>
              </tr>
            </thead>
            <tbody>
              {sortedList.map((s) => (
                <tr key={s.id} style={{ borderTop: "0.5px solid var(--border)" }}>
                  <td style={{ padding: "8px" }}>{s.sale_date}</td>
                  <td style={{ padding: "8px", whiteSpace: "normal", overflowWrap: "break-word" }}>
                    <div>{s.items?.management_no ?? "-"}</div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{s.items?.title ?? "-"}</div>
                  </td>
                  <td style={{ padding: "8px" }}>
                    {s.account ? EBAY_ACCOUNT_LABELS[s.account as keyof typeof EBAY_ACCOUNT_LABELS] ?? s.account : "-"}
                  </td>
                  <td style={{ padding: "8px", whiteSpace: "normal", overflowWrap: "break-word" }}>
                    {s.sale_item_title ?? "-"}
                  </td>
                  <td style={{ padding: "8px", whiteSpace: "normal", overflowWrap: "break-word" }}>
                    {s.tracking_info ?? "-"}
                  </td>
                  <td style={{ padding: "8px", textAlign: "right" }}>¥{Math.round(s.total_jpy).toLocaleString()}</td>
                  <td style={{ padding: "8px", textAlign: "right" }}>¥{Math.round(s.shipping_cost_paid).toLocaleString()}</td>
                  <td style={{ padding: "8px", textAlign: "right" }}>¥{Math.round(s.purchase_price_snapshot).toLocaleString()}</td>
                  <td style={{ padding: "8px", textAlign: "right", fontWeight: 500 }}>¥{Math.round(s.gross_profit_jpy).toLocaleString()}</td>
                  <td style={{ padding: "8px", whiteSpace: "nowrap" }}>
                    <button
                      onClick={() => startEditSale(s)}
                      style={{ fontSize: 11, padding: "2px 8px", marginRight: 4 }}
                    >
                      編集
                    </button>
                    <button onClick={() => handleDelete(s.id)} style={{ fontSize: 11, padding: "2px 8px" }}>
                      削除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!loading && list.length === 0 && <p style={{ fontSize: 13, color: "var(--text-muted)" }}>該当する売上データがありません</p>}

      <EbayXlsxFillPanel />

      <div
        style={{
          marginTop: 24,
          padding: "14px 16px",
          border: "1px solid var(--danger-text)",
          borderRadius: 12,
        }}
      >
        <p style={{ fontSize: 13, fontWeight: 700, color: "var(--danger-text)", margin: "0 0 8px" }}>
          危険な操作: 売上・粗利データ全クリア
        </p>
        <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 8px" }}>
          このタブに登録されているデータ(売上登録・eBay自動同期の取引明細/手数料明細/同期履歴・CPaSS配送実績)を全件削除します。取り消せません。在庫・仕入・経費データには影響しません。
        </p>
        <p style={{ fontSize: 13, margin: "0 0 8px" }}>
          {salesTabCountsLoading
            ? "件数を確認中..."
            : salesTabCounts
              ? `現在の件数: 売上${salesTabCounts.sales}件 / eBay取引明細${salesTabCounts.ebayTransactionLines}件 / 手数料明細${salesTabCounts.ebayTaxInvoiceLines}件 / 同期履歴${salesTabCounts.platformSettlementImports}件 / CPaSS配送実績${salesTabCounts.cpassShipments}件`
              : "件数を取得できませんでした"}
          <button
            onClick={reloadSalesTabCounts}
            disabled={salesTabCountsLoading}
            style={{ fontSize: 11, padding: "1px 8px", marginLeft: 8 }}
          >
            再取得
          </button>
        </p>
        {salesTabCountsError && (
          <p style={{ fontSize: 12, color: "var(--danger-text)", margin: "0 0 8px" }}>{salesTabCountsError}</p>
        )}
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            確認のため「{CLEAR_SALES_TAB_CONFIRM_PHRASE}」と入力してください:
          </label>
          <input
            type="text"
            value={clearSalesTabConfirmText}
            onChange={(e) => setClearSalesTabConfirmText(e.target.value)}
            style={{ width: 160 }}
          />
          <button
            onClick={handleClearSalesTabData}
            disabled={clearingSalesTab || clearSalesTabConfirmText !== CLEAR_SALES_TAB_CONFIRM_PHRASE}
            style={{ color: "var(--danger-text)", fontWeight: 700 }}
          >
            {clearingSalesTab ? "削除中..." : "売上・粗利データ全クリアを実行"}
          </button>
        </div>
        {clearSalesTabMessage && (
          <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 8 }}>{clearSalesTabMessage}</p>
        )}
        {clearSalesTabError && (
          <p style={{ fontSize: 12, color: "var(--danger-text)", marginTop: 8 }}>{clearSalesTabError}</p>
        )}
      </div>

      <div style={{ height: "2rem" }} />
    </div>
  );
}

function SummaryCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{ background: accent ? "var(--surface-1)" : "var(--surface-1)", borderRadius: "var(--radius)", padding: "1rem", border: accent ? "0.5px solid var(--border-strong)" : undefined }}>
      <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 4px" }}>{label}</p>
      <p style={{ fontSize: 20, fontWeight: 500, margin: 0 }}>{value}</p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 2 }}>{label}</label>
      {children}
    </div>
  );
}
