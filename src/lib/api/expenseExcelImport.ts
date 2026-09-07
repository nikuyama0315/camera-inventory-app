import { supabase } from "../supabaseClient";
import { createExpense, type ExpenseInput, type TaxCategory } from "./expenses";

/**
 * 経費エクセル(消耗品/送料/通信費等/支払報酬/支払手数料/交際費シート)から
 * expensesテーブルへの一括取込ロジック。2026-08-29 時点でユーザー指定の列範囲に基づく。
 */

export interface SheetColumnConfig {
  sheetName: string;
  category: string; // expenses.category / EXPENSE_CATEGORIES と一致させる値
  dateCol: number;
  vendorCol: number;
  amountCol: number;
  // 内容を直接持つシート(消耗品・交際費)用
  descCol?: number;
  // 種別/対象期間/追跡番号から内容を組み立てるシート用
  typeCol?: number;
  periodCol?: number;
  trackingCol?: number;
  // 通信費等シートのみ: '〇'なら課税、空欄なら不課税
  taxMarkCol?: number;
  invoiceCol?: number;
}

export const SHEET_CONFIGS: SheetColumnConfig[] = [
  { sheetName: "消耗品", category: "消耗品", dateCol: 1, vendorCol: 2, amountCol: 3, descCol: 4, invoiceCol: 5 },
  { sheetName: "送料", category: "送料", dateCol: 1, vendorCol: 2, trackingCol: 3, typeCol: 4, amountCol: 5, invoiceCol: 6 },
  {
    sheetName: "通信費等",
    category: "通信費",
    dateCol: 1,
    vendorCol: 2,
    typeCol: 3,
    periodCol: 4,
    amountCol: 5,
    taxMarkCol: 6,
    invoiceCol: 7,
  },
  { sheetName: "支払報酬", category: "支払報酬", dateCol: 1, vendorCol: 2, typeCol: 3, periodCol: 4, amountCol: 5, invoiceCol: 6 },
  { sheetName: "支払手数料", category: "支払手数料", dateCol: 1, vendorCol: 2, typeCol: 3, periodCol: 4, amountCol: 5, invoiceCol: 6 },
  { sheetName: "交際費", category: "交際費", dateCol: 1, vendorCol: 2, amountCol: 3, descCol: 4, invoiceCol: 5 },
];

export interface ExpenseRawRow {
  sheetName: string;
  rowNumber: number; // シート内の行番号(1始まり、エクセル実物の行に対応)
  category: string;
  dateRaw: unknown;
  vendor: string | null;
  amountRaw: unknown;
  description: string | null;
  taxCategory: TaxCategory;
  invoiceRegistrationNo: string | null;
}

export type ImportRowOutcome = "new" | "duplicate" | "error";

export interface MappedExpenseRow {
  raw: ExpenseRawRow;
  rowId: string; // `${sheetName}#${rowNumber}` (React key・実行結果の紐付け用)
  outcome: ImportRowOutcome;
  errors: string[];
  warnings: string[];
  input: ExpenseInput | null;
}

function toStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function isValidDate(d: unknown): d is Date {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const CURRENT_YEAR = new Date().getFullYear();

/** 「20260102」のようなYYYYMMDD形式の数値、または実際の日付セルの両方に対応する。 */
function parseExpenseDate(raw: unknown): { date: string | null; error: string | null } {
  if (isValidDate(raw)) {
    if (raw.getFullYear() < 2000 || raw.getFullYear() > CURRENT_YEAR + 1) {
      return { date: null, error: `領収日の年が不自然です(${raw.getFullYear()}年)` };
    }
    return { date: formatDate(raw), error: null };
  }
  if (typeof raw === "number" && Number.isInteger(raw)) {
    const s = String(raw);
    const match = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
    if (!match) {
      return { date: null, error: `領収日の形式が不正です(値: ${raw})。YYYYMMDD形式である必要があります` };
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (year < 2000 || year > CURRENT_YEAR + 1 || month < 1 || month > 12 || day < 1 || day > 31) {
      return { date: null, error: `領収日の値が不正です(値: ${raw})` };
    }
    return { date: `${match[1]}-${match[2]}-${match[3]}`, error: null };
  }
  return { date: null, error: `領収日が日付形式ではありません(値: ${JSON.stringify(raw)})` };
}

function parseAmount(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  return null;
}

/** 1行分の生データを検証し、DB投入用の形式に変換する(同期処理のみ、DBアクセスなし)。 */
export function mapExpenseRawRow(raw: ExpenseRawRow): MappedExpenseRow {
  const errors: string[] = [];
  const warnings: string[] = [];
  const rowId = `${raw.sheetName}#${raw.rowNumber}`;

  const { date, error: dateError } = parseExpenseDate(raw.dateRaw);
  if (dateError) errors.push(dateError);

  const amount = parseAmount(raw.amountRaw);
  if (amount == null) {
    errors.push(`金額が数値として読み取れません(値: ${JSON.stringify(raw.amountRaw)})`);
  }

  if (!raw.vendor) {
    warnings.push("事業者名が空欄です");
  }
  if (!raw.description) {
    warnings.push("内容が空欄です");
  }

  const hasErrors = errors.length > 0;

  const input: ExpenseInput | null =
    hasErrors || !date || amount == null
      ? null
      : {
          expense_date: date,
          category: raw.category,
          vendor: raw.vendor ?? undefined,
          description: raw.description ?? undefined,
          amount,
          tax_category: raw.taxCategory,
          invoice_registration_no: raw.invoiceRegistrationNo ?? undefined,
          source: "excel_import",
        };

  return {
    raw,
    rowId,
    outcome: hasErrors ? "error" : "new",
    errors,
    warnings,
    input,
  };
}

/** 重複判定用の自然キー(領収日・カテゴリ・事業者・金額・内容の組み合わせ)。 */
export function buildExpenseKey(
  expenseDate: string,
  category: string,
  vendor: string | null | undefined,
  amount: number,
  description: string | null | undefined,
): string {
  return `${expenseDate}|${category}|${vendor ?? ""}|${amount}|${description ?? ""}`;
}

/** 既存のexpenses全件から自然キーの集合を取得する(重複判定用)。 */
export async function findExistingExpenseKeys(): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("expenses")
    .select("expense_date,category,vendor,amount,description");
  if (error) throw error;
  const set = new Set<string>();
  for (const row of data ?? []) {
    const r = row as { expense_date: string; category: string; vendor: string | null; amount: number; description: string | null };
    set.add(buildExpenseKey(r.expense_date, r.category, r.vendor, r.amount, r.description));
  }
  return set;
}

/** 取込候補内(バッチ内)で自然キーが重複している行を検出し、2件目以降を重複扱いにする。 */
export function markInBatchDuplicateExpenses(rows: MappedExpenseRow[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.outcome !== "new" || !row.input) continue;
    const key = buildExpenseKey(
      row.input.expense_date,
      row.input.category,
      row.input.vendor,
      row.input.amount,
      row.input.description,
    );
    if (seen.has(key)) {
      row.outcome = "duplicate";
      row.warnings.push("この取込データ内に同じ内容の行が複数あります(2件目以降を重複として表示していますが、取込実行時はこれらの行も含めてすべて取り込まれます)");
    } else {
      seen.add(key);
    }
  }
}

export interface ExpenseExecuteResult {
  rowId: string;
  success: boolean;
  message: string;
}

/** 1行分を実際にDBへ取り込む。 */
export async function executeExpenseImportRow(row: MappedExpenseRow): Promise<ExpenseExecuteResult> {
  if (!row.input) {
    return { rowId: row.rowId, success: false, message: "取込対象外の行です" };
  }
  try {
    await createExpense(row.input);
    return { rowId: row.rowId, success: true, message: "取込完了" };
  } catch (err) {
    const message = err instanceof Error ? err.message : "不明なエラー";
    return { rowId: row.rowId, success: false, message };
  }
}
