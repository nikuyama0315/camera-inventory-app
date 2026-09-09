import ExcelJS from "exceljs";
import { supabase } from "../supabaseClient";
import { pickField, toDateOrNull, toNumberOrNull, type ParsedCsv } from "../csvUtils";

export type Platform =
  | "ebay_financial_statement"
  | "ebay_tax_invoice"
  | "ebay_transaction_report"
  | "payoneer_transaction_report";

// レポート取込(CSV/PDF手動入力)由来のplatform一覧。platform_settlement_importsは「売上・粗利」タブの
// eBayライブ同期(ebay-sync-orders Edge Function、platform='ebay')とも共有しているため、レポート取込
// 画面の集計・履歴・削除操作は必ずこれで絞り込む(ライブ同期由来の行を誤って混在・削除しないため)。
const REPORT_IMPORT_PLATFORMS: Platform[] = [
  "ebay_financial_statement",
  "ebay_tax_invoice",
  "ebay_transaction_report",
  "payoneer_transaction_report",
];

export interface PlatformImport {
  id: string;
  platform: Platform;
  ebay_account: string | null;
  period_start: string;
  period_end: string;
  imported_at: string;
  raw_file_reference: string | null;
}

async function createImportRow(
  platform: Platform,
  ebayAccount: string | null,
  periodStart: string,
  periodEnd: string,
  rawFileReference?: string,
): Promise<PlatformImport> {
  const { data, error } = await supabase
    .from("platform_settlement_imports")
    .insert({
      platform,
      ebay_account: ebayAccount,
      period_start: periodStart,
      period_end: periodEnd,
      raw_file_reference: rawFileReference ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return data as PlatformImport;
}

// SKU(Custom Label)の最初の"-"より前の部分(大文字化)をitems.management_noの同部分と突合する。
// ebay-sync-orders Edge Functionのロジックと同じ考え方(参考候補程度の緩いヒューリスティック)。
//
// 2026-09-09追加(ユーザー指示): レポート側(CSVのCustom Label)の当該部分が「2026mmdd」のような
// 西暦4桁+MMDDの8桁形式の場合、items.management_noの体系(YYMMDD、6桁、例:260825)に合わせて
// 先頭の"20"を除いた「26mmdd」形式に変換してから突合する。management_no側はこの8桁形式には
// ならないため(常に6桁のYYMMDD形式)、この変換はレポート側の値にのみ実質的に作用する。
function skuMatchKey(sku: string | null | undefined): string | null {
  if (!sku) return null;
  const trimmed = sku.trim();
  if (!trimmed) return null;
  let key = trimmed.split("-")[0].trim().toUpperCase();
  if (/^20\d{6}$/.test(key)) {
    key = key.slice(2);
  }
  return key;
}

async function buildItemMatchIndex(): Promise<Map<string, string[]>> {
  const { data, error } = await supabase.from("items").select("id, management_no");
  if (error) throw error;
  const map = new Map<string, string[]>();
  for (const it of data ?? []) {
    const key = skuMatchKey(it.management_no as string);
    if (!key) continue;
    const arr = map.get(key) ?? [];
    arr.push(it.id as string);
    map.set(key, arr);
  }
  return map;
}

// 指定した年月(YYYY-MM-01)の月次TTMレート(monthly_exchange_rates)を取得する。無ければnull。
async function fetchTtmRate(yearMonth: string): Promise<number | null> {
  const { data } = await supabase
    .from("monthly_exchange_rates")
    .select("rate")
    .eq("year_month", yearMonth)
    .maybeSingle();
  return (data?.rate as number | undefined) ?? null;
}

// 対象年月を「取引日として最も多く登場する年月(最頻値)」で決定する。
// 単純にperiodStart(最古の日付)を使うと、レポート期間が月境界をまたいで前月末の
// 1行だけを含むケース(例: 4月分レポートの最古行が3/31付になる)で、レポート全体が
// 誤って前月分として集計されてしまう不具合があったための対策。
function modalYearMonth(dates: string[]): string {
  const counts = new Map<string, number>();
  for (const d of dates) {
    const ym = d.slice(0, 7);
    counts.set(ym, (counts.get(ym) ?? 0) + 1);
  }
  let bestYm = dates[dates.length - 1].slice(0, 7);
  let bestCount = -1;
  for (const [ym, count] of counts) {
    if (count > bestCount || (count === bestCount && ym > bestYm)) {
      bestCount = count;
      bestYm = ym;
    }
  }
  return `${bestYm}-01`;
}

// ---------------------------------------------------------------
// eBay Transaction Report
// ---------------------------------------------------------------
export interface EbayTransactionImportResult {
  importId: string;
  rowCount: number;
  periodStart: string;
  periodEnd: string;
  skippedCount?: number;
}

export async function importEbayTransactionReport(
  csv: ParsedCsv,
  ebayAccount: string,
  fileName: string,
): Promise<EbayTransactionImportResult> {
  // Custom Label(SKU)からitems.management_noへの参考突合(クロスチェック用途、情報付与のみ)。
  // このCSV由来の行はライブ同期由来のtype='SALE'行とは異なり、「売上・粗利」タブのレビュー
  // キュー(match_status IN ('unmatched','matched_pending'))には出さないため、match_status は
  // 常に 'ignored' に固定する(下記参照)。
  const itemMatchIndex = await buildItemMatchIndex();

  const parsedRows = csv.rows.map((row) => {
    const transactionDate = toDateOrNull(
      pickField(row, ["Transaction creation date", "Transaction Date", "Date"]),
    );
    const customLabel = pickField(row, ["Custom label", "Custom Label", "SKU"]);
    const matchKey = skuMatchKey(customLabel);
    const candidates = matchKey ? itemMatchIndex.get(matchKey) ?? [] : [];
    const matchedItemId = candidates.length === 1 ? candidates[0] : null;
    return {
      transaction_date: transactionDate,
      type: pickField(row, ["Type"]) ?? "",
      order_number: pickField(row, ["Order number", "Order Number"]),
      item_id: pickField(row, ["Item ID", "Item Id"]),
      custom_label: customLabel,
      matched_item_id: matchedItemId,
      // レビューキューに出さない(上記コメント参照)。ライブ同期(type='SALE')行のみが
      // unmatched/matched_pendingを使う。
      match_status: "ignored" as const,
      item_title: pickField(row, ["Item title", "Item Title"]),
      quantity: toNumberOrNull(pickField(row, ["Quantity"])),
      item_subtotal: toNumberOrNull(pickField(row, ["Item subtotal", "Item Subtotal"])),
      shipping_and_handling: toNumberOrNull(pickField(row, ["Shipping and handling", "Shipping And Handling"])),
      final_value_fee: (() => {
        const fixed = toNumberOrNull(
          pickField(row, ["Final Value Fee - fixed", "Final value fee", "Final Value Fee"]),
        );
        const variable = toNumberOrNull(pickField(row, ["Final Value Fee - variable"]));
        if (fixed === null && variable === null) return null;
        return (fixed ?? 0) + (variable ?? 0);
      })(),
      regulatory_operating_fee: toNumberOrNull(pickField(row, ["Regulatory Operating Fee", "Regulatory operating fee"])),
      international_fee: toNumberOrNull(pickField(row, ["International Fee", "International fee"])),
      gross_transaction_amount: toNumberOrNull(
        pickField(row, ["Gross transaction amount", "Gross Transaction Amount"]),
      ),
      transaction_currency: pickField(row, ["Transaction currency", "Transaction Currency"]),
      exchange_rate: toNumberOrNull(pickField(row, ["Exchange rate", "Exchange Rate"])),
      net_amount: toNumberOrNull(pickField(row, ["Net amount", "Net Amount"])),
      payout_currency: pickField(row, ["Payout currency", "Payout Currency"]),
      payout_date: toDateOrNull(pickField(row, ["Payout date", "Payout Date"])),
      payout_id: pickField(row, ["Payout ID", "Payout Id"]),
      description: pickField(row, ["Description"]),
    };
  });

  const validRows = parsedRows.filter((r) => r.transaction_date && r.type);
  if (validRows.length === 0) {
    throw new Error(
      "取引日・Typeが取得できる行が1件もありませんでした。CSVの列名が想定と異なる可能性があります。",
    );
  }

  const dates = validRows.map((r) => r.transaction_date as string).sort();
  const periodStart = dates[0];
  const periodEnd = dates[dates.length - 1];

  const importRow = await createImportRow("ebay_transaction_report", ebayAccount, periodStart, periodEnd, fileName);

  // Transaction Report CSVは同一注文・同一商品に対して複数行(Order/Refund/Hold placed・released等)
  // を持つことがあり、ebay_transaction_lines側の(order_number, item_id, type)一意制約に稀に抵触する。
  // 一括insertだと1行の抵触で全体が失敗するため、1行ずつinsertして抵触した行のみスキップする。
  let insertedCount = 0;
  let skippedCount = 0;
  for (const r of validRows) {
    const { error: rowError } = await supabase
      .from("ebay_transaction_lines")
      .insert({ ...r, import_id: importRow.id });
    if (rowError) {
      skippedCount++;
    } else {
      insertedCount++;
    }
  }
  if (insertedCount === 0) {
    throw new Error("全行の取込に失敗しました(重複データの可能性があります)。");
  }

  // Order/Refund行のGross transaction amountをUSD建てで集計し、月次照合テーブルに反映する
  // (通貨がUSD以外の行はExchange rateで換算。要件定義書§3.7bis参照)
  const grossUsdTotal = validRows
    .filter((r) => r.type === "Order" || r.type === "Refund")
    .reduce((sum, r) => {
      const amount = r.gross_transaction_amount ?? 0;
      const isUsd = (r.transaction_currency ?? "USD").toUpperCase() === "USD";
      const converted = isUsd ? amount : amount * (r.exchange_rate ?? 1);
      return sum + converted;
    }, 0);

  // Payout行のNet amount(既に入金通貨=USD建て)を合計する。eBay Financial Statement PDFの
  // 「Payouts」欄と一致することを実データで確認済み(claude/report-import-proposal.md参照)。
  const payoutUsdTotal = validRows
    .filter((r) => r.type === "Payout")
    .reduce((sum, r) => sum + (r.net_amount ?? 0), 0);

  const yearMonth = modalYearMonth(dates);
  const ttmRate = await fetchTtmRate(yearMonth);

  const { error: reconError } = await supabase.from("monthly_settlement_reconciliations").upsert(
    {
      year_month: yearMonth,
      ebay_account: ebayAccount,
      transaction_report_gross_usd: grossUsdTotal,
      transaction_report_gross_jpy: ttmRate != null ? grossUsdTotal * ttmRate : undefined,
      ebay_payout_usd: payoutUsdTotal,
      ebay_payout_jpy: ttmRate != null ? payoutUsdTotal * ttmRate : undefined,
      ttm_rate: ttmRate ?? undefined,
    },
    { onConflict: "year_month,ebay_account" },
  );
  if (reconError) throw reconError;

  return {
    importId: importRow.id,
    rowCount: insertedCount,
    periodStart,
    periodEnd,
    skippedCount: skippedCount > 0 ? skippedCount : undefined,
  };
}

// ---------------------------------------------------------------
// eBay Tax Invoices
// ---------------------------------------------------------------
function classifyFeeCategory(feeType: string | null, feeGroup: string | null): "fvf_international" | "ad_fee" | "other" {
  const text = `${feeType ?? ""} ${feeGroup ?? ""}`.toLowerCase();
  if (text.includes("ad fee") || text.includes("advertising") || text.includes("promoted")) return "ad_fee";
  if (text.includes("final value") || text.includes("international")) return "fvf_international";
  return "other";
}

interface TaxInvoiceRawRow {
  line_date: string | null;
  description: string | null;
  memo: string | null;
  order_number: string | null;
  item_number: string | null;
  fee_group: string | null;
  fee_type: string | null;
  fee_category: "fvf_international" | "ad_fee" | "other";
  currency: string;
  net_amount: number;
  jct_rate: number | null;
  jct_amount: number | null;
  total_amount: number | null;
  charged_by_entity: string | null;
}

function parseTaxInvoiceRows(csv: ParsedCsv): TaxInvoiceRawRow[] {
  return csv.rows.map((row) => {
    const feeType = pickField(row, ["Fee Type", "Fee type"]);
    const feeGroup = pickField(row, ["Fee Group", "Fee group"]);
    return {
      line_date: toDateOrNull(pickField(row, ["Transaction Date", "Date", "Line Date"])),
      description: pickField(row, ["Description"]),
      memo: pickField(row, ["Memo"]),
      order_number: pickField(row, ["Order Number", "Order number"]),
      item_number: pickField(row, ["Item Number", "Item number"]),
      fee_group: feeGroup,
      fee_type: feeType,
      fee_category: classifyFeeCategory(feeType, feeGroup),
      currency: pickField(row, ["Currency"]) ?? "USD",
      net_amount: toNumberOrNull(pickField(row, ["Net Amount", "Net amount"])) ?? 0,
      jct_rate: toNumberOrNull(pickField(row, ["JCT (%)", "JCT Rate", "JCT Rate(%)"])),
      jct_amount: toNumberOrNull(pickField(row, ["JCT amount", "JCT Amount"])),
      total_amount: toNumberOrNull(pickField(row, ["Total amount", "Total Amount"])),
      charged_by_entity: pickField(row, ["Charged By", "Charged by entity"]),
    };
  });
}

/**
 * 非USD行の実際のUSD換算レートを、同一注文番号・同一通貨のebay_transaction_lines
 * (Transaction Report CSV取込、またはeBay受注同期のどちらかで、eBay自身が算出した
 * レートとして既に保存されている)から自動取得する。2026-09-03修正: 以前はここで
 * 「USD以外の通貨行に使うTTMレート」(実際は円/USDのレート)を誤って乗算しており、
 * GBP/EUR/AUD等の金額が不正なUSD換算値になっていた不具合の修正。
 */
async function lookupFxRatesFromTransactionLines(orderNumbers: string[]): Promise<Map<string, number>> {
  const uniqueOrderNumbers = Array.from(new Set(orderNumbers.filter((v): v is string => Boolean(v))));
  const rateMap = new Map<string, number>();
  if (uniqueOrderNumbers.length === 0) return rateMap;
  const CHUNK = 200;
  for (let i = 0; i < uniqueOrderNumbers.length; i += CHUNK) {
    const chunk = uniqueOrderNumbers.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("ebay_transaction_lines")
      .select("order_number, transaction_currency, exchange_rate")
      .in("order_number", chunk);
    if (error) throw error;
    for (const row of data ?? []) {
      const r = row as { order_number: string | null; transaction_currency: string | null; exchange_rate: number | null };
      if (!r.order_number || !r.transaction_currency || r.exchange_rate == null) continue;
      const key = `${r.order_number}::${r.transaction_currency.toUpperCase()}`;
      if (!rateMap.has(key)) rateMap.set(key, r.exchange_rate);
    }
  }
  return rateMap;
}

/**
 * 2026-09-09追加(ユーザー指示): 同一注文番号での自動取得(lookupFxRatesFromTransactionLines)が
 * できなかった行について、次善の候補として「同じ日付・同じ通貨」のebay_transaction_lines行から
 * レートを取得する(eBayは同じ日の同じ通貨換算には基本的に同一レートを使うため)。注文番号一致と同様、
 * 行ごとに自動で適用する(通貨単位で一律の値を使うのではなく、行ごとの実際の取引日に対応するレートを
 * 使うため、同じ通貨でも日付が異なれば異なるレートが適用され得る)。この2段階(注文番号→同日)の
 * どちらでも見つからなかった行がある通貨だけが、引き続き手動レート入力を必要とする。
 */
async function lookupFxRatesByDate(dates: (string | null)[]): Promise<Map<string, number>> {
  const uniqueDates = Array.from(new Set(dates.filter((v): v is string => Boolean(v))));
  const rateMap = new Map<string, number>();
  if (uniqueDates.length === 0) return rateMap;
  const CHUNK = 200;
  for (let i = 0; i < uniqueDates.length; i += CHUNK) {
    const chunk = uniqueDates.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("ebay_transaction_lines")
      .select("transaction_date, transaction_currency, exchange_rate")
      .in("transaction_date", chunk);
    if (error) throw error;
    for (const row of data ?? []) {
      const r = row as {
        transaction_date: string | null;
        transaction_currency: string | null;
        exchange_rate: number | null;
      };
      if (!r.transaction_date || !r.transaction_currency || r.exchange_rate == null) continue;
      const key = `${r.transaction_date}::${r.transaction_currency.toUpperCase()}`;
      if (!rateMap.has(key)) rateMap.set(key, r.exchange_rate);
    }
  }
  return rateMap;
}

export interface TaxInvoiceAnalysis {
  rows: TaxInvoiceRawRow[];
  /** 通貨コードごとの非USD行数(自動取得できたかどうかに関わらず、内訳表示用) */
  currencyCounts: Record<string, number>;
  /** 注文番号一致・同日一致のどちらでも自動取得できなかった通貨の一覧(手動レート入力が必要) */
  unresolvedCurrencies: string[];
  /** 注文番号一致で自動取得できたレート("注文番号::通貨" -> レート)。取込実行時にそのまま再利用する。 */
  resolvedRates: Record<string, number>;
  /**
   * 2026-09-09追加: 同日一致で自動取得できたレート("日付::通貨" -> レート、日付はYYYY-MM-DD)。
   * resolvedRatesで解決できなかった行のフォールバックとして、行ごとの実際の取引日で突合する。
   */
  dateResolvedRates: Record<string, number>;
  /** 2026-09-09追加: 対象月と判定した年月(YYYY-MM-01、行の最頻月)。取込結果の期間もこの月のみになる。 */
  targetYearMonth: string;
  /**
   * 2026-09-09追加: CSV内に対象月以外(前月末・翌月初のはみ出し行)の日付が含まれていたため、
   * 取込対象から除外した行数。eBayの月次Tax InvoiceレポートはCSVの対象月を跨いだ日の行を
   * 含むことがあり(実例: 1月分レポートに2/1付の行が数件含まれていた)、これをそのまま取り込むと
   * 「取込状況」画面で翌月分まで誤って「済」と表示されてしまう不具合があったための対策
   * (ユーザー指摘により発覚)。
   */
  excludedOtherMonthCount: number;
}

/**
 * ドライラン: CSVを解析し、非USD行についてebay_transaction_linesから自動でUSD換算レートを
 * 取得できるか判定する(DBへの書き込みは行わない)。取得できなかった通貨があれば、
 * 呼び出し側(UI)は該当通貨の手動レート入力欄を表示し、importEbayTaxInvoiceRowsに渡す。
 */
export async function analyzeEbayTaxInvoiceCsv(csv: ParsedCsv): Promise<TaxInvoiceAnalysis> {
  const rows = parseTaxInvoiceRows(csv);
  const rowsWithDate = rows.filter((r) => r.line_date);
  if (rowsWithDate.length === 0) {
    throw new Error("日付が取得できる行が1件もありませんでした。CSVの列名が想定と異なる可能性があります。");
  }

  // 2026-09-09追加(ユーザー指示): eBayの月次Tax Invoiceレポートは対象月を跨いだ日の行
  // (前月末・翌月初のはみ出し)を含むことがあるため、行の最頻月を対象月とみなし、それ以外の
  // 月の行は取込対象から除外する(上記TaxInvoiceAnalysis.excludedOtherMonthCountのコメント参照)。
  const targetYearMonth = modalYearMonth(rowsWithDate.map((r) => r.line_date as string));
  const targetYm = targetYearMonth.slice(0, 7);
  const validRows = rowsWithDate.filter((r) => (r.line_date as string).slice(0, 7) === targetYm);
  const excludedOtherMonthCount = rowsWithDate.length - validRows.length;

  const nonUsdRows = validRows.filter((r) => r.currency.toUpperCase() !== "USD");
  const rateMap = await lookupFxRatesFromTransactionLines(nonUsdRows.map((r) => r.order_number ?? ""));
  // 2026-09-09追加: 注文番号一致で解決できない行のフォールバックとして、同日一致のレートも取得しておく
  // (上記コメント参照)。
  const dateRateMap = await lookupFxRatesByDate(nonUsdRows.map((r) => r.line_date));

  const currencyCounts: Record<string, number> = {};
  const unresolvedCurrencies = new Set<string>();
  for (const r of nonUsdRows) {
    const currency = r.currency.toUpperCase();
    currencyCounts[currency] = (currencyCounts[currency] ?? 0) + 1;
    const orderKey = `${r.order_number ?? ""}::${currency}`;
    const dateKey = `${r.line_date ?? ""}::${currency}`;
    if (!rateMap.has(orderKey) && !dateRateMap.has(dateKey)) {
      unresolvedCurrencies.add(currency);
    }
  }

  return {
    rows: validRows,
    currencyCounts,
    unresolvedCurrencies: Array.from(unresolvedCurrencies).sort(),
    resolvedRates: Object.fromEntries(rateMap),
    dateResolvedRates: Object.fromEntries(dateRateMap),
    targetYearMonth,
    excludedOtherMonthCount,
  };
}

/**
 * analyzeEbayTaxInvoiceCsvの結果を実際に取り込む。非USD行のUSD換算レートは、行ごとに
 * ①ebay_transaction_linesから注文番号一致で自動取得できたレート(resolvedRates)、
 * ②同じく同日一致で自動取得できたレート(dateResolvedRates、2026-09-09追加。
 *   同じ通貨でも行(取引日)ごとに別々の値が使われ得る)、
 * ③どちらも無い場合はmanualRatesByCurrency(UIで手動入力された、その通貨からUSDへの
 *   実際のレート。①②で解決できなかった行にのみ適用される)、の優先順で使用する。
 * それでも無い場合は換算せず原数値のまま保存し、警告として返す(要目視確認)。
 */
export async function importEbayTaxInvoiceRows(
  analysis: TaxInvoiceAnalysis,
  ebayAccount: string,
  fileName: string,
  manualRatesByCurrency: Record<string, number>,
): Promise<EbayTransactionImportResult & { unconvertedWarnings: string[] }> {
  const resolvedRates = new Map(Object.entries(analysis.resolvedRates));
  const dateResolvedRates = new Map(Object.entries(analysis.dateResolvedRates));
  const unconvertedWarnings: string[] = [];

  const validRows = analysis.rows.map((r) => {
    const currency = r.currency.toUpperCase();
    const isUsd = currency === "USD";
    let rateUsed: number | null = null;
    let netAmountUsd = r.net_amount;
    if (!isUsd) {
      const orderKey = `${r.order_number ?? ""}::${currency}`;
      const dateKey = `${r.line_date ?? ""}::${currency}`;
      rateUsed = resolvedRates.get(orderKey) ?? dateResolvedRates.get(dateKey) ?? manualRatesByCurrency[currency] ?? null;
      if (rateUsed != null) {
        netAmountUsd = r.net_amount * rateUsed;
      } else {
        unconvertedWarnings.push(
          `${r.order_number ?? "(注文番号不明)"} / ${currency} ${r.net_amount}: 換算レートが見つからず、USD換算されていません(要手動確認)`,
        );
      }
    }
    return { ...r, currency, ttm_rate_used: rateUsed, net_amount_usd: netAmountUsd };
  });

  const dates = validRows.map((r) => r.line_date as string).sort();
  const periodStart = dates[0];
  const periodEnd = dates[dates.length - 1];

  const importRow = await createImportRow("ebay_tax_invoice", ebayAccount, periodStart, periodEnd, fileName);

  const { error } = await supabase
    .from("ebay_tax_invoice_lines")
    .insert(validRows.map((r) => ({ ...r, import_id: importRow.id })));
  if (error) throw error;

  // fee_category別にUSD建てで集計し、月次照合テーブルに反映する
  const fvfIntlTotal = validRows
    .filter((r) => r.fee_category === "fvf_international")
    .reduce((sum, r) => sum + r.net_amount_usd, 0);
  const adFeeTotal = validRows
    .filter((r) => r.fee_category === "ad_fee")
    .reduce((sum, r) => sum + r.net_amount_usd, 0);

  const yearMonth = modalYearMonth(dates);
  const { error: reconError } = await supabase.from("monthly_settlement_reconciliations").upsert(
    {
      year_month: yearMonth,
      ebay_account: ebayAccount,
      tax_invoice_fvf_intl_fee_usd: fvfIntlTotal,
      tax_invoice_ad_fee_usd: adFeeTotal,
    },
    { onConflict: "year_month,ebay_account" },
  );
  if (reconError) throw reconError;

  return { importId: importRow.id, rowCount: validRows.length, periodStart, periodEnd, unconvertedWarnings };
}

// ---------------------------------------------------------------
// Payoneer Transaction Report(2アカウント統合)
// ---------------------------------------------------------------
export async function importPayoneerReport(csv: ParsedCsv, fileName: string): Promise<EbayTransactionImportResult> {
  const parsedRows = csv.rows.map((row) => ({
    transaction_date: toDateOrNull(pickField(row, ["Date", "Transaction Date"])),
    transaction_time: pickField(row, ["Time"]),
    credit_amount: toNumberOrNull(pickField(row, ["Credit Amount", "Credit amount"])),
    debit_amount: toNumberOrNull(pickField(row, ["Debit Amount", "Debit amount"])),
    status: pickField(row, ["Status"]),
    running_balance: toNumberOrNull(pickField(row, ["Running Balance", "Balance"])),
    description: pickField(row, ["Description"]),
  }));

  const validRows = parsedRows.filter((r) => r.transaction_date);
  if (validRows.length === 0) {
    throw new Error("日付が取得できる行が1件もありませんでした。CSVの列名が想定と異なる可能性があります。");
  }

  const dates = validRows.map((r) => r.transaction_date as string).sort();
  const periodStart = dates[0];
  const periodEnd = dates[dates.length - 1];

  const importRow = await createImportRow("payoneer_transaction_report", null, periodStart, periodEnd, fileName);

  const { error } = await supabase
    .from("payoneer_transactions")
    .insert(validRows.map((r) => ({ ...r, import_id: importRow.id })));
  if (error) throw error;

  // 月次サマリーを自動計算(Credit amount合計 + 月初のRunning balance)
  const creditTotal = validRows.reduce((sum, r) => sum + (r.credit_amount ?? 0), 0);
  const firstRow = [...validRows].sort((a, b) => (a.transaction_date! < b.transaction_date! ? -1 : 1))[0];
  const yearMonth = modalYearMonth(dates);
  const ttmRate = await fetchTtmRate(yearMonth);
  const runningBalanceStart = firstRow?.running_balance ?? 0;

  const { error: summaryError } = await supabase.from("monthly_payoneer_summary").upsert(
    {
      year_month: yearMonth,
      import_id: importRow.id,
      credit_amount_total: creditTotal,
      running_balance_start: runningBalanceStart,
      running_balance_start_jpy: ttmRate != null ? runningBalanceStart * ttmRate : undefined,
      ttm_rate: ttmRate ?? undefined,
    },
    { onConflict: "year_month" },
  );
  if (summaryError) throw summaryError;

  return { importId: importRow.id, rowCount: validRows.length, periodStart, periodEnd };
}

// ---------------------------------------------------------------
// eBay Financial Statement(PDF・手動入力 / PDFをExcelに変換したファイルからの自動解析)
// ---------------------------------------------------------------
export interface FinancialStatementManualInput {
  ebayAccount: string;
  yearMonth: string; // YYYY-MM
  payoutUsd: number;
  closingFundsUsd: number;
}

export interface FinancialStatementParseResult {
  payoutUsd: number | null;
  closingFundsUsd: number | null;
  ebayAccount: string | null;
  yearMonth: string | null; // YYYY-MM
}

/**
 * 2026-09-09追加(ユーザー指示): eBay Financial StatementのPDFを直接解析することはできないが、
 * PDFをExcel(.xlsx)に変換したファイルであれば、明細(Payouts・Closing funds等)が1行=1セルの
 * テキストとして抽出できるため、それを解析してPayout・Closing funds・対象年月・eBayアカウントの
 * 参考値を取得する(実際のeBay公式PDFのExcel変換結果で検証済み)。
 *
 * 抽出方法: 全セルのテキストを走査し、
 *   - 前後の空白(改行・タブ・&nbsp;等)を正規化した上で先頭が「Payouts」/「Closing funds」で始まり、
 *     末尾が金額(例: -$6,147.82 / $369.77)で終わるセルから、それぞれの値を取り出す
 *     (「Payouts are sent to...」等の説明文はこの両条件を同時に満たさないため誤検出しない)。
 *   - 「eBay username」というセルの直後のセルの値をeBayアカウント名の候補とする。
 *   - 「Date range: M/D/YY ...」という文言から、統治期間の開始日(=対象年月)を取り出す。
 * 値が見つからなかった項目はnullを返す(呼び出し側は入力欄を空のままにし、手動入力を促す)。
 */
export async function parseFinancialStatementXlsx(buffer: ArrayBuffer): Promise<FinancialStatementParseResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const cellTexts: string[] = [];
  for (const ws of workbook.worksheets) {
    ws.eachRow((row) => {
      row.eachCell((cell) => {
        const raw = cell.value;
        if (raw == null) return;
        const text = typeof raw === "object" && raw !== null && "richText" in (raw as object)
          ? (raw as { richText: { text: string }[] }).richText.map((r) => r.text).join("")
          : String(raw);
        if (text.trim()) cellTexts.push(text);
      });
    });
  }

  const AMOUNT_RE = /(-?)\$\s*([\d,]+\.\d{2})\s*$/;
  function extractLabeledAmount(label: string): number | null {
    for (const text of cellTexts) {
      const norm = text.replace(/\s+/g, " ").trim();
      if (!norm.startsWith(label)) continue;
      const m = norm.match(AMOUNT_RE);
      if (!m) continue;
      const value = parseFloat(m[2].replace(/,/g, ""));
      return m[1] === "-" ? -value : value;
    }
    return null;
  }

  const payoutUsd = extractLabeledAmount("Payouts");
  const closingFundsUsd = extractLabeledAmount("Closing funds");

  let ebayAccount: string | null = null;
  const usernameIdx = cellTexts.findIndex((t) => t.replace(/\s+/g, " ").trim() === "eBay username");
  if (usernameIdx !== -1 && cellTexts[usernameIdx + 1]) {
    ebayAccount = cellTexts[usernameIdx + 1].trim();
  }

  let yearMonth: string | null = null;
  const dateRangeText = cellTexts.find((t) => t.includes("Date range:"));
  if (dateRangeText) {
    // 例: "Date range: 1/1/26 12:00 AM - 1/31/26 11:59 PM PST"(M/D/YY、西暦下2桁)
    const m = dateRangeText.match(/Date range:\s*(\d{1,2})\/(\d{1,2})\/(\d{2})/);
    if (m) {
      const month = Number(m[1]);
      const year = 2000 + Number(m[3]);
      yearMonth = `${year}-${String(month).padStart(2, "0")}`;
    }
  }

  return { payoutUsd, closingFundsUsd, ebayAccount, yearMonth };
}

export async function saveFinancialStatementManualEntry(input: FinancialStatementManualInput): Promise<void> {
  const yearMonthDate = `${input.yearMonth}-01`;

  const { error } = await supabase.from("monthly_settlement_reconciliations").upsert(
    {
      year_month: yearMonthDate,
      ebay_account: input.ebayAccount,
      ebay_payout_usd: input.payoutUsd,
      ebay_closing_funds_usd: input.closingFundsUsd,
    },
    { onConflict: "year_month,ebay_account" },
  );
  if (error) throw error;
}

// ---------------------------------------------------------------
// 月次照合サマリー(eBay Payout合算 vs Payoneer入金額)
// ---------------------------------------------------------------
export interface MonthlyReconciliationSummary {
  yearMonth: string; // YYYY-MM-01
  ebayPayoutUsdTotal: number | null; // 2アカウント合算
  ebayPayoutJpyTotal: number | null; // 2アカウント合算(TTM未設定の月はnull)
  payoneerCreditUsd: number | null;
  payoneerCreditJpy: number | null;
  // eBay Payout(JPY、マイナス)+ Payoneer入金額(JPY、プラス)の残差。
  // ユーザーの手動集計シート「Payoneer Fee(JPY)」と同じ算出式(実データで一致確認済み)。
  // 実際の手数料(為替スプレッド)だけでなく、月またぎの入金タイミング差も含まれる点に注意。
  payoneerFeeJpy: number | null;
  /**
   * 2026-09-09追加(ユーザー指示): 上記のJPY版と同じ算出式(eBay Payout(USD、マイナス)+
   * Payoneer入金額(USD、プラス))をUSD建てでも計算したもの。JPY版は月次為替レート
   * (monthly_exchange_rates)が保存されていないと常にnullになってしまうため
   * (ebay_payout_jpyがTransaction Report取込時点でレート未保存だと記録されない仕組みのため)、
   * レートに依存しないUSD建ての差額も併せて表示する。
   */
  payoneerFeeUsd: number | null;
}

/**
 * 2026-09-09追加(ユーザー指示): 月次売掛金Excel更新機能で、Payoneer Transaction Reportを
 * 都度アップロードし直すのではなく、既に取込済みのmonthly_payoneer_summary(Payoneer
 * Transaction Report(CSV・2アカウント統合)取込時に自動集計されるテーブル)を再利用する。
 * 対象年月のデータが無ければnullを返す(呼び出し側は「先にPayoneerレポートを取り込んでください」
 * という趣旨のエラーにする)。
 */
/**
 * 2026-09-09追加(ユーザー指示): 月次売掛金Excel更新機能で、eBay Financial Statementを変換した
 * Excelファイルを都度アップロードし直すのではなく、既に上部のeBay Financial Statement欄で
 * 解析・保存済みのmonthly_settlement_reconciliations(ebay_payout_usd・ebay_closing_funds_usd)を
 * 再利用する(ユーザー指摘: 「既に取り込んだものを使えるのでは？」)。
 * ebay_payout_usdはTransaction Report取込でも書き込まれる共有カラムのため(取込状況の
 * Financial Statement済/未判定で対応済みの問題と同じ)、ebay_closing_funds_usdが入力済み
 * (null以外、Financial Statementの保存からしか書き込まれない)の場合のみ、本当にFinancial
 * Statementが保存済みとみなして値を返す。未保存ならnullを返す(呼び出し側は「先に上部で
 * 保存してください」という趣旨のエラーにする)。
 */
export async function fetchFinancialStatementForMonth(
  ebayAccount: string,
  yearMonth: string, // "YYYY-MM"
): Promise<{ payoutUsd: number; closingFundsUsd: number } | null> {
  const { data, error } = await supabase
    .from("monthly_settlement_reconciliations")
    .select("ebay_payout_usd, ebay_closing_funds_usd")
    .eq("ebay_account", ebayAccount)
    .eq("year_month", `${yearMonth}-01`)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.ebay_closing_funds_usd == null) return null;
  return {
    payoutUsd: (data.ebay_payout_usd as number | null) ?? 0,
    closingFundsUsd: data.ebay_closing_funds_usd as number,
  };
}

