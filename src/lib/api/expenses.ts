import { supabase } from "../supabaseClient";

export type TaxCategory = "課税" | "不課税";

export interface Expense {
  id: string;
  expense_date: string;
  category: string;
  vendor: string | null;
  description: string | null;
  amount: number;
  tax_category: TaxCategory;
  invoice_registration_no: string | null;
  receipt_folder_path: string | null;
  related_item_id: string | null;
  source: string;
  created_at: string;
}

export interface ExpenseInput {
  expense_date: string;
  category: string;
  vendor?: string;
  description?: string;
  amount: number;
  tax_category?: TaxCategory;
  invoice_registration_no?: string;
  receipt_folder_path?: string;
  related_item_id?: string;
  source?: string;
}

export interface ExpenseFilters {
  from?: string; // YYYY-MM-DD
  to?: string;
  category?: string;
  vendor?: string; // 部分一致(前方/中間/後方いずれもOK)
}

export const EXPENSE_CATEGORIES = [
  "消耗品",
  "送料",
  "通信費",
  "支払報酬",
  "支払手数料",
  "交際費",
  "広告宣伝費",
  "販売手数料",
  "その他",
];

export const TAX_CATEGORY_OPTIONS: TaxCategory[] = ["課税", "不課税"];

export async function fetchExpenses(filters: ExpenseFilters = {}): Promise<Expense[]> {
  let query = supabase.from("expenses").select("*").order("expense_date", { ascending: false });

  if (filters.from) query = query.gte("expense_date", filters.from);
  if (filters.to) query = query.lte("expense_date", filters.to);
  if (filters.category) query = query.eq("category", filters.category);
  if (filters.vendor) query = query.ilike("vendor", `%${filters.vendor}%`);

  const { data, error } = await query;
  if (error) throw error;
  return data as Expense[];
}

export async function createExpense(input: ExpenseInput): Promise<Expense> {
  const { data, error } = await supabase
    .from("expenses")
    .insert({
      expense_date: input.expense_date,
      category: input.category,
      vendor: input.vendor ?? null,
      description: input.description ?? null,
      amount: input.amount,
      tax_category: input.tax_category ?? "課税",
      invoice_registration_no: input.invoice_registration_no ?? null,
      receipt_folder_path: input.receipt_folder_path ?? null,
      related_item_id: input.related_item_id ?? null,
      source: input.source ?? "manual",
    })
    .select()
    .single();

  if (error) throw error;
  return data as Expense;
}

export async function updateExpense(id: string, input: ExpenseInput): Promise<Expense> {
  const { data, error } = await supabase
    .from("expenses")
    .update({
      expense_date: input.expense_date,
      category: input.category,
      vendor: input.vendor ?? null,
      description: input.description ?? null,
      amount: input.amount,
      tax_category: input.tax_category ?? "課税",
      invoice_registration_no: input.invoice_registration_no ?? null,
      receipt_folder_path: input.receipt_folder_path ?? null,
      related_item_id: input.related_item_id ?? null,
    })
    .eq("id", id)
    .select()
    .single();

  if (error) throw error;
  return data as Expense;
}

export async function deleteExpense(id: string): Promise<void> {
  const { error } = await supabase.from("expenses").delete().eq("id", id);
  if (error) throw error;
}

export async function getExpensesCount(): Promise<number> {
  const { count, error } = await supabase.from("expenses").select("id", { count: "exact", head: true });
  if (error) throw error;
  return count ?? 0;
}

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/** expensesテーブルの全レコードを削除する(在庫・仕入・売上データには影響しない)。 */
export async function clearAllExpenses(): Promise<void> {
  const { error } = await supabase.from("expenses").delete().neq("id", ZERO_UUID);
  if (error) throw error;
}
