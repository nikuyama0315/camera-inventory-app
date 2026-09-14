import { supabase } from "../supabaseClient";
import { triggerDriveFolderMove } from "./driveFolderMove";

export interface Sale {
  id: string;
  item_id: string;
  sale_date: string;
  sale_item_title: string | null;
  tracking_info: string | null;
  /** 販売プラットフォーム(メルカリ・ヤフーフリマ等)。2026-09-10追加。従来tracking_infoに入っていた
   *  プラットフォーム名を転記したもの(tracking_info自体は変更していない)。 */
  sales_platform: string | null;
  jp_platform_price: number;
  jp_platform_fee: number;
  jp_platform_shipping_collected: number;
  shipping_cost_paid: number;
  ebay_price_usd: number;
  ebay_shipping_collected_usd: number;
  ebay_handling_fee_usd: number;
  ebay_ad_fee_usd: number;
  ebay_transaction_line_id: string | null;
  /** eBayアカウント区分(soulcamera/soulmenjapan/other)。未設定はnull。 */
  account: string | null;
  /** 「仕入・販売帳」エクセルのSales #列(eBayのSales Record Number等の別ID)。management_noとは別物。 */
  sales_record_reference: string | null;
  exchange_rate: number;
  purchase_price_snapshot: number;
  jp_platform_subtotal: number;
  ebay_fee_usd_total: number;
  usd_subtotal: number;
  usd_subtotal_jpy: number;
  total_jpy: number;
  gross_profit_jpy: number;
  year_month: string;
  created_at: string;
}

export interface SaleWithItem extends Sale {
  items: { management_no: string; title: string | null } | null;
}

export interface CreateSaleInput {
  item_id: string;
  sale_date: string;
  sale_item_title?: string;
  tracking_info?: string;
  sales_platform?: string;
  jp_platform_price?: number;
  jp_platform_fee?: number;
  jp_platform_shipping_collected?: number;
  shipping_cost_paid?: number;
  ebay_price_usd?: number;
  ebay_shipping_collected_usd?: number;
  ebay_handling_fee_usd?: number;
  ebay_ad_fee_usd?: number;
  /** eBay自動取得(ebay-sync-orders)のレビューキューから登録した場合、元明細のIDを紐付ける */
  ebay_transaction_line_id?: string;
  /** eBayアカウント区分(soulcamera/soulmenjapan/other)。未指定はnullとして保存する。 */
  account?: string | null;
  /** 「仕入・販売帳」エクセル取込のSales #列の値。items.management_noとは独立して保持する。 */
  sales_record_reference?: string | null;
  exchange_rate: number;
}

export interface ItemForSale {
  id: string;
  management_no: string;
  title: string | null;
  purchase_price: number;
}

/** 管理番号(Custom label)の部分一致で商品を検索し、仕入高も併せて取得する */
export async function searchItemsForSale(fragment: string): Promise<ItemForSale[]> {
  const trimmed = fragment.trim();
  if (!trimmed) return [];

  const { data, error } = await supabase
    .from("items")
    .select("id, management_no, title, purchases(purchase_price)")
    .ilike("management_no", `%${trimmed}%`)
    .order("management_no", { ascending: false })
    .limit(20);

  if (error) throw error;

  return (data as unknown as Array<{
    id: string;
    management_no: string;
    title: string | null;
    purchases: { purchase_price: number } | { purchase_price: number }[] | null;
  }>).map((row) => {
    const purchase = Array.isArray(row.purchases) ? row.purchases[0] : row.purchases;
    return {
      id: row.id,
      management_no: row.management_no,
      title: row.title,
      purchase_price: purchase?.purchase_price ?? 0,
    };
  });
}

type ItemForSaleRow = {
  id: string;
  management_no: string;
  title: string | null;
  purchases: { purchase_price: number } | { purchase_price: number }[] | null;
};

function mapItemForSaleRows(rows: ItemForSaleRow[]): ItemForSale[] {
  return rows.map((row) => {
    const purchase = Array.isArray(row.purchases) ? row.purchases[0] : row.purchases;
    return {
      id: row.id,
      management_no: row.management_no,
      title: row.title,
      purchase_price: purchase?.purchase_price ?? 0,
    };
  });
}

