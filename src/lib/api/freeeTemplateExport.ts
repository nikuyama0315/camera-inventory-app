import ExcelJS from "exceljs";
import { supabase } from "../supabaseClient";
import { dedupeTaxInvoiceRows } from "./ebaySync";
import { fetchMonthlyExchangeRates } from "./exchangeRates";

/**
 * 「Freee取引テンプレート用データ作成」(CSV出力タブ、2026-09-10追加)。
 * ユーザー提供のテンプレート(public/freee_torihiki_template.xlsx、シート「Sheet1」、
 * A1:K1がヘッダー、A2:K5が2行目=eBay/Soulcamera・3行目=eBay/Soulmenjapan・
 * 4行目=メルカリ・5行目=ヤフーフリマの4行)のI・J・K列(売上高・販売手数料・広告宣伝費)と
 * C・F列(年月・発生日)を、対象月の取込済みデータから自動計算して埋め、ダウンロードさせる。
 *
 * テンプレート自体はplaceholderとして「円で」という文字列が入っているだけなので、C/F列
 * (年月=YYYYMM、発生日=対象月末日のYYYYMMDD)も対象月に合わせて上書きする(そうしないと
 * テンプレートの例のまま=2026年1月固定になってしまうため)。
 */

const TEMPLATE_URL = "/freee_torihiki_template.xlsx";
const TEMPLATE_SHEET_NAME = "Sheet1";

// ルール1(eBay Transaction Report)の対象type。
const GROSS_TYPES = new Set(["Order", "Refund"]);

// Tax Invoiceの「Final value fees・International fees・Regulatory Operating Fees」小計対象。
// fee_category='other'には上記3種の他にCredits/Debits/Subscription/Insertion feesも含まれる
// (ebaySync.tsのdedupeTaxInvoiceRows付近のコメント参照)ため、fee_categoryではなく
// 生のFee Group/Fee Typeで直接判定する。
const FEE_GROUPS = new Set(["Final value fees", "International fees", "Regulatory Operating Fees"]);
const FEE_TYPES_RAW = new Set([
  "INTERNATIONAL_FEE",
  "FINAL_VALUE_FEE",
  "FINAL_VALUE_FEE_FIXED_PER_ORDER",
  "REGULATORY_OPERATING_FEE",
]);

// 通信費(サブスクリプション・都度課金手数料)の小計対象。Fee Groupが「Subscription and onetime fees」の行
// (実例: Fee Type「Store (Basic): Subscription Fee」)。ユーザー指示によりFreee出力の勘定科目は
// 「通信費」・税区分は「不課税」として計上する(2026-09-12追加)。Credits/Debits/Insertion feesは
// 対象外(これらはSubscription and onetime feesとは別のFee Group)。
const SUBSCRIPTION_FEE_GROUP = "Subscription and onetime fees";

async function fetchImportIds(platform: string, account: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("platform_settlement_imports")
    .select("id")
    .eq("platform", platform)
    .eq("ebay_account", account);
  if (error) throw error;
  return (data ?? []).map((r) => r.id as string);
}

/**
 * ルール1: 該当アカウントのeBay Transaction Report取込データのうち、type=Order/Refundの
 * Gross transaction amountを合計する(USD以外はExchange rateでUSD換算)。円換算(TTM乗算)は
 * 呼び出し側で行う。
 */
async function computeTransactionReportGrossUsd(
  account: string,
  monthStart: string,
  monthEnd: string,
): Promise<number> {
  const importIds = await fetchImportIds("ebay_transaction_report", account);
  if (importIds.length === 0) return 0;

  const { data, error } = await supabase
    .from("ebay_transaction_lines")
    .select("type, gross_transaction_amount, transaction_currency, exchange_rate")
    .in("import_id", importIds)
    .gte("transaction_date", monthStart)
    .lte("transaction_date", monthEnd);
  if (error) throw error;

  return (data ?? [])
    .filter((r) => GROSS_TYPES.has(r.type as string))
    .reduce((sum, r) => {
      const amount = (r.gross_transaction_amount as number | null) ?? 0;
      const currency = ((r.transaction_currency as string | null) ?? "USD").toUpperCase();
      const converted = currency === "USD" ? amount : amount * ((r.exchange_rate as number | null) ?? 1);
      return sum + converted;
    }, 0);
}

interface TaxInvoiceFeeTotals {
  /** Final value fees・International fees・Regulatory Operating Feesの小計(USD) */
  feeUsd: number;
  /** Ad feesの小計(USD) */
  adFeeUsd: number;
  /** Subscription and onetime fees(通信費・不課税)の小計(USD) */
  subscriptionFeeUsd: number;
}

