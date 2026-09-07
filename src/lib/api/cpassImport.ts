import * as XLSX from "xlsx";
import { supabase } from "../supabaseClient";

/**
 * CPaSS(eBay公式のクロスボーダー配送・ラベル発行ツール、cpass.ebay.com)からエクスポートした
 * xlsx(Sheet0、47列)を取り込み、cpass_shipments テーブルへ追跡番号・配送情報を保存するロジック。
 *
 * マッチングキー: エクスポートの「eBay order ID」列 = ebay_transaction_lines.order_number
 * (ユーザー指定: "Order番号でマッチさせて")
 *
 * 注意: このエクスポート(47列)には「送料(shipping fee)」に相当する列が存在しない。
 * 追跡番号(Trackcode)・配送業者・配送日等は取得できるが、送料は別途ソースが必要。
 * shipping_fee / shipping_fee_currency 列は将来のソース追加に備えて用意してあるが、
 * 現状のこのインポートでは常にnullのまま保存される。
 */

const REQUIRED_HEADERS = ["eBay order ID", "Trackcode"];

export interface CpassRawRow {
  rowNumber: number; // シート上の行番号(1始まり、ヘッダー行を含む実物の行番号)
  orderNumber: string | null;
  itemId: string | null;
  packageNo: string | null;
  trackingNumber: string | null;
  shippingCarrier: string | null;
  shippingService: string | null;
  shippingDateRaw: unknown;
  weightKg: number | null;
  cancelStatus: string | null;
}

export type CpassRowOutcome = "matched" | "unmatched_order" | "error";

export interface CpassPreviewRow {
  raw: CpassRawRow;
  outcome: CpassRowOutcome;
  errors: string[];
  matchedItemTitle: string | null;
}

function toStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** 'Package No.'のような数値セル(1427.0等)を整数文字列として扱う */
function toStrTrimZero(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "number") {
    return Number.isInteger(v) ? String(v) : String(v);
  }
  return toStr(v);
}

function toNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

/** 'Shipping date'セルをISO文字列に正規化する(Dateオブジェクト・文字列どちらでも受け付ける) */
function toIsoDate(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return v.toISOString();
  }
  const s = String(v).trim();
  if (s === "") return null;
  // "2026-07-12T12:59:35" 形式はそのままDateとして解釈できる
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return null;
}

/**
 * xlsxファイル(File)を読み込み、CpassRawRow[]を返す。
 * ヘッダー行の列名から位置を特定するため、列の並び順が変わっても壊れにくい。
 */
export async function parseCpassFile(file: File): Promise<CpassRawRow[]> {
  const buffer = await file.arrayBuffer();
  const wb = XLSX.read(buffer, { type: "array", cellDates: true });
  const sheetName = wb.SheetNames.includes("Sheet0") ? "Sheet0" : wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  if (!sheet) {
    throw new Error("シートが見つかりません");
  }
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null });
  if (aoa.length === 0) {
    throw new Error("データが空です");
  }
  const header = aoa[0].map((h) => (h == null ? "" : String(h).trim()));
  const colIndex = (name: string): number => header.indexOf(name);

  for (const required of REQUIRED_HEADERS) {
    if (colIndex(required) === -1) {
      throw new Error(
        `想定される列「${required}」が見つかりません(CPaSSのエクスポート形式が変わった可能性があります。列一覧: ${header.join(", ")})`,
      );
    }
  }

  const iOrderNumber = colIndex("eBay order ID");
  const iItemId = colIndex("Item ID");
  const iPackageNo = colIndex("Package No.");
  const iTrackcode = colIndex("Trackcode");
  const iCarrier = colIndex("Shipping carrier");
  const iService = colIndex("Shipping service");
  const iShippingDate = colIndex("Shipping date");
  const iWeight = colIndex("Weight kg");
  const iCancelStatus = colIndex("Cancel status");

  const rows: CpassRawRow[] = [];
  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r];
    if (!row || row.every((v) => v == null || v === "")) continue; // 完全な空行はスキップ
    rows.push({
      rowNumber: r + 1,
      orderNumber: toStr(row[iOrderNumber]),
      itemId: toStr(row[iItemId]),
      packageNo: toStrTrimZero(row[iPackageNo]),
      trackingNumber: toStr(row[iTrackcode]),
      shippingCarrier: toStr(row[iCarrier]),
      shippingService: toStr(row[iService]),
      shippingDateRaw: iShippingDate === -1 ? null : row[iShippingDate],
      weightKg: iWeight === -1 ? null : toNum(row[iWeight]),
      cancelStatus: iCancelStatus === -1 ? null : toStr(row[iCancelStatus]),
    });
  }
  return rows;
}

