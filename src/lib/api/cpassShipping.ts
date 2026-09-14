import { supabase } from "../supabaseClient";

export interface CpassShippingRecord {
  orderNo: string;
  trackingNumber: string;
  shippingFeeJpy: number;
}

export interface CpassShippingResult extends CpassShippingRecord {
  status: "success" | "not_found" | "not_sold" | "no_sale" | "error";
  managementNo?: string;
  message: string;
}

const CARRIERS = ["FedEx", "DHL"];
const TRACKING_LENGTH = 29;

/**
 * CPaSS(出荷)画面のコピー&ペースト内容を解析する(送料登録タブ、2026-09-14新規)。
 * 1件の出荷ごとに「ORDER NO.」「EST. SHIPPING FEE」「APPLIED SHIPPING SERVICE」の
 * 各ラベル行の直後の行に値が来る固定フォーマットを前提とし、行単位でスキャンする。
 */
export function parseCpassShippingText(text: string): CpassShippingRecord[] {
  const lines = text.split(/\r\n|\r|\n/);
  const records: CpassShippingRecord[] = [];
  let orderNo: string | null = null;
  let shippingFeeJpy: number | null = null;
  let appliedLine: string | null = null;

  function flush() {
    if (orderNo && shippingFeeJpy !== null && appliedLine) {
      const trackingNumber = extractTrackingNumber(appliedLine);
      if (trackingNumber) {
        records.push({ orderNo, trackingNumber, shippingFeeJpy });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "ORDER NO.") {
      flush();
      orderNo = (lines[i + 1] ?? "").trim();
      shippingFeeJpy = null;
      appliedLine = null;
    } else if (line === "EST. SHIPPING FEE" && orderNo) {
      const raw = (lines[i + 1] ?? "").trim();
      const m = raw.match(/^([\d,]+)\s*JPY$/);
      if (m) shippingFeeJpy = Number(m[1].replace(/,/g, ""));
    } else if (line === "APPLIED SHIPPING SERVICE" && orderNo) {
      appliedLine = (lines[i + 1] ?? "").trim();
    }
  }
  flush();
  return records;
}

/** 「Orange Connex (Japan) – FedEx XXXXXXXXXXXXXXXXXXXXXXXXXXXXX 」形式の行から、
 *  配送業者名(FedEx/DHL)+半角スペース1つの直後29文字を追跡番号として取り出す。 */
function extractTrackingNumber(line: string): string | null {
  for (const carrier of CARRIERS) {
    const marker = `${carrier} `;
    const idx = line.indexOf(marker);
    if (idx !== -1) {
      const start = idx + marker.length;
      return line.slice(start, start + TRACKING_LENGTH).trim();
    }
  }
  return null;
}

/** 解析結果を、eBay取引明細(ebay_transaction_lines.order_number)経由で販売済み商品と突合し、
 *  該当するsalesレコードのtracking_info・shipping_cost_paidを更新する。 */
export async function registerCpassShipping(text: string): Promise<CpassShippingResult[]> {
  const records = parseCpassShippingText(text);
  const results: CpassShippingResult[] = [];

  for (const record of records) {
    const { data: line, error: lineError } = await supabase
      .from("ebay_transaction_lines")
      .select("matched_item_id")
      .eq("order_number", record.orderNo)
      .not("matched_item_id", "is", null)
      .limit(1)
      .maybeSingle();

    if (lineError) {
      results.push({ ...record, status: "error", message: `照会に失敗しました: ${lineError.message}` });
      continue;
    }
    if (!line?.matched_item_id) {
      results.push({ ...record, status: "not_found", message: "対応する商品が見つかりません(eBay取引未突合)" });
      continue;
    }

    const { data: item, error: itemError } = await supabase
      .from("items")
      .select("management_no, status")
      .eq("id", line.matched_item_id)
      .single();

    if (itemError || !item) {
      results.push({ ...record, status: "not_found", message: "商品情報の取得に失敗しました" });
      continue;
    }
    if (item.status !== "sold") {
      results.push({
        ...record,
        status: "not_sold",
        managementNo: item.management_no,
        message: `ステータスが「販売済み」ではありません(現在: ${item.status})`,
      });
      continue;
    }

    const { data: sales, error: saleError } = await supabase
      .from("sales")
      .select("id")
      .eq("item_id", line.matched_item_id)
      .order("created_at", { ascending: false })
      .limit(1);

    if (saleError || !sales || sales.length === 0) {
      results.push({ ...record, status: "no_sale", managementNo: item.management_no, message: "売上レコードが見つかりません" });
      continue;
    }

    const { error: updateError } = await supabase
      .from("sales")
      .update({ tracking_info: record.trackingNumber, shipping_cost_paid: record.shippingFeeJpy })
      .eq("id", sales[0].id);

    if (updateError) {
      results.push({ ...record, status: "error", managementNo: item.management_no, message: `更新に失敗しました: ${updateError.message}` });
      continue;
    }

    results.push({ ...record, status: "success", managementNo: item.management_no, message: "登録しました" });
  }

  return results;
}