/**
 * eBayのSKU(Custom Label)から、対応するitems.management_noの候補文字列を推測する(2026-09-04追加)。
 * 現行の自動突合(eBay側同期処理)はcustom_labelの先頭9文字とmanagement_noの完全一致でしか突合しないが、
 * 現在出品中の商品の多くはSKUが旧形式「YYYYMMDD-NN ...」(西暦4桁)のままで、management_noは
 * 「YYMMDD-NN」(西暦2桁・ちょうど9文字)に統一されているため、先頭9文字を取るとハイフンの位置が
 * ズレて絶対に一致しない(単なる入力ミスではなく形式そのものが違う構造的な不一致)。
 * ここでは西暦4桁の先頭「20」を除去する等、実際に観測されたズレのパターンを補正した候補を作る。
 */
function deriveManagementNoCandidates(customLabel: string): string[] {
  const trimmed = customLabel.trim();
  const candidates = new Set<string>();

  const m8 = trimmed.match(/^(\d{8})-(\d{1,4})/);
  if (m8) {
    const [, date8, seq] = m8;
    if (date8.startsWith("20")) {
      candidates.add(`${date8.slice(2)}-${seq.padStart(2, "0")}`);
    }
  }

  const m6 = trimmed.match(/^(\d{6})-(\d{1,4})/);
  if (m6) {
    const [, date6, seq] = m6;
    candidates.add(`${date6}-${seq.padStart(2, "0")}`);
  }

  return Array.from(candidates);
}

/**
 * eBay受注レビューキューで自動突合できなかった行に対し、その行のeBay SKU(custom_label)から
 * management_noの候補を推測して再検索する「SKU再照合」機能(2026-09-04追加)。
 * まず推測した候補文字列との完全一致を試し、無ければ候補文字列を含む緩い部分一致にフォールバックする。
 * 候補が見つかっても自動では紐付けず、既存の検索結果と同様にユーザーがクリックして確認・紐付けする。
 */
export async function searchItemsByCustomLabel(customLabel: string | null): Promise<ItemForSale[]> {
  if (!customLabel) return [];
  const candidates = deriveManagementNoCandidates(customLabel);
  if (candidates.length === 0) return [];

  const { data: exact, error: exactError } = await supabase
    .from("items")
    .select("id, management_no, title, purchases(purchase_price)")
    .in("management_no", candidates);
  if (exactError) throw exactError;
  if (exact && exact.length > 0) {
    return mapItemForSaleRows(exact as unknown as ItemForSaleRow[]);
  }

  const orFilter = candidates.map((c) => `management_no.ilike.%${c}%`).join(",");
  const { data: loose, error: looseError } = await supabase
    .from("items")
    .select("id, management_no, title, purchases(purchase_price)")
    .or(orFilter)
    .order("management_no", { ascending: false })
    .limit(10);
  if (looseError) throw looseError;
  return mapItemForSaleRows((loose ?? []) as unknown as ItemForSaleRow[]);
}

