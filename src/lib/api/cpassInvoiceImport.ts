import { supabase } from "../supabaseClient";
import { createExpense, type ExpenseInput } from "./expenses";

/**
 * CPaSS(eBay公式クロスボーダー配送ツール)の請求明細(InvoiceDetails、xlsx)から、
 * 送料の経費計上を行うための一括取込ロジック。2026-08-31 ユーザー指示により追加。
 *
 * 従来の「CPaSS配送情報を取り込む」機能(売上・粗利タブ、cpassImport.ts)はCPaSSの
 * 配送実績エクスポート(追跡番号・配送業者等、Sheet0形式、47列)を取り込むもので、
 * 本モジュールが対象とする請求明細エクスポート(invoice period/order no/fee type/amount等、10列)
 * とはファイル形式・目的ともに別物(こちらは金額の請求内訳)。両機能は独立して共存する。
 *
 * 【会計データとして使う項目】
 * ・invoice period(例: "20260401-20260407"、週単位の請求期間)の終了日 → expenses.expense_date として使用
 *   (2026-08-31ユーザー確認: 開始日ではなく終了日を採用)
 * ・amount(行ごとの請求額) → expenses.amount として使用
 *   (同一invoice period内の全行のamount合計は、同じ行に繰り返し記載されているinvoice amount列と
 *   一致することを実データで検証済み。invoice amount自体は経費計上には使わず、参考値として保持するのみ)
 *
 * 【記録用に保管する項目】
 * order no(販売済み商品の追跡情報と紐づく値、とのユーザー説明)は、経費本体(expenses)には持たせず、
 * 専用テーブル cpass_invoice_charges に生値のまま保管し、作成したexpensesレコードのidをexpense_idで
 * 紐付ける(eLogi送料取込 elogiShippingImport.ts と同じ設計パターン)。fee type・charge typeは
 * 経費の内容(description)にも含める(何の費用かを示す情報のため)。
 *
 * 【重複判定】
 * order noだけでは自然キーにならない(同じorder noに運送料金・燃料割増金など複数のfee typeの行が
 * 存在し、さらに調整後の請求として同一order no・fee typeの行が後日追加されることをある)。実データで
 * (order_no, fee_type, charge_type, transaction_time)の組み合わせが全623行で完全に一意であることを
 * 確認したため、この4項目の組み合わせを自然キー(cpass_invoice_charges側はUNIQUE制約)として使う。
 */

// xlsxの列番号(1始まり)。「InvoiceDetails」エクスポートのヘッダー行で確認済み。
const COL = {
  invoicePeriod: 1, // invoice period
  invoiceAmount: 2, // invoice amount
  currency: 3, // currency
  orderNo: 4, // order no
  feeType: 5, // fee type
  chargeType: 6, // charge type
  taxRate: 7, // tax(%)
  amount: 8, // amount
  transactionTime: 9, // transaction time
  remark: 10, // remark
};

export interface CpassInvoiceRawRow {
  rowNumber: number; // シート実物の行番号(ヘッダーが1行目、データは2行目〜)
  invoicePeriodRaw: string | null;
  invoiceAmountRaw: string | null;
  currency: string | null;
  orderNo: string | null;
  feeType: string | null;
  chargeType: string | null;
  taxRaw: string | null;
  amountRaw: string | null;
  transactionTimeRaw: string | null;
  remark: string | null;
}

function cell(row: unknown[], colNumber1Indexed: number): unknown {
  const v = row[colNumber1Indexed - 1];
  return v === undefined ? null : v;
}

function toStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/**
 * CPaSS請求明細xlsx(SheetJSでheader:1変換した生の行配列、1行目はヘッダー)から
 * CpassInvoiceRawRow配列を組み立てる。ヘッダーが想定と異なる場合はエラーを投げる。
 */
export function buildCpassInvoiceRawRows(rows: unknown[][]): CpassInvoiceRawRow[] {
  if (rows.length === 0) {
    throw new Error("ファイルにデータがありません");
  }
  const header = rows[0];
  const headerCol1 = (toStr(header[COL.invoicePeriod - 1]) ?? "").toLowerCase();
  const headerCol4 = (toStr(header[COL.orderNo - 1]) ?? "").toLowerCase();
  if (!headerCol1.includes("invoice period") || !headerCol4.includes("order no")) {
    throw new Error(
      'ファイルのヘッダーが想定と異なります(1列目に"invoice period"、4列目に"order no"が含まれている必要があります)。CPaSSの請求明細(InvoiceDetails)エクスポートを選択してください',
    );
  }

  const result: CpassInvoiceRawRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every((c) => toStr(c) == null)) continue;
    result.push({
      rowNumber: i + 1,
      invoicePeriodRaw: toStr(cell(row, COL.invoicePeriod)),
      invoiceAmountRaw: toStr(cell(row, COL.invoiceAmount)),
      currency: toStr(cell(row, COL.currency)),
      orderNo: toStr(cell(row, COL.orderNo)),
      feeType: toStr(cell(row, COL.feeType)),
      chargeType: toStr(cell(row, COL.chargeType)),
      taxRaw: toStr(cell(row, COL.taxRate)),
      amountRaw: toStr(cell(row, COL.amount)),
      transactionTimeRaw: toStr(cell(row, COL.transactionTime)),
      remark: toStr(cell(row, COL.remark)),
    });
  }
  return result;
}

