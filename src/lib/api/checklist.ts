import { supabase } from "../supabaseClient";

export interface ChecklistType {
  id: string;
  name: string;
  source_url: string | null;
  storage_folder_url: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface ChecklistCheck {
  id: string;
  type_id: string;
  year_month: string; // "YYYY-MM"
  checked: boolean;
  checked_at: string | null;
}

export async function fetchChecklistTypes(): Promise<ChecklistType[]> {
  const { data, error } = await supabase
    .from("checklist_types")
    .select("*")
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data as ChecklistType[];
}

export async function fetchChecklistChecks(): Promise<ChecklistCheck[]> {
  const { data, error } = await supabase.from("checklist_checks").select("*");
  if (error) throw error;
  return data as ChecklistCheck[];
}

async function nextChecklistTypeSortOrder(): Promise<number> {
  const { data, error } = await supabase
    .from("checklist_types")
    .select("sort_order")
    .order("sort_order", { ascending: false })
    .limit(1);
  if (error) throw error;
  const rows = data as { sort_order: number }[];
  return rows.length > 0 ? rows[0].sort_order + 1 : 0;
}

export async function createChecklistType(input: {
  name: string;
  source_url?: string | null;
  storage_folder_url?: string | null;
}): Promise<ChecklistType> {
  const sortOrder = await nextChecklistTypeSortOrder();
  const { data, error } = await supabase
    .from("checklist_types")
    .insert({
      name: input.name,
      source_url: input.source_url || null,
      storage_folder_url: input.storage_folder_url || null,
      sort_order: sortOrder,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as ChecklistType;
}

export async function updateChecklistType(
  id: string,
  patch: { name?: string; source_url?: string | null; storage_folder_url?: string | null },
): Promise<void> {
  const { error } = await supabase
    .from("checklist_types")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

export async function deleteChecklistType(id: string): Promise<void> {
  const { error } = await supabase.from("checklist_types").delete().eq("id", id);
  if (error) throw error;
}

/** 指定した種別・年月のチェック状態を保存する(既存行があれば更新、無ければ新規作成)。 */
export async function setChecklistChecked(typeId: string, yearMonth: string, checked: boolean): Promise<void> {
  const { error } = await supabase
    .from("checklist_checks")
    .upsert(
      { type_id: typeId, year_month: yearMonth, checked, checked_at: checked ? new Date().toISOString() : null },
      { onConflict: "type_id,year_month" },
    );
  if (error) throw error;
}

/** 当年1月〜前月の年月一覧を返す(レポート取込状況の月範囲ロジックと同じ)。1月時点では空配列になる。 */
export function checklistMonthRange(now: Date = new Date()): string[] {
  const currentYear = now.getFullYear();
  const months: string[] = [];
  for (let m = 1; m <= now.getMonth(); m++) {
    months.push(`${currentYear}-${String(m).padStart(2, "0")}`);
  }
  return months;
}

/**
 * 各月7日以降、前月分のチェックがまだ付いていない種別に警告を出す
 * (レポート取込状況のreportImportRowHasAlert()と同じ基準)。
 */
export function checklistTypeHasAlert(
  typeId: string,
  checks: ChecklistCheck[],
  months: string[],
  today: Date = new Date(),
): boolean {
  const previousMonth = months[months.length - 1];
  if (!previousMonth || today.getDate() <= 6) return false;
  const check = checks.find((c) => c.type_id === typeId && c.year_month === previousMonth);
  return !check?.checked;
}
