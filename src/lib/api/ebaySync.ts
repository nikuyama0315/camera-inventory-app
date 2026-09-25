import { supabase } from "../supabaseClient";

/**
 * eBay自動取得(Edge Function: ebay-sync-orders)まわりのAPI。
 *
 * 全体の流れ:
 *  1. triggerEbaySync() でeBay Sell APIから直近の受注を取得し、
 *     ebay_transaction_lines / ebay_tax_invoice_lines / platform_settlement_imports に取り込む。
 *     このとき、SKU(Custom Label)から在庫アイテム(items.management_no)への自動突合も試みる
 *     (最初の"-"より前の部分を比較。一意に一致した場合のみ matched_item_id を設定)。
 *  2. fetchEbayReviewQueue() で「まだ売上登録されていない」明細(unmatched/matched_pending)を一覧表示。
 *     自動突合できなかった行は linkEbayTransactionLineToItem() で手動突合できる。
 *  3. 各行を「フォームに反映」すると、既存の手動売上登録フォーム(SalesPage)に値がプリフィルされる。
 *     ユーザーが内容を確認・修正のうえ「登録する」を押すと初めてsalesテーブルに保存される
     (このハお挤は自動で在庫登録しない)。 *  4. 登録が完了したら markEbayTransactionLineRegistered() でレビューキューから外す。
 *  5. 対象外の受注は ignoreEbayTransactionLine() でレビューキューから除外できる。
 */

export type EbayMatchStatus = "unmatched" | "matched_pending" | "registered" | "ignored";

/**
 * 2026-09-06: some ebay_tax_invoice_lines import batches contain exact-duplicate rows for the
 * same order/item (found for management_no 260215-03, order 08-14888-38737, import_id
 * fff70b88-f4dd-400e-bdf8-ea9c0b272aae: 4 rows stored as 8; 56/808 rows duplicated in that
 * import). Summing raw rows doubles ad_fee/transaction_fee totals. Dedupe by full row identity
 * before summing (order+item+date+description+fee_type+amount) - legitimate duplicate charges
 * with identical values are effectively never expected for the same order/item.
 */
export function dedupeTaxInvoiceRows<
  T extends {
    order_number: string | null;
    item_number: string | null;
    line_date: string | null;
    description: string | null;
    fee_type: string | null;
    net_amount: number | null;
    net_amount_usd: number | null;
  },
>(rows: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const r of rows) {
    const key = [r.order_number, r.item_number, r.line_date, r.description, r.fee_type, r.net_amount, r.net_amount_usd]
      .map((v) => v ?? "")
      .join("::");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(r);
  }
  return result;
}