export async function fetchPayoneerSummaryForMonth(
  yearMonth: string, // "YYYY-MM"
): Promise<{ creditAmountTotal: number; runningBalanceStart: number } | null> {
  const { data, error } = await supabase
    .from("monthly_payoneer_summary")
    .select("credit_amount_total, running_balance_start")
    .eq("year_month", `${yearMonth}-01`)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    creditAmountTotal: (data.credit_amount_total as number | null) ?? 0,
    runningBalanceStart: (data.running_balance_start as number | null) ?? 0,
  };
}

export async function fetchMonthlyReconciliationSummary(): Promise<MonthlyReconciliationSummary[]> {
  const { data: reconRows, error: reconErr } = await supabase
    .from("monthly_settlement_reconciliations")
    .select("year_month, ebay_payout_usd, ebay_payout_jpy");
  if (reconErr) throw reconErr;

  const { data: payoneerRows, error: payoneerErr } = await supabase
    .from("monthly_payoneer_summary")
    .select("year_month, credit_amount_total, ttm_rate");
  if (payoneerErr) throw payoneerErr;

  const byMonth = new Map<string, { payoutUsd: number; payoutJpy: number; anyJpy: boolean }>();
  for (const r of reconRows ?? []) {
    const ym = r.year_month as string;
    const entry = byMonth.get(ym) ?? { payoutUsd: 0, payoutJpy: 0, anyJpy: false };
    entry.payoutUsd += (r.ebay_payout_usd as number | null) ?? 0;
    if (r.ebay_payout_jpy != null) {
      entry.payoutJpy += r.ebay_payout_jpy as number;
      entry.anyJpy = true;
    }
    byMonth.set(ym, entry);
  }

  const payoneerByMonth = new Map<string, { creditUsd: number; ttmRate: number | null }>();
  for (const r of payoneerRows ?? []) {
    payoneerByMonth.set(r.year_month as string, {
      creditUsd: (r.credit_amount_total as number | null) ?? 0,
      ttmRate: (r.ttm_rate as number | null) ?? null,
    });
  }

  const months = new Set<string>([...byMonth.keys(), ...payoneerByMonth.keys()]);
  return [...months]
    .sort()
    .reverse()
    .map((ym) => {
      const recon = byMonth.get(ym);
      const payoneer = payoneerByMonth.get(ym);
      const payoutUsdTotal = recon ? recon.payoutUsd : null;
      const payoutJpyTotal = recon && recon.anyJpy ? recon.payoutJpy : null;
      const creditUsd = payoneer ? payoneer.creditUsd : null;
      const creditJpy = payoneer && payoneer.ttmRate != null ? payoneer.creditUsd * payoneer.ttmRate : null;
      const feeJpy = payoutJpyTotal != null && creditJpy != null ? payoutJpyTotal + creditJpy : null;
      const feeUsd = payoutUsdTotal != null && creditUsd != null ? payoutUsdTotal + creditUsd : null;
      return {
        yearMonth: ym,
        ebayPayoutUsdTotal: payoutUsdTotal,
        ebayPayoutJpyTotal: payoutJpyTotal,
        payoneerCreditUsd: creditUsd,
        payoneerCreditJpy: creditJpy,
        payoneerFeeJpy: feeJpy,
        payoneerFeeUsd: feeUsd,
      };
    });
}

