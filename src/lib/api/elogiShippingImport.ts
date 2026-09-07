import { supabase } from "../supabaseClient";
import { createExpense, type ExpenseInput } from "./expenses";

/**
 * eLogi(海外発送代行サービス)の「発送済一覧」CSVから、送料の経費計上を行うための一括取込ロジック。
 * 2026-08-31 ユーザー指示により追加。
 *
 * 【会計データとして使う項目】
 * ・ラベル印刷日 → expenses.expense_date(領収日)として使用
 * ・初回請求金額 + 追加請求/返金金額 の合計 → expenses.amount(金額、送料)として使用
 *   (追加請求/返金金額はマイナス値の場合もある。例: 返金済の行は負数で入っており、合計すれば正しく差し引かれる)
 *
 * 【記録用に保管する項目】
 * 請求書ID(初回注文)・請求書ID(追加請求)・追跡番号・購入者ID・eBayオーダー番号・アカウント種類は、
 * 会計上必須ではないがユーザーが後から参照したい情報のため、経費本体(expenses)には持たせず、
 * 専用テーブル elogi_shipments に生値のまま保管し、作成したexpensesレコードのidをexpense_idで紐付ける
 * (CPaSS配送情報取込 cpass_shipments と同じ設計パターン)。
 *
 * 【重複判定】
 * 「請求書ID(初回注文)」(例: B10001188756)を自然キーとして使う。1回の発送につき1件ユニークに振られる値で、
 * elogi_shipments.invoice_id_initial にUNIQUE制約がある。既にDBに存在する請求書IDは重複としてスキップする
 * (経費・elogi_shipmentsどちらも新規作成しない)。
 */

// CSVの列番号(1始まり)。「発送済一覧」CSVのヘッダー行で確認済み。
const COL = {
  invoiceIdInitial: 1, // 請求書ID(初回注文)
  invoiceIdAdditional: 2, // 請求書ID(追加請求)
  labelPrintDate: 4, // ラベル印刷日
  trackingNumber: 5, // 追跡番号
  buyerId: 6, // 購入者ID
  initialAmount: 8, // 初回請求金額
  additionalAmount: 9, // 追加請求/返金金額
  ebayOrderNumber: 19, // eBayオーダー番号
  accountType: 24, // アカウント種類
};

export interface ElogiRawRow {
  rowNumber: number; // CSV実物の行番号(ヘッダーが1行目、データは2行目〜)
  invoiceIdInitial: string | null;
  invoiceIdAdditional: string | null;
  labelPrintDateRaw: string | null;
  trackingNumber: string | null;
  buyerId: string | null;
  initialAmountRaw: string | null;
  additionalAmountRaw: string | null;
  ebayOrderNumber: string | null;
  accountType: string | null;
}

function cell(row: string[], colNumber1Indexed: number): string | null {
  const v = row[colNumber1Indexed - 1];
  if (v == null) return null;
  const s = v.trim();
  return s === "" ? null : s;
}

/**
 * eLogiの「発送済一覧」CSV(parseCsvで読み込んだ生の行配列、1行目はヘッダー)から
 * ElogiRawRow配列を組み立てる。ヘッダーが想定と異なる場合はエラーを投げる。
 */
export function buildElogiRawRows(rows: string[][]): ElogiRawRow[] {
  if (rows.length === 0) {
    throw new Error("CSVにデータがありません");
  }
  const header = rows[0];
  const headerCol1 = (header[COL.invoiceIdInitial - 1] ?? "").trim();
  const headerCol4 = (header[COL.labelPrintDate - 1] ?? "").trim();
  if (!headerCol1.includes("請求書ID") || !headerCol4.includes("ラベル印刷日")) {
    throw new Error(
      "CSVのヘッダーが想定と異なります(1列目に「請求書ID」、4列目に「ラベル印刷日」が含まれている必要があります)。eLogiの「発送済一覧」CSVを選択してください",
    );
  }

  const result: ElogiRawRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every((c) => c.trim() === "")) continue;
    result.push({
      rowNumber: i + 1,
      invoiceIdInitial: cell(row, COL.invoiceIdInitial),
      invoiceIdAdditional: cell(row, COL.invoiceIdAdditional),
      labelPrintDateRaw: cell(row, COL.labelPrintDate),
      trackingNumber: cell(row, COL.trackingNumber),
      buyerId: cell(row, COL.buyerId),
      initialAmountRaw: cell(row, COL.initialAmount),
      additionalAmountRaw: cell(row, COL.additionalAmount),
      ebayOrderNumber: cell(row, COL.ebayOrderNumber),
      accountType: cell(row, COL.accountType),
    });
  }
  return result;
}