export interface EbayReviewRow {
  id: string;
  transaction_date: string;
  order_number: string | null;
  item_id: string | null;
  custom_label: string | null;
  item_title: string | null;
  item_subtotal: number;
  shipping_and_handling: number;
  final_value_fee: number;
  international_fee: number;
  transaction_currency: string;
  exchange_rate: number;
  net_amount: number;
  matched_item_id: string | null;
  match_status: EbayMatchStatus;
  matched_item: { id: string; management_no: string; title: string | null } | null;
  /** この明細が属する同期・取込のeBayアカウント区分(platform_settlement_imports.ebay_account経由)。 */
  account: string | null;
  /** ebay_tax_invoice_lines(fee_category='ad_fee')から集計した広告料(USD換算済み) */
  ad_fee_usd: number;
  /**
   * 【2026-09-06追加】取引手数料(Transaction fees、広告料を除く)。ebay_tax_invoice_linesに
   * その注文・商品のTax Invoice行(fee_category != 'ad_fee')が既に取り込まれていればその合計
   * (USD換算済み、FINAL_VALUE_FEE_FIXED_PER_ORDER等も含む正確な値)を優先し、まだ取り込まれて
   * いない(直近すぎる注文でTax Invoice未取込)場合のみ final_value_fee + international_fee を
   * USD換算した値にフォールバックする。fetchTransactionFeeForOrderItem()のロジックと同一。
   */
  transaction_fee_usd: number;
  /** eBayの"Sales Record Number"(注文単位の連番、Seller Hub上の表示に対応) */
  sales_record_reference: string | null;
  /** バイヤー居住国(ISO国コード、taxAddress優先・無ければ登録住所) */
  buyer_country: string | null;
  /** CPaSS取込済みの追跡番号(cpass_shipments.tracking_number、order_number+item_idで突合) */
  cpass_tracking_number: string | null;
  /** CPaSS取込済みの配送業者(例: "Orange Connex (Japan) – FedEx") */
  cpass_shipping_carrier: string | null;
  /** CPaSS取込済みの送料(現状のCPaSSエクスポートには送料列が無いため、取込元が無い限り常にnull) */
  cpass_shipping_fee: number | null;
  cpass_shipping_fee_currency: string | null;
  /**
   * 【2026-09-04追加】eBay Sell Fulfillment APIから同期時に自動取得した追跡番号(ebay_transaction_lines.
   * tracking_number)。CPaSS/eLogiのファイルを手動で取り込まなくても、発送済み注文であればここに
   * 自動で入る(eLogiで発送した注文で、eBay記録上の追跡番号がelogi_shipments取込済みの値と完全一致する
   * ことを実データで確認済み)。送料はeBay側の情報に含まれないため取得できない。
   */
  api_tracking_number: string | null;
  api_shipping_carrier: string | null;
  api_shipped_date: string | null;
  /** eLogi(海外発送代行サービス)の「発送済一覧」CSV取込済みの追跡番号(elogi_shipments.tracking_number、order_number単位で突合。eLogiのCSVには明細単位のitem_idが無いため注文内の全明細に同じ値を適用する) */
  elogi_tracking_number: string | null;
  /** eLogi取込済みの送料(初回請求+追加請求/返金の合計、円建て) */
  elogi_shipping_fee: number | null;
  /**
   * 追跡番号の表示用の最終値: eBay API取得値を最優先し、無ければCPaSS→eLogiの順にフォールバックする。
   * どの経路で埋まったかは resolved_tracking_source で分かる。
   */
  resolved_tracking_number: string | null;
  resolved_tracking_source: "ebay" | "cpass" | "elogi" | null;
  /**
   * 送料の表示用の最終値。eBay側の情報には送料が含まれないため、CPaSS(手入力含む)→eLogiの順に
   * フォールバックする。通貨はCPaSSは手入力時の通貨、eLogiは常に円(JPY)。
   */
  resolved_shipping_fee: number | null;
  resolved_shipping_fee_currency: string | null;
  resolved_shipping_fee_source: "cpass" | "elogi" | null;
}

export interface EbaySyncResult {
  importId: string;
  shopId: string;
  periodStart: string;
  periodEnd: string;
  ordersFetched: number;
  lineItemsSynced: number;
  matchedCount: number;
  unmatchedCount: number;
}

/** eBay Sell APIから直近の受注を取得し、DBに同期する(Edge Function呼び出し)。shopIdは'soulcamera'/'soulmenjapan'。 */
export async function triggerEbaySync(shopId: "soulcamera" | "soulmenjapan", sinceDays = 90): Promise<EbaySyncResult> {
  const { data, error } = await supabase.functions.invoke("ebay-sync-orders", {
    body: { shopId, sinceDays },
  });
  if (error) throw error;
  if (data && typeof data === "object" && "error" in data && data.error) {
    throw new Error(String((data as { error: unknown }).error));
  }
  return data as EbaySyncResult;
}