// ---------------------------------------------------------------
// 取込履歴
// ---------------------------------------------------------------
/**
 * 2026-09-08修正: platform_settlement_importsは「売上・粗利」タブのeBayライブ同期機能
 * (ebay-sync-orders Edge Function、platform='ebay')とも共有しているテーブルのため、
 * 絞り込み無しで全件表示すると、このレポート取込画面とは無関係なライブ同期のログ行が
 * 「レポート種別: ebay」として大量に混在してしまい、上部の「取込状況」(レポート取込由来の
 * 4種別のみを集計)と矛盾しているように見える不具合があった(ユーザー指摘により発覚)。
 * getReportImportDataCounts()/clearAllReportImportData()と同じREPORT_IMPORT_PLATFORMSで
 * 絞り込み、レポート取込由来の行のみを対象にする。
 */
export async function fetchImportHistory(): Promise<PlatformImport[]> {
  const { data, error } = await supabase
    .from("platform_settlement_imports")
    .select("*")
    .in("platform", REPORT_IMPORT_PLATFORMS)
    .order("imported_at", { ascending: false })
    .limit(30);
  if (error) throw error;
  return data as PlatformImport[];
}

// ---------------------------------------------------------------
// レポート種別・アカウントごとの月別取込状況(2026-09-08追加、当初のMAX(period_end)表示から
// 「直近6か月を月ごとに表示」へユーザー指示により変更)。
// ---------------------------------------------------------------
export interface MonthlyImportStatusCell {
  yearMonth: string; // "YYYY-MM"
  imported: boolean;
}