export type ImportRowOutcome = "new" | "duplicate" | "error";

/** elogi_shipmentsテーブルへの投入用データ(expense_idは実行時に作成したexpenses.idを設定する)。 */
export interface ElogiShipmentInsertInput {
  invoice_id_initial: string;
  invoice_id_additional: string | null;
  label_print_date: string;
  tracking_number: string | null;
  buyer_id: string | null;
  ebay_order_number: string | null;
  account_type: string | null;
  initial_amount: number;
  additional_amount: number;
  raw_file_reference: string | null;
}

export interface MappedElogiRow {
  raw: ElogiRawRow;
  rowNumber: number;
  invoiceIdInitial: string | null;
  outcome: ImportRowOutcome;
  errors: string[];
  warnings: string[];
  totalAmount: number | null;
  expenseInput: ExpenseInput | null;
  shipmentInput: ElogiShipmentInsertInput | null;
}

function isValidDateStr(y: number, m: number, d: number, currentYear: number): boolean {
  return y >= 2000 && y <= currentYear + 1 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

const CURRENT_YEAR = new Date().getFullYear();

/** 「2026/8/28」のようなYYYY/M/D形式(ゼロ埋めなし)の日付文字列をYYYY-MM-DDに変換する。 */
function parseSlashDate(raw: string | null): { date: string | null; error: string | null } {
  if (!raw) {
    return { date: null, error: "ラベル印刷日が空欄です" };
  }
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(raw);
  if (!m) {
    return { date: null, error: `ラベル印刷日の形式が不正です(値: "${raw}")。YYYY/M/D形式である必要があります` };
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!isValidDateStr(year, month, day, CURRENT_YEAR)) {
    return { date: null, error: `ラベル印刷日の値が不自然です(値: "${raw}")` };
  }
  return { date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, error: null };
}

function parseAmount(raw: string | null): number | null {
  if (raw == null) return null;
  const s = raw.trim().replace(/,/g, "");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * 1行分の生データを、DB投入用の形式に変換・検証する(同期処理のみ、DBアクセスなし)。
 * 重複判定(既存invoice_id_initialとの照合)は別関数(findExistingElogiInvoiceIds)で行う。
 */
export function mapElogiRawRow(raw: ElogiRawRow, fileName: string | null): MappedElogiRow {
  const errors: string[] = [];
  const warnings: string[] = [];

  const invoiceIdInitial = raw.invoiceIdInitial;
  if (!invoiceIdInitial) {
    errors.push("請求書ID(初回注文)が空欄です(重複判定・記録用キーとして必須です)");
  }

  const { date: labelPrintDate, error: dateError } = parseSlashDate(raw.labelPrintDateRaw);
  if (dateError) errors.push(dateError);

  const initialAmount = parseAmount(raw.initialAmountRaw);
  if (initialAmount == null) {
    errors.push(`初回請求金額が数値として読み取れません(値: "${raw.initialAmountRaw ?? ""}")`);
  }

  let additionalAmount = 0;
  if (raw.additionalAmountRaw != null && raw.additionalAmountRaw.trim() !== "") {
    const parsed = parseAmount(raw.additionalAmountRaw);
    if (parsed == null) {
      errors.push(`追加請求/返金金額が数値として読み取れません(値: "${raw.additionalAmountRaw}")`);
    } else {
      additionalAmount = parsed;
    }
  }

  if (!raw.ebayOrderNumber) {
    warnings.push("eBayオーダー番号が空欄です(eLogi外の手動発送などの可能性があります)");
  }
  if (!raw.accountType) {
    warnings.push("アカウント種類が空欄です");
  }

  const hasErrors = errors.length > 0;
  const totalAmount = hasErrors || initialAmount == null ? null : initialAmount + additionalAmount;

  const descriptionParts = [
    raw.ebayOrderNumber ? `eBay注文: ${raw.ebayOrderNumber}` : null,
    raw.trackingNumber ? `追跡番号: ${raw.trackingNumber}` : null,
  ].filter((s): s is string => !!s);

  const expenseInput: ExpenseInput | null =
    hasErrors || !labelPrintDate || totalAmount == null
      ? null
      : {
          expense_date: labelPrintDate,
          category: "送料",
          vendor: "eLogi",
          description: descriptionParts.length > 0 ? descriptionParts.join(" / ") : undefined,
          amount: totalAmount,
          // 国際輸送(海外への貨物輸送)は消費税法上「輸出免税等」に該当し、原則として運送事業者側は
          // 消費税を課さないため、デフォルトを「不課税」とする(ユーザー指示、2026-09-01)。
          tax_category: "不課税",
          source: "elogi_import",
        };

  const shipmentInput: ElogiShipmentInsertInput | null =
    hasErrors || !invoiceIdInitial || !labelPrintDate || initialAmount == null
      ? null
      : {
          invoice_id_initial: invoiceIdInitial,
          invoice_id_additional: raw.invoiceIdAdditional,
          label_print_date: labelPrintDate,
          tracking_number: raw.trackingNumber,
          buyer_id: raw.buyerId,
          ebay_order_number: raw.ebayOrderNumber,
          account_type: raw.accountType,
          initial_amount: initialAmount,
          additional_amount: additionalAmount,
          raw_file_reference: fileName,
        };

  return {
    raw,
    rowNumber: raw.rowNumber,
    invoiceIdInitial,
    outcome: hasErrors ? "error" : "new",
    errors,
    warnings,
    totalAmount,
    expenseInput,
    shipmentInput,
  };
}

/** 取込対象候補のinvoice_id_initialのうち、既にDBに存在するものを調べる(重複判定用)。 */
export async function findExistingElogiInvoiceIds(invoiceIds: string[]): Promise<Set<string>> {
  if (invoiceIds.length === 0) return new Set();
  const uniqueIds = Array.from(new Set(invoiceIds));
  const CHUNK = 200;
  const found = new Set<string>();
  for (let i = 0; i < uniqueIds.length; i += CHUNK) {
    const chunk = uniqueIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("elogi_shipments")
      .select("invoice_id_initial")
      .in("invoice_id_initial", chunk);
    if (error) throw error;
    for (const row of data ?? []) {
      found.add((row as { invoice_id_initial: string }).invoice_id_initial);
    }
  }
  return found;
}

/** 取込候補内(バッチ内)で請求書ID(初回注文)が重複している行を検出し、2件目以降を重複扱いにする。 */
export function markInBatchDuplicateElogiRows(rows: MappedElogiRow[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.outcome !== "new" || !row.invoiceIdInitial) continue;
    if (seen.has(row.invoiceIdInitial)) {
      row.outcome = "duplicate";
      row.warnings.push("この取込データ内で請求書ID(初回注文)が重複しています(先に出てきた行のみ取込対象とします)");
    } else {
      seen.add(row.invoiceIdInitial);
    }
  }
}

export interface ElogiExecuteResult {
  rowNumber: number;
  invoiceIdInitial: string | null;
  success: boolean;
  skipped?: boolean;
  message: string;
}

/** 1行分を実際にDBへ取り込む(expenses作成 → elogi_shipments作成、expense_idで紐付け)。 */
export async function executeElogiImportRow(row: MappedElogiRow): Promise<ElogiExecuteResult> {
  if (!row.expenseInput || !row.shipmentInput) {
    return { rowNumber: row.rowNumber, invoiceIdInitial: row.invoiceIdInitial, success: false, message: "取込対象外の行です" };
  }
  try {
    const expense = await createExpense(row.expenseInput);

    const { error: shipmentError } = await supabase.from("elogi_shipments").insert({
      ...row.shipmentInput,
      expense_id: expense.id,
    });
    if (shipmentError) {
      return {
        rowNumber: row.rowNumber,
        invoiceIdInitial: row.invoiceIdInitial,
        success: false,
        message: `経費(送料)は登録しましたが、記録用データ(elogi_shipments)の保存に失敗しました: ${shipmentError.message}`,
      };
    }

    return { rowNumber: row.rowNumber, invoiceIdInitial: row.invoiceIdInitial, success: true, message: "取込完了" };
  } catch (err) {
    const message = err instanceof Error ? err.message : "不明なエラー";
    return { rowNumber: row.rowNumber, invoiceIdInitial: row.invoiceIdInitial, success: false, message };
  }
}