/** 未登録(unmatched/matched_pending)のeBay取引明細をレビューキューとして取得する */
export async function fetchEbayReviewQueue(): Promise<EbayReviewRow[]> {
  const { data, error } = await supabase
    .from("ebay_transaction_lines")
    .select(
      "id, transaction_date, order_number, item_id, custom_label, item_title, item_subtotal, " +
        "shipping_and_handling, final_value_fee, international_fee, transaction_currency, exchange_rate, " +
        "net_amount, matched_item_id, match_status, sales_record_reference, buyer_country, " +
        "tracking_number, shipping_carrier, shipped_date, " +
        "matched_item:matched_item_id(id, management_no, title), " +
        "platform_settlement_imports(ebay_account)",
    )
    .in("match_status", ["unmatched", "matched_pending"])
    .order("transaction_date", { ascending: false })
    .limit(100);
  if (error) throw error;

  const rows = (data ?? []) as unknown as Array<{
    id: string;
    transaction_date: string;
    order_number: string | null;
    item_id: string | null;
    custom_label: string | null;
    item_title: string | null;
    item_subtotal: number | null;
    shipping_and_handling: number | null;
    final_value_fee: number | null;
    international_fee: number | null;
    transaction_currency: string;
    exchange_rate: number | null;
    net_amount: number | null;
    matched_item_id: string | null;
    match_status: EbayMatchStatus;
    sales_record_reference: string | null;
    buyer_country: string | null;
    tracking_number: string | null;
    shipping_carrier: string | null;
    shipped_date: string | null;
    matched_item:
      | { id: string; management_no: string; title: string | null }
      | { id: string; management_no: string; title: string | null }[]
      | null;
    platform_settlement_imports: { ebay_account: string | null } | { ebay_account: string | null }[] | null;
  }>;

  if (rows.length === 0) return [];

  // 2026-09-04追加: 売上登録(createSale)が成功した直後にmarkEbayTransactionLineRegistered()の
  // 呼び出しが何らかの理由(通信エラー等)で失敗すると、salesテーブルには登録済みなのにmatch_statusが
  // matched_pending/unmatchedのまま残り、レビュー一覧に「未登録」として表示され続けてしまう不具合が
  // 実データで複数件確認された。再度「登録する」を押すとebay_transaction_line_idのUNIQUE制約に
  // 違反して失敗し(しかもエラー内容が画面に出ない別バグと重なり)ユーザーを混乱させていた。
  // ここで、既にsalesテーブルに紐付くレコードが存在する行は防御的に一覧から除外し、あわせて
  // match_statusを'registered'へ自己修復しておく(ベストエフォート、失敗しても表示上は除外済み)。
  const lineIds = rows.map((r) => r.id);
  const { data: linkedSales } = await supabase
    .from("sales")
    .select("ebay_transaction_line_id")
    .in("ebay_transaction_line_id", lineIds);
  const alreadyRegisteredIds = new Set(
    ((linkedSales ?? []) as Array<{ ebay_transaction_line_id: string | null }>)
      .map((s) => s.ebay_transaction_line_id)
      .filter((v): v is string => !!v),
  );
  if (alreadyRegisteredIds.size > 0) {
    void supabase
      .from("ebay_transaction_lines")
      .update({ match_status: "registered", matched_at: new Date().toISOString() })
      .in("id", Array.from(alreadyRegisteredIds))
      .then(() => {});
  }

  const orderNumbers = Array.from(new Set(rows.map((r) => r.order_number).filter((v): v is string => !!v)));
  const adFeeByKey = new Map<string, number>();
  if (orderNumbers.length > 0) {
    const { data: taxRowsRaw } = await supabase
      .from("ebay_tax_invoice_lines")
      .select("order_number, item_number, line_date, description, fee_type, net_amount, net_amount_usd")
      .eq("fee_category", "ad_fee")
      .in("order_number", orderNumbers);
    const taxRows = dedupeTaxInvoiceRows((taxRowsRaw ?? []) as Array<{
      order_number: string | null;
      item_number: string | null;
      line_date: string | null;
      description: string | null;
      fee_type: string | null;
      net_amount: number | null;
      net_amount_usd: number | null;
    }>);
    for (const t of taxRows) {
      const key = `${t.order_number ?? ""}::${t.item_number ?? ""}`;
      adFeeByKey.set(key, (adFeeByKey.get(key) ?? 0) + Number(t.net_amount_usd ?? 0));
    }
  }

  // 【2026-09-06追加】広告料以外の取引手数料(Transaction fees)。ad_fee以外のfee_categoryを合算する。
  const txFeeByKey = new Map<string, number>();
  if (orderNumbers.length > 0) {
    const { data: txRowsRaw } = await supabase
      .from("ebay_tax_invoice_lines")
      .select("order_number, item_number, line_date, description, fee_type, net_amount, net_amount_usd")
      .neq("fee_category", "ad_fee")
      .in("order_number", orderNumbers);
    const txRows = dedupeTaxInvoiceRows((txRowsRaw ?? []) as Array<{
      order_number: string | null;
      item_number: string | null;
      line_date: string | null;
      description: string | null;
      fee_type: string | null;
      net_amount: number | null;
      net_amount_usd: number | null;
    }>);
    for (const t of txRows) {
      const key = `${t.order_number ?? ""}::${t.item_number ?? ""}`;
      txFeeByKey.set(key, (txFeeByKey.get(key) ?? 0) + Number(t.net_amount_usd ?? 0));
    }
  }

  const cpassByKey = new Map<
    string,
    { tracking_number: string | null; shipping_carrier: string | null; shipping_fee: number | null; shipping_fee_currency: string | null }
  >();
  if (orderNumbers.length > 0) {
    const { data: cpassRows } = await supabase
      .from("cpass_shipments")
      .select("order_number, item_id, tracking_number, shipping_carrier, shipping_fee, shipping_fee_currency")
      .in("order_number", orderNumbers);
    for (const c of (cpassRows ?? []) as Array<{
      order_number: string | null;
      item_id: string | null;
      tracking_number: string | null;
      shipping_carrier: string | null;
      shipping_fee: number | null;
      shipping_fee_currency: string | null;
    }>) {
      const key = `${c.order_number ?? ""}::${c.item_id ?? ""}`;
      cpassByKey.set(key, {
        tracking_number: c.tracking_number,
        shipping_carrier: c.shipping_carrier,
        shipping_fee: c.shipping_fee,
        shipping_fee_currency: c.shipping_fee_currency,
      });
    }
  }

  // eLogi(海外発送代行サービス)の「発送済一覧」CSV取込済みデータ(2026-09-04追加)。
  // elogi_shipmentsは経費(expenses)側の会計記録用に注文番号(ebay_order_number)単位でのみ持っており、
  // CPaSSと違って明細単位のitem_idが無い。そのため注文番号だけで突合し、同一注文の全明細に同じ値を適用する。
  const elogiByOrder = new Map<string, { tracking_number: string | null; total_amount: number | null }>();
  if (orderNumbers.length > 0) {
    const { data: elogiRows } = await supabase
      .from("elogi_shipments")
      .select("ebay_order_number, tracking_number, initial_amount, additional_amount, total_amount")
      .in("ebay_order_number", orderNumbers);
    for (const e of (elogiRows ?? []) as Array<{
      ebay_order_number: string | null;
      tracking_number: string | null;
      initial_amount: number | null;
      additional_amount: number | null;
      total_amount: number | null;
    }>) {
      if (!e.ebay_order_number) continue;
      const total = e.total_amount ?? Number(e.initial_amount ?? 0) + Number(e.additional_amount ?? 0);
      elogiByOrder.set(e.ebay_order_number, { tracking_number: e.tracking_number, total_amount: total });
    }
  }

  return rows.filter((r) => !alreadyRegisteredIds.has(r.id)).map((r) => {
    const matched = Array.isArray(r.matched_item) ? r.matched_item[0] ?? null : r.matched_item;
    const importRow = Array.isArray(r.platform_settlement_imports)
      ? r.platform_settlement_imports[0] ?? null
      : r.platform_settlement_imports;
    const key = `${r.order_number ?? ""}::${r.item_id ?? ""}`;
    const cpass = cpassByKey.get(key);
    const elogi = r.order_number ? elogiByOrder.get(r.order_number) : undefined;

    // 取引手数料(Transaction fees): Tax Invoice側の実額(USD換算済み)があれば優先、無ければ
    // final_value_fee + international_fee をUSD換算した値にフォールバックする。
    const localTxFeeFallback = Number(r.final_value_fee ?? 0) + Number(r.international_fee ?? 0);
    const usdTxFeeFallback =
      r.transaction_currency === "USD" ? localTxFeeFallback : localTxFeeFallback * Number(r.exchange_rate ?? 1);
    const txFeeFromInvoice = txFeeByKey.get(key) ?? 0;
    const transactionFeeUsd = Math.round((txFeeFromInvoice > 0 ? txFeeFromInvoice : usdTxFeeFallback) * 100) / 100;

    // 追跡番号: eBay API自動取得値を最優先、無ければCPaSS→eLogiの順にフォールバックする。
    const resolvedTrackingNumber = r.tracking_number ?? cpass?.tracking_number ?? elogi?.tracking_number ?? null;
    const resolvedTrackingSource: EbayReviewRow["resolved_tracking_source"] = r.tracking_number
      ? "ebay"
      : cpass?.tracking_number
      ? "cpass"
      : elogi?.tracking_number
      ? "elogi"
      : null;

    // 送料: eBay側の情報には含まれないため、CPaSS(手入力含む)→eLogiの順にフォールバックする。
    const resolvedShippingFee = cpass?.shipping_fee ?? elogi?.total_amount ?? null;
    const resolvedShippingFeeCurrency = cpass?.shipping_fee != null ? cpass?.shipping_fee_currency ?? null : elogi?.total_amount != null ? "JPY" : null;
    const resolvedShippingFeeSource: EbayReviewRow["resolved_shipping_fee_source"] = cpass?.shipping_fee != null
      ? "cpass"
      : elogi?.total_amount != null
      ? "elogi"
      : null;

    return {
      id: r.id,
      account: importRow?.ebay_account ?? null,
      transaction_date: r.transaction_date,
      order_number: r.order_number,
      item_id: r.item_id,
      custom_label: r.custom_label,
      item_title: r.item_title,
      item_subtotal: Number(r.item_subtotal ?? 0),
      shipping_and_handling: Number(r.shipping_and_handling ?? 0),
      final_value_fee: Number(r.final_value_fee ?? 0),
      international_fee: Number(r.international_fee ?? 0),
      transaction_currency: r.transaction_currency,
      exchange_rate: Number(r.exchange_rate ?? 1),
      net_amount: Number(r.net_amount ?? 0),
      matched_item_id: r.matched_item_id,
      match_status: r.match_status,
      matched_item: matched,
      ad_fee_usd: adFeeByKey.get(key) ?? 0,
      transaction_fee_usd: transactionFeeUsd,
      sales_record_reference: r.sales_record_reference,
      buyer_country: r.buyer_country,
      cpass_tracking_number: cpass?.tracking_number ?? null,
      cpass_shipping_carrier: cpass?.shipping_carrier ?? null,
      cpass_shipping_fee: cpass?.shipping_fee ?? null,
      cpass_shipping_fee_currency: cpass?.shipping_fee_currency ?? null,
      api_tracking_number: r.tracking_number,
      api_shipping_carrier: r.shipping_carrier,
      api_shipped_date: r.shipped_date,
      elogi_tracking_number: elogi?.tracking_number ?? null,
      elogi_shipping_fee: elogi?.total_amount ?? null,
      resolved_tracking_number: resolvedTrackingNumber,
      resolved_tracking_source: resolvedTrackingSource,
      resolved_shipping_fee: resolvedShippingFee,
      resolved_shipping_fee_currency: resolvedShippingFeeCurrency,
      resolved_shipping_fee_source: resolvedShippingFeeSource,
    };
  });
}