/**
 * 該当アカウントのeBay Tax Invoice取込データから、Fee Group別のUSD建て小計を出す。
 * USD以外の通貨行は、取込時点で既にebay_transaction_linesとのOrder number突合(同日突合含む)
 * によりUSD換算済みの値(net_amount_usd)をそのまま使う(reportImports.ts importEbayTaxInvoiceRows
 * 参照。ここで改めて突合をやり直すと、取込後に増減したebay_transaction_linesの状態によって
 * 結果が変わってしまうため、取込時点の確定値を使うのが正しい)。
 */
async function computeTaxInvoiceFeeTotals(
  account: string,
  monthStart: string,
  monthEnd: string,
): Promise<TaxInvoiceFeeTotals> {
  const importIds = await fetchImportIds("ebay_tax_invoice", account);
  if (importIds.length === 0) return { feeUsd: 0, adFeeUsd: 0, subscriptionFeeUsd: 0 };

  const { data, error } = await supabase
    .from("ebay_tax_invoice_lines")
    .select("order_number, item_number, line_date, description, fee_type, fee_group, fee_category, net_amount, net_amount_usd")
    .in("import_id", importIds)
    .gte("line_date", monthStart)
    .lte("line_date", monthEnd);
  if (error) throw error;

  // 2026-09-06の既知の不具合(一部取込バッチで完全重複行が発生する)に対応するため、
  // 「売上・粗利」タブと同じ重複排除ロジックを再利用する。
  const rows = dedupeTaxInvoiceRows(
    (data ?? []) as Array<{
      order_number: string | null;
      item_number: string | null;
      line_date: string | null;
      description: string | null;
      fee_type: string | null;
      net_amount: number | null;
      net_amount_usd: number | null;
      fee_group: string | null;
      fee_category: string | null;
    }>,
  );

  let feeUsd = 0;
  let adFeeUsd = 0;
  let subscriptionFeeUsd = 0;
  for (const r of rows) {
    const usd = Number(r.net_amount_usd ?? r.net_amount ?? 0);
    const isFeeGroup =
      (r.fee_group != null && FEE_GROUPS.has(r.fee_group)) || (r.fee_type != null && FEE_TYPES_RAW.has(r.fee_type));
    if (isFeeGroup) {
      feeUsd += usd;
    } else if (r.fee_category === "ad_fee") {
      adFeeUsd += usd;
    } else if (r.fee_group === SUBSCRIPTION_FEE_GROUP) {
      subscriptionFeeUsd += usd;
    }
  }
  return { feeUsd, adFeeUsd, subscriptionFeeUsd };
}

interface DomesticTotals {
  salesJpy: number;
  feeJpy: number;
}

/** 登録済み売上データ(sales)から、指定した販売プラットフォーム(メルカリ・ヤフーフリマ)の
 *  邦プラットフォーム販売価格・邦プラットフォーム手数料を月次合計する。 */
async function computeDomesticTotals(
  platform: string,
  monthStart: string,
  monthEnd: string,
): Promise<DomesticTotals> {
  const { data, error } = await supabase
    .from("sales")
    .select("jp_platform_price, jp_platform_fee")
    .eq("sales_platform", platform)
    .gte("sale_date", monthStart)
    .lte("sale_date", monthEnd);
  if (error) throw error;

  let salesJpy = 0;
  let feeJpy = 0;
  for (const r of data ?? []) {
    salesJpy += Number(r.jp_platform_price ?? 0);
    feeJpy += Number(r.jp_platform_fee ?? 0);
  }
  return { salesJpy, feeJpy };
}

/**
 * 2026-09-10追加(ユーザー指示): 「利益管理票更新用データの作成」と同じ形式で、作成した
 * 当該月分のデータを画面上に一覧表示するための行データ。テンプレートの各行(I/J/K列)に対応する。
 */
export interface FreeeTemplateRowValues {
  platform: string;
  account: string | null;
  /** I列(売上高、円) */
  salesJpy: number;
  /** J列(販売手数料、円) */
  feeJpy: number;
  /** K列(広告宣伝費、円)。メルカリ・ヤフーフリマ行(K列自体が無い)はnull。 */
  adFeeJpy: number | null;
  /** L列(通信費、円。Subscription and onetime fees、税区分は不課税)。eBay行以外はnull。 */
  subscriptionFeeJpy: number | null;
}

export interface FreeeTemplateResult {
  buffer: ArrayBuffer;
  fileName: string;
  warnings: string[];
  rows: FreeeTemplateRowValues[];
}