export type ImportRowOutcome = "new" | "duplicate" | "error";

/** cpass_invoice_chargesテーブルへの投入用データ(expense_idは実行時に作成したexpenses.idを設定する)。 */
export interface CpassInvoiceChargeInsertInput {
  invoice_period: string;
  invoice_period_start: string;
  invoice_period_end: string;
  invoice_amount: number | null;
  currency: string | null;
  order_no: string;
  fee_type: string | null;
  charge_type: string | null;
  tax_rate: number | null;
  amount: number;
  transaction_time: string | null;
  remark: string | null;
  raw_file_reference: string | null;
}

export interface MappedCpassInvoiceRow {
  raw: CpassInvoiceRawRow;
  rowNumber: number;
  chargeKey: string | null;
  outcome: ImportRowOutcome;
  errors: string[];
  warnings: string[];
  expenseInput: ExpenseInput | null;
  chargeInput: CpassInvoiceChargeInsertInput | null;
}

const CURRENT_YEAR = new Date().getFullYear();

/** 「20260401-20260407」形式(YYYYMMDD-YYYYMMDD)のinvoice periodを開始日・終了日(YYYY-MM-DD)に分解する。 */
function parsePeriod(raw: string | null): { start: string | null; end: string | null; error: string | null } {
  if (!raw) {
    return { start: null, end: null, error: "invoice periodが空欄です" };
  }
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if (!m) {
    return {
      start: null,
      end: null,
      error: `invoice periodの形式が不正です(値: "${raw}")。YYYYMMDD-YYYYMMDD形式である必要があります`,
    };
  }
  const startYear = Number(m[1]);
  const startMonth = Number(m[2]);
  const startDay = Number(m[3]);
  const endYear = Number(m[4]);
  const endMonth = Number(m[5]);
  const endDay = Number(m[6]);
  const inRange = (y: number) => y >= 2000 && y <= CURRENT_YEAR + 1;
  if (!inRange(startYear) || !inRange(endYear) || startMonth < 1 || startMonth > 12 || endMonth < 1 || endMonth > 12) {
    return { start: null, end: null, error: `invoice periodの値が不自然です(値: "${raw}")` };
  }
  return {
    start: `${startYear}-${String(startMonth).padStart(2, "0")}-${String(startDay).padStart(2, "0")}`,
    end: `${endYear}-${String(endMonth).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`,
    error: null,
  };
}

function parseAmount(raw: string | null): number | null {
  if (raw == null) return null;
  const s = raw.trim().replace(/,/g, "");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 重複判定用の自然キー((order_no, fee_type, charge_type, transaction_time)の組み合わせ)。 */
export function buildChargeKey(
  orderNo: string,
  feeType: string | null,
  chargeType: string | null,
  transactionTime: string | null,
): string {
  return `${orderNo}|${feeType ?? ""}|${chargeType ?? ""}|${transactionTime ?? ""}`;
}

/**
 * 1行分の生データを、DB投入用の形式に変換・検証する(同期処理のみ、DBアクセスなし)。
 * 重複判定(既存データとの照合)は別関数(findExistingCpassChargeKeys)で行う。
 */
export function mapCpassInvoiceRawRow(raw: CpassInvoiceRawRow, fileName: string | null): MappedCpassInvoiceRow {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!raw.orderNo) {
    errors.push("order noが空欄です(重複判定・記録用キーとして必須です)");
  }

  const { start, end, error: periodError } = parsePeriod(raw.invoicePeriodRaw);
  if (periodError) errors.push(periodError);

  const amount = parseAmount(raw.amountRaw);
  if (amount == null) {
    errors.push(`amountが数値として読み取れません(値: "${raw.amountRaw ?? ""}")`);
  }

  const invoiceAmount = parseAmount(raw.invoiceAmountRaw);
  const taxRate = parseAmount(raw.taxRaw);

  if (!raw.feeType) {
    warnings.push("fee typeが空欄です");
  }
  if (!raw.transactionTimeRaw) {
    warnings.push("transaction timeが空欄です(重複判定の精度が下がる可能性があります)");
  }

  const hasErrors = errors.length > 0;

  const chargeKey = raw.orderNo
    ? buildChargeKey(raw.orderNo, raw.feeType, raw.chargeType, raw.transactionTimeRaw)
    : null;

  const descriptionParts = [
    raw.orderNo ? `注文No: ${raw.orderNo}` : null,
    raw.feeType,
    raw.chargeType && raw.chargeType !== "引落金額" ? raw.chargeType : null,
  ].filter((s): s is string => !!s);

  const expenseInput: ExpenseInput | null =
    hasErrors || !end || amount == null
      ? null
      : {
          expense_date: end,
          category: "送料",
          vendor: "CPaSS",
          description: descriptionParts.length > 0 ? descriptionParts.join(" / ") : undefined,
          amount,
          // 国際輸送(海外への貨物輸送)は消費税法上「輸出免税等」に該当し、原則として運送事業者側は
          // 消費税を課さないため、デフォルトを「不課税」とする(ユーザー指示、2026-09-01)。
          tax_category: "不課税",
          source: "cpass_invoice_import",
        };

  const chargeInput: CpassInvoiceChargeInsertInput | null =
    hasErrors || !raw.orderNo || !start || !end || amount == null
      ? null
      : {
          invoice_period: raw.invoicePeriodRaw ?? "",
          invoice_period_start: start,
          invoice_period_end: end,
          invoice_amount: invoiceAmount,
          currency: raw.currency,
          order_no: raw.orderNo,
          fee_type: raw.feeType,
          charge_type: raw.chargeType,
          tax_rate: taxRate,
          amount,
          transaction_time: raw.transactionTimeRaw,
          remark: raw.remark,
          raw_file_reference: fileName,
        };

  return {
    raw,
    rowNumber: raw.rowNumber,
    chargeKey,
    outcome: hasErrors ? "error" : "new",
    errors,
    warnings,
    expenseInput,
    chargeInput,
  };
}