export interface MonthlyImportStatusRow {
  platform: Platform;
  account: string | null;
  /**
   * 古い月→新しい月の順。当年1月〜前月まで(2026-09-09修正)。最後の要素が前月。
   * 2026-09-09再修正(ユーザー指摘): 各レポートは月が閉まってから翌月7日頃までに提供される
   * ため、警告判定(reportImportRowHasAlert)は「前月分」の取込有無を見る必要がある
   * (「当月分」は月の途中では原理的にまだ提供され得ないため、判定対象として意味を成さない)。
   * 前月はこのmonths配列の最後の要素と一致するため、当月分を別途保持する必要は無い。
   */
  months: MonthlyImportStatusCell[];
}

// 「取込状況」表の行順序。Payoneerのみ2アカウント統合のためaccount=null。
const IMPORT_STATUS_ROW_DEFS: Array<{ platform: Platform; account: string | null }> = [
  { platform: "ebay_transaction_report", account: "soulcamera" },
  { platform: "ebay_transaction_report", account: "soulmenjapan" },
  { platform: "ebay_tax_invoice", account: "soulcamera" },
  { platform: "ebay_tax_invoice", account: "soulmenjapan" },
  { platform: "ebay_financial_statement", account: "soulcamera" },
  { platform: "ebay_financial_statement", account: "soulmenjapan" },
  { platform: "payoneer_transaction_report", account: null },
];