export async function buildFreeeTemplateWorkbook(yearMonth: string): Promise<FreeeTemplateResult> {
  const warnings: string[] = [];
  const [y, m] = yearMonth.split("-").map(Number);
  const monthStart = `${yearMonth}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const monthEnd = `${yearMonth}-${String(lastDay).padStart(2, "0")}`;

  const rates = await fetchMonthlyExchangeRates();
  const ttmRate = rates[yearMonth] ?? null;
  if (ttmRate == null) {
    warnings.push(
      `${yearMonth}の月末TTMレートが「月次為替レート」に未登録のため、eBay関連(I2〜K3)は0円のまま出力しました。データ作成タブ上部でレートを保存してから再実行してください。`,
    );
  }
  const rate = ttmRate ?? 0;

  const [soulcameraGrossUsd, soulmenjapanGrossUsd] = await Promise.all([
    computeTransactionReportGrossUsd("soulcamera", monthStart, monthEnd),
    computeTransactionReportGrossUsd("soulmenjapan", monthStart, monthEnd),
  ]);
  const [soulcameraFees, soulmenjapanFees] = await Promise.all([
    computeTaxInvoiceFeeTotals("soulcamera", monthStart, monthEnd),
    computeTaxInvoiceFeeTotals("soulmenjapan", monthStart, monthEnd),
  ]);
  const [mercari, yafuma] = await Promise.all([
    computeDomesticTotals("メルカリ", monthStart, monthEnd),
    computeDomesticTotals("ヤフーフリマ", monthStart, monthEnd),
  ]);

  const res = await fetch(TEMPLATE_URL);
  if (!res.ok) throw new Error("テンプレートファイル(freee_torihiki_template.xlsx)の読み込みに失敗しました");
  const templateBuffer = await res.arrayBuffer();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(templateBuffer);
  const ws = workbook.getWorksheet(TEMPLATE_SHEET_NAME);
  if (!ws) throw new Error(`テンプレートにシート「${TEMPLATE_SHEET_NAME}」が見つかりません`);

  const yyyymm = y * 100 + m;
  const yyyymmdd = y * 10000 + m * 100 + lastDay;
  for (const row of [2, 3, 4, 5]) {
    ws.getCell(`C${row}`).value = yyyymm;
    ws.getCell(`F${row}`).value = yyyymmdd;
  }

  // L列(通信費)はテンプレートに元々無い新設列(2026-09-12追加、ユーザー指示)。freee側の
  // 取引テンプレート設定で、この列見出し「通信費」を勘定科目「通信費」・税区分「不課税」として
  // マッピング登録する必要がある(このExcel出力だけでは完結しない)。
  ws.getCell("L1").value = "通信費";

  ws.getCell("I2").value = Math.round(soulcameraGrossUsd * rate);
  ws.getCell("J2").value = Math.round(soulcameraFees.feeUsd * rate);
  ws.getCell("K2").value = Math.round(soulcameraFees.adFeeUsd * rate);
  ws.getCell("L2").value = Math.round(soulcameraFees.subscriptionFeeUsd * rate);

  ws.getCell("I3").value = Math.round(soulmenjapanGrossUsd * rate);
  ws.getCell("J3").value = Math.round(soulmenjapanFees.feeUsd * rate);
  ws.getCell("K3").value = Math.round(soulmenjapanFees.adFeeUsd * rate);
  ws.getCell("L3").value = Math.round(soulmenjapanFees.subscriptionFeeUsd * rate);

  ws.getCell("I4").value = Math.round(mercari.salesJpy);
  ws.getCell("J4").value = Math.round(mercari.feeJpy);

  ws.getCell("I5").value = Math.round(yafuma.salesJpy);
  ws.getCell("J5").value = Math.round(yafuma.feeJpy);

  const rows: FreeeTemplateRowValues[] = [
    {
      platform: "eBay",
      account: "Soulcamera",
      salesJpy: Math.round(soulcameraGrossUsd * rate),
      feeJpy: Math.round(soulcameraFees.feeUsd * rate),
      adFeeJpy: Math.round(soulcameraFees.adFeeUsd * rate),
      subscriptionFeeJpy: Math.round(soulcameraFees.subscriptionFeeUsd * rate),
    },
    {
      platform: "eBay",
      account: "Soulmenjapan",
      salesJpy: Math.round(soulmenjapanGrossUsd * rate),
      feeJpy: Math.round(soulmenjapanFees.feeUsd * rate),
      adFeeJpy: Math.round(soulmenjapanFees.adFeeUsd * rate),
      subscriptionFeeJpy: Math.round(soulmenjapanFees.subscriptionFeeUsd * rate),
    },
    {
      platform: "メルカリ",
      account: null,
      salesJpy: Math.round(mercari.salesJpy),
      feeJpy: Math.round(mercari.feeJpy),
      adFeeJpy: null,
      subscriptionFeeJpy: null,
    },
    {
      platform: "ヤフーフリマ",
      account: null,
      salesJpy: Math.round(yafuma.salesJpy),
      feeJpy: Math.round(yafuma.feeJpy),
      adFeeJpy: null,
      subscriptionFeeJpy: null,
    },
  ];

  const buffer = await workbook.xlsx.writeBuffer();
  return {
    buffer: buffer as ArrayBuffer,
    fileName: `Freee取引テンプレート用データ${yearMonth.replace("-", "")}.xlsx`,
    warnings,
    rows,
  };
}