/** 取込対象候補のorder noのうち、既にDBに存在する行の自然キー集合を調べる(重複判定用)。 */
export async function findExistingCpassChargeKeys(orderNos: string[]): Promise<Set<string>> {
  if (orderNos.length === 0) return new Set();
  const uniqueOrderNos = Array.from(new Set(orderNos));
  const CHUNK = 200;
  const found = new Set<string>();
  for (let i = 0; i < uniqueOrderNos.length; i += CHUNK) {
    const chunk = uniqueOrderNos.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("cpass_invoice_charges")
      .select("order_no,fee_type,charge_type,transaction_time")
      .in("order_no", chunk);
    if (error) throw error;
    for (const row of data ?? []) {
      const r = row as {
        order_no: string;
        fee_type: string | null;
        charge_type: string | null;
        transaction_time: string | null;
      };
      found.add(buildChargeKey(r.order_no, r.fee_type, r.charge_type, r.transaction_time));
    }
  }
  return found;
}

/** 取込候補内(バッチ内)で自然キーが重複している行を検出し、2件目以降を重複扱いにする。 */
export function markInBatchDuplicateCpassRows(rows: MappedCpassInvoiceRow[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.outcome !== "new" || !row.chargeKey) continue;
    if (seen.has(row.chargeKey)) {
      row.outcome = "duplicate";
      row.warnings.push(
        "この取込データ内で(order no・fee type・charge type・transaction time)の組み合わせが重複しています(先に出てきた行のみ取込対象とします)",
      );
    } else {
      seen.add(row.chargeKey);
    }
  }
}

export interface CpassInvoiceExecuteResult {
  rowNumber: number;
  orderNo: string | null;
  success: boolean;
  skipped?: boolean;
  message: string;
}

/** 1行分を実際にDBへ取り込む(expenses作成 → cpass_invoice_charges作成、expense_idで紐付け)。 */
export async function executeCpassInvoiceImportRow(row: MappedCpassInvoiceRow): Promise<CpassInvoiceExecuteResult> {
  if (!row.expenseInput || !row.chargeInput) {
    return { rowNumber: row.rowNumber, orderNo: row.raw.orderNo, success: false, message: "取込対象外の行です" };
  }
  try {
    const expense = await createExpense(row.expenseInput);

    const { error: chargeError } = await supabase.from("cpass_invoice_charges").insert({
      ...row.chargeInput,
      expense_id: expense.id,
    });
    if (chargeError) {
      return {
        rowNumber: row.rowNumber,
        orderNo: row.raw.orderNo,
        success: false,
        message: `経費(送料)は登録しましたが、記録用データ(cpass_invoice_charges)の保存に失敗しました: ${chargeError.message}`,
      };
    }

    return { rowNumber: row.rowNumber, orderNo: row.raw.orderNo, success: true, message: "取込完了" };
  } catch (err) {
    const message = err instanceof Error ? err.message : "不明なエラー";
    return { rowNumber: row.rowNumber, orderNo: row.raw.orderNo, success: false, message };
  }
}