/** ローカル通貨建ての金額をUSDに変換する(USDならそのまま、それ以外はexchange_rateを掛ける) */
export function ebayRowToUsd(row: EbayReviewRow, localValue: number): number {
  // 2026-09-05修正: USD建ての行でも、final_value_fee + international_feeのように複数のnumeric値を
  // 足し合わせた値を渡された場合、JSの浮動小数点演算の誤差で「25.759999999999998」のような
  // 表示になってしまう不具合が実際に発生した。USD建てでも小数点第2位に丸める。
  const usdValue = row.transaction_currency === "USD" ? localValue : localValue * row.exchange_rate;
  return Math.round(usdValue * 100) / 100;
}

/** 自動突合できなかった行を、ユーザーが選んだ在庫アイテムに手動で紐付ける */
export async function linkEbayTransactionLineToItem(lineId: string, itemId: string): Promise<void> {
  const { error } = await supabase
    .from("ebay_transaction_lines")
    .update({ matched_item_id: itemId, match_status: "matched_pending", matched_at: new Date().toISOString() })
    .eq("id", lineId);
  if (error) throw error;
}

/** レビューキューから対象外として除外する(削除はしない) */
export async function ignoreEbayTransactionLine(lineId: string): Promise<void> {
  const { error } = await supabase
    .from("ebay_transaction_lines")
    .update({ match_status: "ignored" })
    .eq("id", lineId);
  if (error) throw error;
}

