import { supabase } from "../supabaseClient";

export interface ShippingImportRecord {
  orderNo: string;
  trackingNumber: string;
  shippingFeeJpy: number;
}

export interface ShippingImportResult extends ShippingImportRecord {
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
 * eLogi(送料支払CSVエクスポート)の「発送済一覧」CSVを解析する(送料登録タブ、2026-09-14新規)。
 * 「eBayオーダー番号」列が空の行(複数商品まとめ発送等)は対象外とする。
 * 追跡番号はCSVの「追跡番号」列の値をそのまま使用し(CPaSSの抽出値とは別物)、
 * 送料支払額(円)は「初回請求金額」+「追加請求/返金金額」の合計とする。
 */
export function parseElogiCsv(text: string): ShippingImportRecord[] {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  if (rows.length === 0) return [];
  const header = rows[0];
  const idx = (name: string) => header.indexOf(name);

  const trackingIdx = idx("追跡番号");
  const orderNoIdx = idx("eBayオーダー番号");
  const firstFeeIdx = idx("初回請求金額");
  const extraFeeIdx = idx("追加請求/返金金額");

  if (trackingIdx === -1 || orderNoIdx === -1 || firstFeeIdx === -1 || extraFeeIdx === -1) {
    throw new Error(
      "CSVのヘッダーに「追跡番号」「eBayオーダー番号」「初回請求金額」「追加請求/返金金額」のいずれかが見つかりません",
    );
  }

  const records: ShippingImportRecord[] = [];
  for (const row of rows.slice(1)) {
    const orderNo = (row[orderNoIdx] ?? "").trim();
    const trackingNumber = (row[trackingIdx] ?? "").trim();
    if (!orderNo || !trackingNumber) continue;

    const firstFee = Number((row[firstFeeIdx] ?? "0").replace(/,/g, "").trim() || "0");
    const extraFee = Number((row[extraFeeIdx] ?? "0").replace(/,/g, "").trim() || "0");
    if (Number.isNaN(firstFee) || Number.isNaN(extraFee)) continue;

    records.push({ orderNo, trackingNumber, shippingFeeJpy: firstFee + extraFee });
  }
  return records;
}

/** 解析結果を、eBay取引明細(ebay_transaction_lines.order_number)経由で販売済み商品と突合し、
 *  該当するsalesレコードのtracking_info・shipping_cost_paidを更新する(CPaSS・eLogi共通処理)。 */
export async function applyShippingRecords(records: ShippingImportRecord[]): Promise<ShippingImportResult[]> {
  const results: ShippingImportResult[] = [];

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

export async function registerCpassShipping(text: string): Promise<ShippingImportResult[]> {
  return applyShippingRecords(parseCpassShippingText(text));
}

export async function registerElogiShipping(text: string): Promise<ShippingImportResult[]> {
  return applyShippingRecords(parseElogiCsv(text));
}