/**
 * 取込前の突合チェック(ドライラン)。order_numberがebay_transaction_linesに
 * 存在するかどうかを確認し、プレビュー表示用の情報を付与する。
 * (存在しなくてもエラーにはしない=不明な行としてそのまま保存できるが、確認しやすいよう区別する)
 */
export async function previewCpassRows(rows: CpassRawRow[]): Promise<CpassPreviewRow[]> {
  const orderNumbers = Array.from(new Set(rows.map((r) => r.orderNumber).filter((v): v is string => !!v)));
  const matchByOrder = new Map<string, string | null>(); // order_number -> item_title(先頭一致)
  if (orderNumbers.length > 0) {
    const { data, error } = await supabase
      .from("ebay_transaction_lines")
      .select("order_number, item_title")
      .in("order_number", orderNumbers);
    if (error) throw error;
    for (const t of (data ?? []) as Array<{ order_number: string | null; item_title: string | null }>) {
      if (t.order_number && !matchByOrder.has(t.order_number)) {
        matchByOrder.set(t.order_number, t.item_title);
      }
    }
  }

  return rows.map((raw) => {
    const errors: string[] = [];
    if (!raw.orderNumber) errors.push("eBay order IDが空です");
    if (errors.length > 0) {
      return { raw, outcome: "error", errors, matchedItemTitle: null };
    }
    const title = matchByOrder.get(raw.orderNumber as string);
    if (title !== undefined) {
      return { raw, outcome: "matched", errors, matchedItemTitle: title };
    }
    return { raw, outcome: "unmatched_order", errors, matchedItemTitle: null };
  });
}

export interface CpassImportResult {
  imported: number;
  skipped: number;
}

/**
 * プレビュー行を cpass_shipments へupsertする(order_number, item_id の組で衝突時は上書き)。
 * order_numberが空の行(outcome==="error")は取り込まない。
 */
export async function executeCpassImport(rows: CpassPreviewRow[], fileName: string): Promise<CpassImportResult> {
  const targets = rows.filter((r) => r.outcome !== "error");
  if (targets.length === 0) return { imported: 0, skipped: rows.length };

  const nowIso = new Date().toISOString();
  const payload = targets.map((r) => ({
    order_number: r.raw.orderNumber as string,
    item_id: r.raw.itemId,
    package_no: r.raw.packageNo,
    tracking_number: r.raw.trackingNumber,
    shipping_carrier: r.raw.shippingCarrier,
    shipping_service: r.raw.shippingService,
    shipping_date: toIsoDate(r.raw.shippingDateRaw),
    weight_kg: r.raw.weightKg,
    raw_file_reference: fileName,
    imported_at: nowIso,
    updated_at: nowIso,
  }));

  const { error } = await supabase.from("cpass_shipments").upsert(payload, { onConflict: "order_number,item_id" });
  if (error) throw error;

  return { imported: targets.length, skipped: rows.length - targets.length };
}

/**
 * 送料(shipping fee)の手入力保存。CPaSSエクスポートには送料列が存在しないため、
 * ユーザーが画面上で直接入力・保存できるようにする手動入力用の関数。
 * order_number(+item_id)の組で cpass_shipments に upsert する(他の列(追跡番号等)は触らない、
 * 送料関連の列だけを対象とする部分更新)。まだCPaSS取込していない受注に対しても、
 * 送料だけ先に手入力できるよう、行が存在しない場合は新規作成する。
 */
export async function upsertManualShippingFee(
  orderNumber: string,
  itemId: string | null,
  shippingFee: number | null,
  shippingFeeCurrency: string | null,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const { error } = await supabase.from("cpass_shipments").upsert(
    {
      order_number: orderNumber,
      item_id: itemId,
      shipping_fee: shippingFee,
      shipping_fee_currency: shippingFeeCurrency,
      updated_at: nowIso,
    },
    { onConflict: "order_number,item_id" },
  );
  if (error) throw error;
}