/** 売上登録フォームから正常に登録できた後、レビューキューから外す */
export async function markEbayTransactionLineRegistered(lineId: string): Promise<void> {
  const { error } = await supabase
    .from("ebay_transaction_lines")
    .update({ match_status: "registered", matched_at: new Date().toISOString() })
    .eq("id", lineId);
  if (error) throw error;
}


export interface SalesTabDataCounts {
  sales: number;
  ebayTransactionLines: number;
  ebayTaxInvoiceLines: number;
  platformSettlementImports: number;
  cpassShipments: number;
}

/**
 * 「売上・粗利」タブに登録されているデータの件数をまとめて取得する。
 * 危険な操作(全クリア)の確認表示用(2026-08-31追加)。
 * 対象は sales(実際の売上登録) と、eBay自動同期・CPaSS取込で溜まる補助データ
 * (ebay_transaction_lines / ebay_tax_invoice_lines / platform_settlement_imports / cpass_shipments)。
 * 在庫(items/purchases)・経費(expenses)には影響しない別スコープ。
 */
export async function getSalesTabDataCounts(): Promise<SalesTabDataCounts> {
  const [sales, ebayTransactionLines, ebayTaxInvoiceLines, platformSettlementImports, cpassShipments] =
    await Promise.all([
      supabase.from("sales").select("id", { count: "exact", head: true }),
      supabase.from("ebay_transaction_lines").select("id", { count: "exact", head: true }),
      supabase.from("ebay_tax_invoice_lines").select("id", { count: "exact", head: true }),
      supabase.from("platform_settlement_imports").select("id", { count: "exact", head: true }),
      supabase.from("cpass_shipments").select("id", { count: "exact", head: true }),
    ]);
  for (const r of [sales, ebayTransactionLines, ebayTaxInvoiceLines, platformSettlementImports, cpassShipments]) {
    if (r.error) throw r.error;
  }
  return {
    sales: sales.count ?? 0,
    ebayTransactionLines: ebayTransactionLines.count ?? 0,
    ebayTaxInvoiceLines: ebayTaxInvoiceLines.count ?? 0,
    platformSettlementImports: platformSettlementImports.count ?? 0,
    cpassShipments: cpassShipments.count ?? 0,
  };
}