function lastDayOfMonthNum(year: number, month1based: number): number {
  return new Date(year, month1based, 0).getDate();
}

/**
 * 「取込状況」画面向けに、当年1月〜前月について、レポート種別・アカウントごとにその月のデータが
 * 取込済みかどうかを判定する(2026-09-08、直近6か月→直近12か月を経てユーザー指示により変更。
 * 年をまたいで固定N か月分表示すると前年分まで表示されてしまい分かりにくいため、当年1月始まりに
 * 統一した)。
 * CSV取込3種は、platform_settlement_imports(レポート取込由来のplatformのみ)の中に、対象月の
 * 1日〜末日と期間が重なる(period_start<=月末 && period_end>=月初)行が1つでもあれば「取込済み」と
 * みなす(1回のCSVが月境界をまたぐ実データがあるため、月初=period_startの完全一致ではなく期間の
 * 重なりで判定する)。eBay Financial Statement(PDF手動入力)のみ、monthly_settlement_reconciliations
 * のebay_closing_funds_usdが入力済み(null以外)かで判定する(2026-09-09修正: 以前は対象年月の行が
 * 存在するだけで「済」としていたが、同じ行はTransaction Report取込等でも作成・更新されるため、
 * Financial Statementを一度も入力していない月まで誤って「済」表示になる不具合があった。
 * ebay_closing_funds_usdはFinancial Statementの手動保存からしか書き込まれないカラムのため、
 * これを実際に入力済みかどうかの判定に使う)。
 */