/** eBay自動取得のレビューキューから「フォームに反映」する際、商品1件分をIDで取得する(仕入高も併せて取得) */
export async function fetchItemForSaleById(itemId: string): Promise<ItemForSale | null> {
  const { data, error } = await supabase
    .from("items")
    .select("id, management_no, title, purchases(purchase_price)")
    .eq("id", itemId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as unknown as {
    id: string;
    management_no: string;
    title: string | null;
    purchases: { purchase_price: number } | { purchase_price: number }[] | null;
  };
  const purchase = Array.isArray(row.purchases) ? row.purchases[0] : row.purchases;
  return {
    id: row.id,
    management_no: row.management_no,
    title: row.title,
    purchase_price: purchase?.purchase_price ?? 0,
  };
}

/** 仕入高は登録時点のスナップショットとして保存する(後日仕入高を編集しても過去の粗利は変わらない) */
export async function createSale(input: CreateSaleInput, purchasePriceSnapshot: number): Promise<Sale> {
  const { data, error } = await supabase
    .from("sales")
    .insert({
      item_id: input.item_id,
      sale_date: input.sale_date,
      sale_item_title: input.sale_item_title ?? null,
      tracking_info: input.tracking_info ?? null,
      sales_platform: input.sales_platform ?? null,
      jp_platform_price: input.jp_platform_price ?? 0,
      jp_platform_fee: input.jp_platform_fee ?? 0,
      jp_platform_shipping_collected: input.jp_platform_shipping_collected ?? 0,
      shipping_cost_paid: input.shipping_cost_paid ?? 0,
      ebay_price_usd: input.ebay_price_usd ?? 0,
      ebay_shipping_collected_usd: input.ebay_shipping_collected_usd ?? 0,
      ebay_handling_fee_usd: input.ebay_handling_fee_usd ?? 0,
      ebay_ad_fee_usd: input.ebay_ad_fee_usd ?? 0,
      ebay_transaction_line_id: input.ebay_transaction_line_id ?? null,
      account: input.account ?? null,
      sales_record_reference: input.sales_record_reference ?? null,
      exchange_rate: input.exchange_rate,
      purchase_price_snapshot: purchasePriceSnapshot,
    })
    .select()
    .single();

  if (error) throw error;

  // 2026-09-04追加: 売上登録と同時に、対象商品(items.status)を自動的に「販売済み」(sold)に更新する。
  // 従来はcreateSale()がitems.statusを一切更新しない設計だったため、運用者が売上登録のたびに別途
  // 手動で「ステータス(修正用)」プルダウンから「販売済み」に変更する必要があった(手動運用に依存した
  // 整合性。実データ確認時点ではstatus='sold'663件と売上レコード有り663件が完全一致していたが、
  // これは徹底された手動運用の結果であり、仕組みによる保証ではなかった)。
  // ここでのステータス更新・Google Driveフォルダ移動(sold用フォルダへの移動)が失敗しても、既に
  // 登録済みの売上レコードを失敗扱いにして再登録(=売上の二重登録)を誘発しないよう、エラーは
  // console.warnに留め、createSale自体は成功として扱う(triggerDriveFolderMove自体が元々持つ
  // 「ベストエフォート・エラーを外に投げない」方針と揃えた)。
  try {
    const { data: updatedItem, error: statusError } = await supabase
      .from("items")
      .update({ status: "sold" })
      .eq("id", input.item_id)
      .select("management_no")
      .single();
    if (statusError) throw statusError;
    await triggerDriveFolderMove(input.item_id);

    // 2026-09-15追加: his50s.com(Japan Retro Camera Wholesale)にも同じ商品が出品されている場合、
    // 「売れた」をAPI通知し先方の在庫を減らす(保留中の見積があれば自動declineされる)。他プラット
    // フォーム(eBay/メルカリ等)経由の売上も含め、当アプリで販売済みになった時点で必ず呼ぶ。
    // his50sに出品していない商品がほとんどのため、not_listed応答は正常系(エラーではない)。
    if (updatedItem?.management_no) {
      supabase.functions
        .invoke("notify-his50s-sold", {
          body: { managementNo: updatedItem.management_no, saleId: data.id },
        })
        .then(({ error: notifyError }) => {
          if (notifyError) {
            // eslint-disable-next-line no-console
            console.warn("his50sへの「売れた」通知に失敗しました(売上自体は登録済みです):", notifyError);
          }
        })
        .catch((notifyErr) => {
          // eslint-disable-next-line no-console
          console.warn("his50sへの「売れた」通知に失敗しました(売上自体は登録済みです):", notifyErr);
        });
    }
  } catch (statusErr) {
    // eslint-disable-next-line no-console
    console.warn("売上登録後の商品ステータス自動更新に失敗しました(売上自体は登録済みです):", statusErr);
  }

  return data as Sale;
}

export async function deleteSale(id: string): Promise<void> {
  const { error } = await supabase.from("sales").delete().eq("id", id);
  if (error) throw error;
}

export interface UpdateSaleInput {
  item_id?: string;
  sale_date?: string;
  sale_item_title?: string | null;
  tracking_info?: string | null;
  sales_platform?: string | null;
  jp_platform_price?: number;
  jp_platform_fee?: number;
  jp_platform_shipping_collected?: number;
  shipping_cost_paid?: number;
  ebay_price_usd?: number;
  ebay_shipping_collected_usd?: number;
  ebay_handling_fee_usd?: number;
  ebay_ad_fee_usd?: number;
  /** eBay自動取得のレビューキューから紐付け直す場合のみ指定する(省略時は既存の紐付けを維持する) */
  ebay_transaction_line_id?: string;
  /** eBayアカウント区分(soulcamera/soulmenjapan/other)。nullを指定すると未設定に戻す。 */
  account?: string | null;
  sales_record_reference?: string | null;
  exchange_rate?: number;
  /** 仕入高はあくまで登録時点のスナップショットのため、通常は編集対象にしない想定だが、
   *  誤登録の訂正や商品の紐付け変更に伴う再設定のために更新できるようにしている。 */
  purchase_price_snapshot?: number;
}

/** 売上・粗利タブの一覧から既存の売上を編集する。指定したフィールドのみを部分更新する。 */
export async function updateSale(id: string, patch: UpdateSaleInput): Promise<Sale> {
  const { data, error } = await supabase.from("sales").update(patch).eq("id", id).select().single();
  if (error) throw error;
  return data as Sale;
}

/**
 * 指定した年月(YYYY-MM)の登録済み売上データの為替レートを一括で上書きする。
 * exchange_rateはgenerated column(ドル貨合計円換算・合計・粗利等)の元になっているため、
 * 更新するとそれらも自動的に再計算される。
 */
export async function bulkUpdateExchangeRateForMonth(yearMonth: string, rate: number): Promise<number> {
  const { data, error } = await supabase
    .from("sales")
    .update({ exchange_rate: rate })
    .eq("year_month", `${yearMonth}-01`)
    .select("id");
  if (error) throw error;
  return (data as { id: string }[]).length;
}

export type SalesPeriodType = "all" | "year" | "month";

export interface SalesPeriodFilter {
  type: SalesPeriodType;
  year?: number; // type='year' or 'month'
  month?: number; // 1-12, type='month'の場合の開始月
  // type='month'の場合、終了年月を指定すると複数月にまたがる範囲を絞り込める(未指定なら開始月と同じ=単月)
  toYear?: number;
  toMonth?: number;
}

function lastDayOfMonth(year: number, month: number): string {
  const lastDay = new Date(year, month, 0).getDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

function periodRange(filter: SalesPeriodFilter): { from?: string; to?: string } {
  if (filter.type === "all" || !filter.year) return {};
  if (filter.type === "year") {
    return { from: `${filter.year}-01-01`, to: `${filter.year}-12-31` };
  }
  const month = filter.month ?? 1;
  const from = `${filter.year}-${String(month).padStart(2, "0")}-01`;
  const toYear = filter.toYear ?? filter.year;
  const toMonth = filter.toMonth ?? month;
  const to = lastDayOfMonth(toYear, toMonth);
  return { from, to };
}

export async function fetchSalesList(
  filter: SalesPeriodFilter,
  limit = 200,
  accountFilter?: string,
): Promise<SaleWithItem[]> {
  let query = supabase
    .from("sales")
    .select("*, items(management_no, title)")
    .order("sale_date", { ascending: false })
    .limit(limit);

  const { from, to } = periodRange(filter);
  if (from) query = query.gte("sale_date", from);
  if (to) query = query.lte("sale_date", to);
  if (accountFilter) query = query.eq("account", accountFilter);

  const { data, error } = await query;
  if (error) throw error;
  return data as unknown as SaleWithItem[];
}

export interface SalesSummary {
  jpPlatformRevenue: number; // 17 = jp_platform_price + jp_platform_shipping_collected の合計
  jpPlatformFee: number; // 18
  ebayRevenueJpy: number; // 19 = (ebay_price+ebay_shipping) * rate の合計
  ebayFeeJpy: number; // 20 = ebay_fee_usd_total * rate の合計
  shippingCost: number; // 21
  purchaseCost: number; // 22
  grossProfit: number; // 23
  count: number;
}

interface RawSummaryRow {
  jp_platform_price: number;
  jp_platform_shipping_collected: number;
  jp_platform_fee: number;
  ebay_price_usd: number;
  ebay_shipping_collected_usd: number;
  ebay_fee_usd_total: number;
  exchange_rate: number;
  shipping_cost_paid: number;
  purchase_price_snapshot: number;
  gross_profit_jpy: number;
  year_month: string;
}

function aggregateRows(rows: RawSummaryRow[]): SalesSummary {
  const summary: SalesSummary = {
    jpPlatformRevenue: 0,
    jpPlatformFee: 0,
    ebayRevenueJpy: 0,
    ebayFeeJpy: 0,
    shippingCost: 0,
    purchaseCost: 0,
    grossProfit: 0,
    count: rows.length,
  };

  for (const r of rows) {
    summary.jpPlatformRevenue += r.jp_platform_price + r.jp_platform_shipping_collected;
    summary.jpPlatformFee += r.jp_platform_fee;
    summary.ebayRevenueJpy += (r.ebay_price_usd + r.ebay_shipping_collected_usd) * r.exchange_rate;
    summary.ebayFeeJpy += r.ebay_fee_usd_total * r.exchange_rate;
    summary.shippingCost += r.shipping_cost_paid;
    summary.purchaseCost += r.purchase_price_snapshot;
    summary.grossProfit += r.gross_profit_jpy;
  }

  return summary;
}

async function fetchRawSummaryRows(filter: SalesPeriodFilter, accountFilter?: string): Promise<RawSummaryRow[]> {
  let query = supabase
    .from("sales")
    .select(
      "jp_platform_price, jp_platform_shipping_collected, jp_platform_fee, ebay_price_usd, ebay_shipping_collected_usd, ebay_fee_usd_total, exchange_rate, shipping_cost_paid, purchase_price_snapshot, gross_profit_jpy, year_month",
    );

  const { from, to } = periodRange(filter);
  if (from) query = query.gte("sale_date", from);
  if (to) query = query.lte("sale_date", to);
  if (accountFilter) query = query.eq("account", accountFilter);

  const { data, error } = await query;
  if (error) throw error;
  return data as RawSummaryRow[];
}

export async function fetchSalesSummary(filter: SalesPeriodFilter, accountFilter?: string): Promise<SalesSummary> {
  const rows = await fetchRawSummaryRows(filter, accountFilter);
  return aggregateRows(rows);
}

export interface MonthlySalesSummary extends SalesSummary {
  year_month: string; // YYYY-MM
}

export interface SalesSummaryBreakdown {
  months: MonthlySalesSummary[]; // 対象月ごとの集計(昇順)
  total: SalesSummary; // 期間合計
}

/** 対象期間を月ごとに分けた集計と、期間全体の合計の両方を返す */
export async function fetchSalesSummaryBreakdown(
  filter: SalesPeriodFilter,
  accountFilter?: string,
): Promise<SalesSummaryBreakdown> {
  const rows = await fetchRawSummaryRows(filter, accountFilter);

  const byMonth = new Map<string, RawSummaryRow[]>();
  for (const r of rows) {
    const ym = r.year_month.slice(0, 7);
    const arr = byMonth.get(ym);
    if (arr) arr.push(r);
    else byMonth.set(ym, [r]);
  }

  const months: MonthlySalesSummary[] = Array.from(byMonth.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([year_month, monthRows]) => ({ year_month, ...aggregateRows(monthRows) }));

  return { months, total: aggregateRows(rows) };
}

/**
 * 指定したeBayオーダー番号のリストについて、eBay取引明細(ebay_transaction_lines.order_number)
 * 経由で突合した商品のsales.shipping_cost_paid(送料・クーリエ・日本郵便)を取得する
 * (利益管理票更新用データ作成、2026-09-14追加)。
 * eBayのAPIには依らず、当アプリのDB登録データ(送料登録タブでの登録結果等)のみを参照する。
 * 未突合、または登録額が0円(未登録扱い)の場合はMapにキーを含めない(呼び出し側でブランク表示する)。
 */
export async function fetchShippingCostByOrderNos(orderNos: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (orderNos.length === 0) return result;

  const { data: lines, error: linesError } = await supabase
    .from("ebay_transaction_lines")
    .select("order_number, matched_item_id")
    .in("order_number", orderNos)
    .not("matched_item_id", "is", null);
  if (linesError) throw linesError;

  const itemIdByOrderNo = new Map<string, string>();
  for (const l of lines ?? []) {
    if (l.matched_item_id) itemIdByOrderNo.set(l.order_number, l.matched_item_id);
  }
  const itemIds = Array.from(new Set(itemIdByOrderNo.values()));
  if (itemIds.length === 0) return result;

  const { data: sales, error: salesError } = await supabase
    .from("sales")
    .select("item_id, shipping_cost_paid, created_at")
    .in("item_id", itemIds)
    .order("created_at", { ascending: false });
  if (salesError) throw salesError;

  const shippingByItemId = new Map<string, number>();
  for (const s of sales ?? []) {
    if (!shippingByItemId.has(s.item_id)) {
      shippingByItemId.set(s.item_id, Number(s.shipping_cost_paid));
    }
  }

  for (const [orderNo, itemId] of itemIdByOrderNo) {
    const fee = shippingByItemId.get(itemId);
    if (fee != null && fee > 0) result.set(orderNo, fee);
  }
  return result;
}

