import { supabase } from "../supabaseClient";
import { parseElogiCsv } from "./cpassShipping";
import type { BilledRecord, ReconcileRow, SaleRef } from "../shippingReconcileCore";

/**
 * 2026-10-03新規(ユーザー指示): 送料支払額の請求明細との照合のDBアクセス層(取得・更新)。
 * 照合ロジック本体(画面・DBに依存しない)は lib/shippingReconcileCore.ts。
 */

const PAGE_SIZE = 1000;

interface SaleQueryRow {
  id: string;
  sale_date: string;
  tracking_info: string | null;
  shipping_cost_paid: number | null;
  order_number: string | null;
  items: { management_no: string; title: string | null } | null;
  ebay_transaction_lines: { order_number: string | null } | null;
}

/** 全売上を取得する(PostgRESTの既定1000件上限で打ち切られないよう、rangeでページングする)。 */
export async function fetchSalesForReconcile(): Promise<SaleRef[]> {
  const all: SaleQueryRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("sales")
      .select(
        "id, sale_date, tracking_info, shipping_cost_paid, order_number, items(management_no, title), ebay_transaction_lines(order_number)",
      )
      .order("sale_date", { ascending: false })
      .order("id")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = (data ?? []) as unknown as SaleQueryRow[];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return all.map((s) => ({
    id: s.id,
    saleDate: s.sale_date,
    managementNo: s.items?.management_no ?? "",
    title: s.items?.title ?? null,
    trackingInfo: s.tracking_info ?? "",
    orderNumbers: [s.order_number, s.ebay_transaction_lines?.order_number].filter((v): v is string => !!v),
    registered: Number(s.shipping_cost_paid ?? 0),
    registeredRaw: s.shipping_cost_paid === null ? null : Number(s.shipping_cost_paid),
  }));
}

/** eLogi発送済一覧CSVを、照合用の請求レコード(キー=eBayオーダー番号、追跡番号も保持)に変換する。 */
export function parseElogiBilledRecords(text: string): BilledRecord[] {
  return parseElogiCsv(text).map((r) => ({
    key: r.orderNo,
    billed: r.shippingFeeJpy,
    trackingNo: r.trackingNumber,
  }));
}

export interface OverwriteResult {
  updated: number;
  /** 登録額が、画面表示後に他で変更されていたため上書きしなかったもの */
  changedElsewhere: number;
  failed: { managementNo: string; message: string }[];
}

/**
 * 選択された相違行の送料支払額(sales.shipping_cost_paid)を請求額で上書きする。
 * - 1請求=1売上の行だけが対象(複数売上が紐付く行は按分できないため呼び出し側で除外すること)。
 * - 安全のため、「画面に表示した時点の登録額と同じ場合だけ」更新する(他の画面で先に変更されていたら
 *   上書きせず changedElsewhere に数える)。
 * - gross_profit_jpy は生成列のため、送料を更新すれば粗利は自動で再計算される。
 */
export async function overwriteShippingWithBilled(rows: ReconcileRow[]): Promise<OverwriteResult> {
  const result: OverwriteResult = { updated: 0, changedElsewhere: 0, failed: [] };
  const targets = rows.filter((r) => r.sales.length === 1);

  const CONCURRENCY = 5;
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    await Promise.all(
      targets.slice(i, i + CONCURRENCY).map(async (row) => {
        const sale = row.sales[0];
        let query = supabase.from("sales").update({ shipping_cost_paid: row.billed }).eq("id", sale.id);
        query = sale.registeredRaw === null
          ? query.is("shipping_cost_paid", null)
          : query.eq("shipping_cost_paid", sale.registeredRaw);
        const { data, error } = await query.select("id");
        if (error) {
          result.failed.push({ managementNo: sale.managementNo, message: error.message });
        } else if (!data || data.length === 0) {
          result.changedElsewhere++;
        } else {
          result.updated++;
        }
      }),
    );
  }
  return result;
}
