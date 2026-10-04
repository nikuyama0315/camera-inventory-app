import { supabase } from "../supabaseClient";

export interface ShippingImportRecord {
  orderNo: string;
  trackingNumber: string;
  shippingFeeJpy: number;
  /** eLogiの「購入者ID」(eBayのusername)。matchBy="buyerId"のレコードは、オーダー番号ではなくこの値で取引明細と突合する */
  buyerId?: string;
  /** 取引明細との突合キー。未指定=eBayオーダー番号(CPaSS)、"buyerId"=購入者ID(eLogi送料登録) */
  matchBy?: "buyerId";
}

export interface ShippingImportResult extends ShippingImportRecord {
  status: "success" | "not_found" | "not_sold" | "no_sale" | "ambiguous" | "error";
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
export function parseCpassShippingText(text: string): ShippingImportRecord[] {
  const lines = text.split(/\r\n|\r|\n/);
  const records: ShippingImportRecord[] = [];
  let orderNo: string | null = null;
  let shippingFeeJpy: number | null = null;
  let appliedLine: string | null = null;

  function flush() {
    if (orderNo && shippingFeeJpy !== null && appliedLine) {
      const trackingNumber = extractCpassTrackingNumber(appliedLine);
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
function extractCpassTrackingNumber(line: string): string | null {
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

/** RFC4180ライクな簡易CSVパーサ(ダブルクォート囲み・エスケープ""・フィールド内カンマ/改行に対応)。
 *  eLogi出力CSVの「氏名」「ラベル用商品詳細」等、カンマや括弧を含む値がクォートされているため必要。 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += char;
      i++;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (char === "\r") {
      i++;
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += char;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/**
 * eLogi(送料支払CSVエクスポート)のCSVを解析する(送料登録タブ、2026-09-14新規)。次の2形式に対応する。
 *
 * ①「発送済一覧」CSV: 「追跡番号」「eBayオーダー番号」「初回請求金額」「追加請求/返金金額」(「購入者ID」)列を持つ。
 *   「eBayオーダー番号」列が空の行(複数商品まとめ発送等)は対象外。送料支払額(円)は「初回請求金額」+「追加請求/返金金額」の合計。
 * ②「発送を完了する一覧」CSV(2026-10-04追加): 「請求書ID」「ラベル印刷日」「追跡番号」「購入者ID」「請求金額」…の列を持ち、
 *   eBayオーダー番号の列は無い。送料支払額(円)は「請求金額」。購入者IDで突合するため、②は送料登録(requireBuyerId)のみ対応。
 *
 * 「購入者ID」列(eBayのusername)は、送料登録の突合キーとして各レコードのbuyerIdに保持する。
 * 追跡番号はCSVの「追跡番号」列の値をそのまま使用する(CPaSSの抽出値とは別物)。
 * requireBuyerId=trueは送料登録用(購入者IDで突合、②形式も可)。省略時は突合差分レポート用で、①のみ対応する。
 */
export function parseElogiCsv(text: string, options: { requireBuyerId?: boolean } = {}): ShippingImportRecord[] {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  if (rows.length === 0) return [];
  const header = rows[0];
  const idx = (name: string) => header.indexOf(name);

  const trackingIdx = idx("追跡番号");
  const orderNoIdx = idx("eBayオーダー番号");
  const firstFeeIdx = idx("初回請求金額");
  const extraFeeIdx = idx("追加請求/返金金額");
  const buyerIdIdx = idx("購入者ID");
  const billedIdx = idx("請求金額");

  const isShippedList = trackingIdx !== -1 && orderNoIdx !== -1 && firstFeeIdx !== -1 && extraFeeIdx !== -1;
  const isCompletionList = !isShippedList && trackingIdx !== -1 && buyerIdIdx !== -1 && billedIdx !== -1;

  if (!isShippedList && !(options.requireBuyerId && isCompletionList)) {
    throw new Error(
      options.requireBuyerId
        ? "CSVのヘッダーが想定と異なります。「発送済一覧」(追跡番号・eBayオーダー番号・初回請求金額・追加請求/返金金額・購入者ID)、" +
            "または「発送を完了する一覧」(追跡番号・購入者ID・請求金額)のCSVを選択してください"
        : "CSVのヘッダーに「追跡番号」「eBayオーダー番号」「初回請求金額」「追加請求/返金金額」のいずれかが見つかりません",
    );
  }
  // 送料登録は購入者IDで取引明細と突合するため、この列が必須。突合差分レポート側は不要なので任意。
  if (options.requireBuyerId && buyerIdIdx === -1) {
    throw new Error("CSVのヘッダーに「購入者ID」が見つかりません(購入者IDで取引明細と突合します)");
  }

  const toNumber = (raw: string | undefined) => Number((raw ?? "0").replace(/,/g, "").trim() || "0");
  const records: ShippingImportRecord[] = [];
  for (const row of rows.slice(1)) {
    const trackingNumber = (row[trackingIdx] ?? "").trim();
    const buyerId = buyerIdIdx === -1 ? "" : (row[buyerIdIdx] ?? "").trim();
    const matchBy = options.requireBuyerId ? ({ matchBy: "buyerId" } as const) : {};

    if (isShippedList) {
      const orderNo = (row[orderNoIdx] ?? "").trim();
      if (!orderNo || !trackingNumber) continue;
      const firstFee = toNumber(row[firstFeeIdx]);
      const extraFee = toNumber(row[extraFeeIdx]);
      if (Number.isNaN(firstFee) || Number.isNaN(extraFee)) continue;
      records.push({
        orderNo,
        trackingNumber,
        shippingFeeJpy: firstFee + extraFee,
        ...(buyerId ? { buyerId } : {}),
        ...matchBy,
      });
    } else {
      // 「発送を完了する一覧」形式: オーダー番号の列は無い(orderNoは空)。追跡番号・購入者IDが空の行は対象外
      if (!trackingNumber || !buyerId) continue;
      const billed = toNumber(row[billedIdx]);
      if (Number.isNaN(billed)) continue;
      records.push({ orderNo: "", trackingNumber, shippingFeeJpy: billed, buyerId, ...matchBy });
    }
  }
  return records;
}

type MatchedItem =
  | { kind: "found"; itemId: string }
  | { kind: "not_found"; message: string }
  | { kind: "ambiguous"; message: string }
  | { kind: "error"; message: string };

/** eBayオーダー番号が一致し、商品に突合済みの取引明細を探す(CPaSS用)。 */
async function findMatchedItemIdByOrderNo(record: ShippingImportRecord): Promise<MatchedItem> {
  const { data: line, error } = await supabase
    .from("ebay_transaction_lines")
    .select("matched_item_id")
    .eq("order_number", record.orderNo)
    .not("matched_item_id", "is", null)
    .limit(1)
    .maybeSingle();
  if (error) return { kind: "error", message: `照会に失敗しました: ${error.message}` };
  if (!line?.matched_item_id) {
    return { kind: "not_found", message: "対応する商品が見つかりません(eBay取引未突合)" };
  }
  return { kind: "found", itemId: line.matched_item_id };
}

/** LIKEの特殊文字(% _ \\)をエスケープする。usernameには「_」が含まれることが多く、そのままだと任意の1文字に一致してしまうため。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/**
 * 購入者ID(eBayのusername、大文字小文字は区別しない)が一致し、商品に突合済みの取引明細を探す(eLogi用、2026-10-04変更)。
 * 同じ購入者が複数の商品に一致する場合は、誤った商品に送料を書き込まないよう、次の順に絞り込む:
 * (1) CSVのeBayオーダー番号が一致する明細の商品(発送済一覧形式のみ)、(2) 販売済みの商品、
 * (3) 追跡番号が未登録の売上を持つ商品。それでも1つに決まらなければ自動登録せずスキップする。
 */
async function findMatchedItemIdByBuyer(record: ShippingImportRecord): Promise<MatchedItem> {
  const buyerId = record.buyerId ?? "";
  const { data: lines, error } = await supabase
    .from("ebay_transaction_lines")
    .select("matched_item_id, order_number")
    .ilike("buyer_username", escapeLike(buyerId))
    .not("matched_item_id", "is", null);
  if (error) return { kind: "error", message: `照会に失敗しました: ${error.message}` };

  const distinctIds = [...new Set((lines ?? []).map((l) => l.matched_item_id as string))];
  if (distinctIds.length === 0) {
    return {
      kind: "not_found",
      message: `購入者ID「${buyerId}」に一致し、商品に突合済みの取引明細が見つかりません`,
    };
  }
  if (distinctIds.length === 1) return { kind: "found", itemId: distinctIds[0] };

  // (1) CSVにeBayオーダー番号がある場合(発送済一覧形式)、それが一致する明細の商品に絞る
  if (record.orderNo) {
    const byOrder = [
      ...new Set(
        (lines ?? []).filter((l) => l.order_number === record.orderNo).map((l) => l.matched_item_id as string),
      ),
    ];
    if (byOrder.length === 1) return { kind: "found", itemId: byOrder[0] };
  }

  // (2) 送料の登録対象は「販売済み」の商品だけなので、販売済みの商品に絞る
  const { data: soldItems, error: soldError } = await supabase
    .from("items")
    .select("id")
    .in("id", distinctIds)
    .eq("status", "sold");
  if (soldError) return { kind: "error", message: `照会に失敗しました: ${soldError.message}` };
  const soldIds = (soldItems ?? []).map((i) => i.id as string);
  if (soldIds.length === 1) return { kind: "found", itemId: soldIds[0] };

  // (3) 販売済みが複数なら、追跡番号が未登録の売上を持つ商品(=今回の発送で追跡番号を登録するもの)に絞る
  if (soldIds.length > 1) {
    const { data: sales, error: salesError } = await supabase
      .from("sales")
      .select("item_id, tracking_info, created_at")
      .in("item_id", soldIds)
      .order("created_at", { ascending: false });
    if (salesError) return { kind: "error", message: `照会に失敗しました: ${salesError.message}` };
    const latestByItem = new Map<string, string | null>();
    for (const sale of sales ?? []) {
      if (!latestByItem.has(sale.item_id as string)) latestByItem.set(sale.item_id as string, sale.tracking_info as string | null);
    }
    const untracked = soldIds.filter((id) => !(latestByItem.get(id) ?? "").trim());
    if (untracked.length === 1) return { kind: "found", itemId: untracked[0] };
  }

  return {
    kind: "ambiguous",
    message: `購入者ID「${buyerId}」が複数の商品(${distinctIds.length}件)に一致し、オーダー番号・販売済み・追跡番号の未登録でも1件に絞れないため登録しませんでした`,
  };
}

/** 解析結果を、eBay取引明細(CPaSSはebay_transaction_lines.order_number、eLogiは購入者ID=buyer_username)経由で販売済み商品と突合し、
 *  該当するsalesレコードのtracking_info・shipping_cost_paidを更新する(CPaSS・eLogi共通処理)。 */
export async function applyShippingRecords(records: ShippingImportRecord[]): Promise<ShippingImportResult[]> {
  const results: ShippingImportResult[] = [];

  for (const record of records) {
    if (record.matchBy === "buyerId" && !record.buyerId) {
      results.push({ ...record, status: "error", message: "購入者IDが空欄のため突合できません" });
      continue;
    }
    const matched =
      record.matchBy === "buyerId" ? await findMatchedItemIdByBuyer(record) : await findMatchedItemIdByOrderNo(record);
    if (matched.kind === "error") {
      results.push({ ...record, status: "error", message: matched.message });
      continue;
    }
    if (matched.kind === "not_found") {
      results.push({ ...record, status: "not_found", message: matched.message });
      continue;
    }
    if (matched.kind === "ambiguous") {
      results.push({ ...record, status: "ambiguous", message: matched.message });
      continue;
    }
    const matchedItemId = matched.itemId;

    const { data: item, error: itemError } = await supabase
      .from("items")
      .select("management_no, status")
      .eq("id", matchedItemId)
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
      .eq("item_id", matchedItemId)
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

export async function registerCpassShipping(text: string): Promise<ShippingImportResult[]> {
  return applyShippingRecords(parseCpassShippingText(text));
}

export async function registerElogiShipping(text: string): Promise<ShippingImportResult[]> {
  return applyShippingRecords(parseElogiCsv(text, { requireBuyerId: true }));
}