const ZERO_UUID_SALES = "00000000-0000-0000-0000-000000000000";

/**
 * 「売上・粗利」タブに登録されているデータを全件削除する(2026-08-31追加)。
 * 対象: sales・ebay_transaction_lines・ebay_tax_invoice_lines・platform_settlement_imports・cpass_shipments。
 * 在庫(items/purchases)・経費(expenses)には一切影響しない。
 * 削除順序に注意: sales.ebay_transaction_line_id が ebay_transaction_lines を参照しているため、
 * 先にsalesを削除してからebay_transaction_linesを削除する(FK制約違反を避けるため)。
 * ebay_tax_invoice_lines・platform_settlement_imports・cpass_shipmentsは他テーブルから参照されないため順不同。
 */
export async function clearAllSalesTabData(): Promise<void> {
  const salesDel = await supabase.from("sales").delete().neq("id", ZERO_UUID_SALES);
  if (salesDel.error) throw salesDel.error;

  const taxDel = await supabase.from("ebay_tax_invoice_lines").delete().neq("id", ZERO_UUID_SALES);
  if (taxDel.error) throw taxDel.error;

  const linesDel = await supabase.from("ebay_transaction_lines").delete().neq("id", ZERO_UUID_SALES);
  if (linesDel.error) throw linesDel.error;

  const importsDel = await supabase.from("platform_settlement_imports").delete().neq("id", ZERO_UUID_SALES);
  if (importsDel.error) throw importsDel.error;

  const cpassDel = await supabase.from("cpass_shipments").delete().neq("id", ZERO_UUID_SALES);
  if (cpassDel.error) throw cpassDel.error;
}