export async function fetchMonthlyImportStatus(): Promise<MonthlyImportStatusRow[]> {
  const now = new Date();
  const currentYear = now.getFullYear();
  const months: string[] = [];
  // 2026-09-09修正(ユーザー指示): 「取込状況(当年1月〜当月)」を「当年1月〜前月」に変更。
  // now.getMonth()は0始まりのため、この値がそのまま「前月」の1始まり月番号になる
  // (例: 9月ならgetMonth()=8で、これが前月=8月を表す)。1月時点では前月が前年12月に
  // なり「当年」の範囲外のため、ループ上限が0になり表は空になる(意図した挙動)。
  for (let m = 1; m <= now.getMonth(); m++) {
    months.push(`${currentYear}-${String(m).padStart(2, "0")}`);
  }

  const { data: importRows, error: importErr } = await supabase
    .from("platform_settlement_imports")
    .select("platform, ebay_account, period_start, period_end")
    .in("platform", REPORT_IMPORT_PLATFORMS);
  if (importErr) throw importErr;

  const { data: reconRows, error: reconErr } = await supabase
    .from("monthly_settlement_reconciliations")
    .select("year_month, ebay_account, ebay_closing_funds_usd");
  if (reconErr) throw reconErr;

  const typedImportRows = (importRows ?? []) as Array<{
    platform: Platform;
    ebay_account: string | null;
    period_start: string;
    period_end: string;
  }>;
  // 2026-09-09修正: ebay_payout_usdはTransaction Report取込(importEbayTransactionReport)でも
  // 書き込まれる共有カラムのため、これだけでFinancial Statementの入力有無を判定すると、
  // Transaction Reportしか取り込んでいない月まで「済」と誤表示されてしまう不具合があった
  // (ユーザー指摘により発覚: soulcamera/soulmenjapanの多くの月がFinancial Statement未実行にも
  // 関わらず「済」表示になっていた)。ebay_closing_funds_usdはsaveFinancialStatementManualEntry
  // (このセクション下部)からしか書き込まれないカラムのため、これがnullでないことをもって
  // 「実際にFinancial Statementが入力された」と判定する。
  const typedReconRows = (reconRows ?? []) as Array<{
    year_month: string;
    ebay_account: string | null;
    ebay_closing_funds_usd: number | null;
  }>;

  function monthBounds(ym: string): { start: string; end: string } {
    const [y, m] = ym.split("-").map(Number);
    return { start: `${ym}-01`, end: `${ym}-${String(lastDayOfMonthNum(y, m)).padStart(2, "0")}` };
  }

  function isImported(platform: Platform, account: string | null, ym: string): boolean {
    const { start, end } = monthBounds(ym);
    return platform === "ebay_financial_statement"
      ? typedReconRows.some(
          (r) => r.ebay_account === account && r.year_month.slice(0, 7) === ym && r.ebay_closing_funds_usd != null,
        )
      : typedImportRows.some(
          (r) =>
            r.platform === platform &&
            (account === null || r.ebay_account === account) &&
            r.period_start <= end &&
            r.period_end >= start,
        );
  }

  return IMPORT_STATUS_ROW_DEFS.map(({ platform, account }) => ({
    platform,
    account,
    months: months.map((ym) => ({ yearMonth: ym, imported: isImported(platform, account, ym) })),
  }));
}