/**
 * 在庫タブ「詳細編集」→「販売」タブで、1件のeBay取引明細(ebay_transaction_lines)に対応する
 * 広告料(Ad Fee General)を集計する(2026-09-06追加)。ebay_tax_invoice_lines(fee_category='ad_fee')には
 * ebay_transaction_linesへの直接の外部キーが無く、order_number・item_number(=ebay_transaction_lines.item_id)の
 * 組み合わせでしか紐付けられないため、fetchEbayReviewQueue()のadFeeByKey集計と同じキーで問い合わせる。
 */
export async function fetchAdFeeForOrderItem(orderNumber: string, itemNumber: string | null): Promise<number> {
  let query = supabase
    .from("ebay_tax_invoice_lines")
    .select("order_number, item_number, line_date, description, fee_type, net_amount, net_amount_usd")
    .eq("fee_category", "ad_fee")
    .eq("order_number", orderNumber);
  query = itemNumber ? query.eq("item_number", itemNumber) : query.is("item_number", null);
  const { data, error } = await query;
  if (error) throw error;
  const rows = dedupeTaxInvoiceRows((data ?? []) as Array<{
      order_number: string | null;
      item_number: string | null;
      line_date: string | null;
      description: string | null;
      fee_type: string | null;
      net_amount: number | null;
      net_amount_usd: number | null;
    }>);
  return rows.reduce((sum, row) => sum + Number(row.net_amount_usd ?? 0), 0);
}

/**
 * 在庫タブ「詳細編集」→「販売」タブで、1件のeBay取引明細に対応する取引手数料(Transaction fees、
 * 広告料を除く)を集計する(2026-09-06追加、管理番号260521-06のユーザー報告「Transaction feesの値が
 * 間違っている」への対応)。
 *
 * 【根本原因】ebay_transaction_lines.final_value_fee + international_fee は、eBay Sell Fulfillment
 * API同期時点の値であり、月次のTax Invoice(ebay_tax_invoice_lines)に計上される
 * FINAL_VALUE_FEE_FIXED_PER_ORDER(注文単位の固定手数料、国際取引で発生することが多い)や
 * REGULATORY_OPERATING_FEE(規制対応手数料)を含まない。そのため国際取引では実際の手数料合計より
 * 少なく表示されてしまう(実例: 管理番号260521-06、final_value_fee+international_fee=$5.54だが、
 * Tax Invoice側の実額合計は$6.24で$0.70の差があった。差の主因はFIXED_PER_ORDER $0.56、残りは
 * 通貨換算レートの違いによる丸め差)。
 *
 * ebay_tax_invoice_lines は fee_category が ad_fee(広告料)/fvf_international/other
 * (FINAL_VALUE_FEE・FINAL_VALUE_FEE_FIXED_PER_ORDER・REGULATORY_OPERATING_FEEをまとめて'other'に
 * 分類)の2系統のみなので、ad_fee以外を合計すれば「Transaction fees」の実額になる。
 * fetchAdFeeForOrderItem()と同じorder_number・item_number(=ITEM ID)キーで問い合わせる。
 */
export async function fetchTransactionFeeForOrderItem(orderNumber: string, itemNumber: string | null): Promise<number> {
  let query = supabase
    .from("ebay_tax_invoice_lines")
    .select("order_number, item_number, line_date, description, fee_type, net_amount, net_amount_usd")
    .neq("fee_category", "ad_fee")
    .eq("order_number", orderNumber);
  query = itemNumber ? query.eq("item_number", itemNumber) : query.is("item_number", null);
  const { data, error } = await query;
  if (error) throw error;
  const rows = dedupeTaxInvoiceRows((data ?? []) as Array<{
      order_number: string | null;
      item_number: string | null;
      line_date: string | null;
      description: string | null;
      fee_type: string | null;
      net_amount: number | null;
      net_amount_usd: number | null;
    }>);
  return rows.reduce((sum, row) => sum + Number(row.net_amount_usd ?? 0), 0);
}

/**
 * Order Noを指定してeBay Sell Fulfillment/Finances APIをその場で(DB同期に依存せず)呼び出し、
 * 売上データを取得する(2026-09-07追加、「売上・粗利」タブ「eBay売上でXLSXを自動入力」機能用)。
 * ebay_transaction_linesには無いバイヤー居住国(taxAddress)と、正確なOrder Total(pricingSummary.total、
 * item_subtotal+shippingからの再構成では非USD取引でVAT分がずれる問題を回避)を得るため、
 * 既存の20分ごとcron同期とは別に、指定注文のみをその場でAPI照会する専用Edge Function。
 */
export interface EbayOrderLookupResult {
  orderNo: string;
  found: boolean;
  error?: string;
  soldDate?: string;
  itemTitle?: string;
  sku?: string;
  subtotalUsd?: number;
  shippingUsd?: number;
  orderTotalUsd?: number;
  adFeeUsd?: number;
  buyerCountry?: string | null;
}

export async function lookupEbayOrdersLive(
  orderNumbers: string[],
  shopId: "soulcamera" | "soulmenjapan" = "soulcamera",
): Promise<EbayOrderLookupResult[]> {
  const { data, error } = await supabase.functions.invoke("ebay-order-lookup", {
    body: { orderNumbers, shopId },
  });
  if (error) throw error;
  return (data as { results: EbayOrderLookupResult[] }).results;
}

/**
 * 指定した日時(年月日時分)以降に成立したeBay注文の注文番号一覧を取得する(2026-09-23追加、
 * 「利益管理票更新用データの作成」機能でOrder Noを手入力する代わりに使う)。
 * 専用のEdge Function(ebay-orders-since、DB書き込み無しの読み取り専用)を呼び出す。
 * eBay Sell Fulfillment APIの仕様上、直近90日より前の注文は返らない点に注意。
 */
export async function fetchOrderNumbersSince(
  shopId: "soulcamera" | "soulmenjapan",
  sinceDatetimeIso: string,
): Promise<string[]> {
  const { data, error } = await supabase.functions.invoke("ebay-orders-since", {
    body: { shopId, sinceDatetime: sinceDatetimeIso },
  });
  if (error) throw error;
  if (data && typeof data === "object" && "error" in data && (data as { error?: unknown }).error) {
    throw new Error(String((data as { error: unknown }).error));
  }
  return (data as { orderNumbers: string[] }).orderNumbers;
}

/** 「出品チェック」機能(2026-09-08追加)。システム上「出品中」の商品と、eBay(米国サイト・
 *  ストック1以上)の実際のアクティブ出品を突合し、過不足を検出する。Trading APIの
 *  GetMyeBaySellingを使うため、DB同期(ebay_transaction_lines等)には依存しない。 */
export interface ListingCheckShortageRow {
  managementNo: string;
  title: string | null;
}

export interface ListingCheckExcessRow {
  itemId: string;
  sku: string | null;
  soulcameraItemInfo: string | null;
  title: string | null;
  quantityAvailable: number;
  matchedManagementNo: string | null;
  matchedStatus: string | null;
  matchedAccount: string | null;
  matchSource: "soulcamera_item_info" | "sku" | null;
}

/**
 * 在庫アラート(model_drive_stock_counts)で在庫1件以上ある機種のうち、同一機種名を含む
 * eBayアクティブ出品(米国サイト、QTY問わず)が1件も無い、または見つかってもQTY合計が0の機種
 * (2026-09-25追加、機種名とeBay出品タイトルの突合は単語単位のあいまい一致)。
 */
export interface ListingCheckModelStockRow {
  modelFolderName: string;
  inStockCount: number;
  matchedListingsCount: number;
  totalQuantityAvailable: number;
}

export interface ListingCheckResult {
  shopId: "soulcamera" | "soulmenjapan";
  totalEbayActiveListings: number;
  totalEbayActiveUsListings: number;
  totalListedInSystem: number;
  shortage: ListingCheckShortageRow[];
  excess: ListingCheckExcessRow[];
  modelStockIssues: ListingCheckModelStockRow[];
}

export async function runEbayListingCheck(
  shopId: "soulcamera" | "soulmenjapan",
): Promise<ListingCheckResult> {
  const { data, error } = await supabase.functions.invoke("ebay-listing-check", {
    body: { shopId },
  });
  if (error) throw error;
  return data as ListingCheckResult;
}