/**
 * 「取込状況」の1行(レポート種別×アカウント)が警告対象かどうかを判定する(2026-09-08追加、
 * 2026-09-09再修正)。各レポートは月が閉まってから翌月7日頃までに提供されるため、当月7日を
 * 過ぎても前月分が未取込の場合に警告とする(「当月分」の取込有無は、月の途中では原理的に
 * まだ提供され得ないため判定対象にできない)。前月はrow.months配列の最後の要素と一致する
 * (months自体が当年1月〜前月までのため)。ImportPage.tsx(行ごとの⚠表示)とApp.tsx
 * (ヘッダー直下の全ページ共通バナー)の両方で同じ基準を使うための共有ロジック。
 */
export function reportImportRowHasAlert(row: MonthlyImportStatusRow, today: Date = new Date()): boolean {
  const previousMonthCell = row.months[row.months.length - 1];
  return today.getDate() > 6 && previousMonthCell != null && !previousMonthCell.imported;
}

// ---------------------------------------------------------------
// 危険な操作: レポート取込データ全クリア(2026-08-31追加)
// ---------------------------------------------------------------

const ZERO_UUID_REPORT = "00000000-0000-0000-0000-000000000000";

export interface ReportImportDataCounts {
  platformSettlementImports: number;
  ebayTransactionLines: number;
  ebayTaxInvoiceLines: number;
  payoneerTransactions: number;
  monthlySettlementReconciliations: number;
  monthlyPayoneerSummary: number;
}

/**
 * 「レポート取込」画面(ImportPage.tsx)経由で登録されたデータの件数をまとめて取得する。
 * 危険な操作(全クリア)の確認表示用。
 *
 * 注意: ebay_transaction_lines・ebay_tax_invoice_lines・platform_settlement_importsは、
 * 「売上・粗利」タブのeBayライブ同期機能(ebay-sync-orders Edge Function、
 * platform_settlement_imports.platform='ebay')とも共有しているテーブルのため、
 * レポート取込由来の行(platform IN ebay_financial_statement/ebay_tax_invoice/
 * ebay_transaction_report/payoneer_transaction_report のimport_idを持つ行)のみを対象に
 * カウントする。ライブ同期由来の行(platform='ebay')は対象外(売上・粗利タブ側の機能)。
 * monthly_settlement_reconciliations・monthly_payoneer_summaryはレポート取込専用テーブルの
 * ため全件が対象。
 */
export async function getReportImportDataCounts(): Promise<ReportImportDataCounts> {
  const importsRes = await supabase
    .from("platform_settlement_imports")
    .select("id")
    .in("platform", REPORT_IMPORT_PLATFORMS);
  if (importsRes.error) throw importsRes.error;
  const importIds = (importsRes.data ?? []).map((r) => r.id as string);

  const zeroCount = { count: 0, error: null as null };
  const [ebayTransactionLines, ebayTaxInvoiceLines, payoneerTransactions, monthlySettlementReconciliations, monthlyPayoneerSummary] =
    await Promise.all([
      importIds.length
        ? supabase.from("ebay_transaction_lines").select("id", { count: "exact", head: true }).in("import_id", importIds)
        : Promise.resolve(zeroCount),
      importIds.length
        ? supabase.from("ebay_tax_invoice_lines").select("id", { count: "exact", head: true }).in("import_id", importIds)
        : Promise.resolve(zeroCount),
      importIds.length
        ? supabase.from("payoneer_transactions").select("id", { count: "exact", head: true }).in("import_id", importIds)
        : Promise.resolve(zeroCount),
      supabase.from("monthly_settlement_reconciliations").select("id", { count: "exact", head: true }),
      supabase.from("monthly_payoneer_summary").select("id", { count: "exact", head: true }),
    ]);
  for (const r of [ebayTransactionLines, ebayTaxInvoiceLines, payoneerTransactions, monthlySettlementReconciliations, monthlyPayoneerSummary]) {
    if (r.error) throw r.error;
  }
  return {
    platformSettlementImports: importIds.length,
    ebayTransactionLines: ebayTransactionLines.count ?? 0,
    ebayTaxInvoiceLines: ebayTaxInvoiceLines.count ?? 0,
    payoneerTransactions: payoneerTransactions.count ?? 0,
    monthlySettlementReconciliations: monthlySettlementReconciliations.count ?? 0,
    monthlyPayoneerSummary: monthlyPayoneerSummary.count ?? 0,
  };
}

/**
 * 「レポート取込」画面経由で登録されたデータを全件削除する(2026-08-31追加)。
 * 対象: platform_settlement_imports(レポート取込由来のplatformのみ)・ebay_transaction_lines・
 * ebay_tax_invoice_lines・payoneer_transactions(いずれもレポート取込由来のimport_idの行のみ、
 * platform_settlement_importsの削除にON DELETE CASCADEで連動)・monthly_settlement_reconciliations・
 * monthly_payoneer_summary(全件、レポート取込専用テーブル)。
 *
 * 「売上・粗利」タブのeBayライブ同期データ(platform='ebay'、type='SALE'の行)・売上登録(sales)・
 * CPaSS配送実績(cpass_shipments)には一切影響しない(別スコープ、あちらは「危険な操作: 売上・粗利
 * データ全クリア」機能を参照)。
 *
 * 削除順序に注意: monthly_payoneer_summary.import_id が platform_settlement_imports を参照して
 * おり(削除ルールNO ACTION)、先にmonthly_payoneer_summaryを削除する必要がある。
 * ebay_transaction_lines/ebay_tax_invoice_lines/payoneer_transactionsはON DELETE CASCADEのため、
 * platform_settlement_imports側(レポート取込由来分のみ)を削除すれば自動的に連動削除される。
 */
export async function clearAllReportImportData(): Promise<void> {
  // 2026-09-08追加: 削除前に対象件数を数えておき、削除後にreport_import_clear_logへ1件記録する。
  // 全クリア後は取込履歴が空になり「一度も取込んでいない」のか「取込んだが全クリアした」のか
  // 画面から区別できなくなってしまうため(ユーザー指摘)、実行日時と削除件数を残す。
  const counts = await getReportImportDataCounts();
  const totalDeleted =
    counts.platformSettlementImports +
    counts.ebayTransactionLines +
    counts.ebayTaxInvoiceLines +
    counts.payoneerTransactions +
    counts.monthlySettlementReconciliations +
    counts.monthlyPayoneerSummary;

  const summaryDel = await supabase.from("monthly_payoneer_summary").delete().neq("id", ZERO_UUID_REPORT);
  if (summaryDel.error) throw summaryDel.error;

  const reconDel = await supabase.from("monthly_settlement_reconciliations").delete().neq("id", ZERO_UUID_REPORT);
  if (reconDel.error) throw reconDel.error;

  const importsDel = await supabase
    .from("platform_settlement_imports")
    .delete()
    .in("platform", REPORT_IMPORT_PLATFORMS);
  if (importsDel.error) throw importsDel.error;

  const logErr = (await supabase.from("report_import_clear_log").insert({ records_deleted: totalDeleted })).error;
  if (logErr) {
    // 全クリア自体は既に成功しているため、記録の失敗でユーザー操作を失敗扱いにはしない。
    console.warn("report_import_clear_logへの記録に失敗しました:", logErr);
  }
}

export interface ReportImportClearLogEntry {
  id: string;
  cleared_at: string;
  records_deleted: number;
}

/** 「レポート取込データ全クリア」の実行履歴(直近10件)を取得する(2026-09-08追加)。 */
export async function fetchReportImportClearLog(): Promise<ReportImportClearLogEntry[]> {
  const { data, error } = await supabase
    .from("report_import_clear_log")
    .select("*")
    .order("cleared_at", { ascending: false })
    .limit(10);
  if (error) throw error;
  return data as ReportImportClearLogEntry[];
}
