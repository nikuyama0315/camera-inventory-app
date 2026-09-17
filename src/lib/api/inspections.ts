import { supabase } from "../supabaseClient";
import type { Inspection } from "../types";

export type InspectionInput = Omit<Inspection, "id" | "inspected_at">;

export async function saveInspection(input: InspectionInput): Promise<Inspection> {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data, error } = await supabase
    .from("inspections")
    .insert({ ...input, inspected_by: user?.id ?? null })
    .select()
    .single();

  if (error) throw error;
  return data as Inspection;
}

export async function updateInspection(
  inspectionId: string,
  patch: Partial<InspectionInput>,
): Promise<Inspection> {
  const { data, error } = await supabase
    .from("inspections")
    .update(patch)
    .eq("id", inspectionId)
    .select()
    .single();

  if (error) throw error;
  return data as Inspection;
}

export async function translateInspectionField(
  text: string,
  field: string,
): Promise<string> {
  const { data, error } = await supabase.functions.invoke("translate-inspection-field", {
    body: { text, field },
  });

  if (error) throw error;
  return (data as { translated_text: string }).translated_text;
}

/** 検品タブの自由記述項目(日本語・英訳の両方、2026-09-16に英訳欄も対象に追加)。 */
const CANDIDATE_FIELDS = [
  "overall_notes",
  "overall_notes_en",
  "appearance_notes",
  "appearance_notes_en",
  "electrical_notes",
  "electrical_notes_en",
  "shutter_notes",
  "shutter_notes_en",
  "aperture_exposure_notes",
  "aperture_exposure_notes_en",
  "film_transport_notes",
  "film_transport_notes_en",
  "viewfinder_notes",
  "viewfinder_notes_en",
  "lens_notes",
  "lens_notes_en",
  "other_notes",
  "other_notes_en",
  "flash_notes",
  "flash_notes_en",
  "autofocus_notes",
  "autofocus_notes_en",
  "zoom_notes",
  "zoom_notes_en",
  "film_counter_notes",
  "film_counter_notes_en",
  "self_timer_notes",
  "self_timer_notes_en",
] as const;

export type InspectionFieldCandidates = Record<string, string[]>;

/**
 * 検品タブの各項目について、過去に入力された値を出現頻度順の候補として取得する
 * (2026-09-16追加、ユーザー指示「検品画面で入力した項目を記録しておき、新規入力時に候補表示」)。
 * inspectionsテーブルは現状小規模(2026-09-16時点で291件程度)なため、全件取得してクライアント側で
 * 集計する(件数が今後大きく増えた場合は要見直し)。各項目、頻度上位30件までを候補として返す。
 */
export async function fetchInspectionFieldCandidates(): Promise<InspectionFieldCandidates> {
  const { data, error } = await supabase.from("inspections").select(CANDIDATE_FIELDS.join(", "));
  if (error) throw error;

  const counts: Record<string, Map<string, number>> = {};
  for (const field of CANDIDATE_FIELDS) counts[field] = new Map();

  for (const row of (data ?? []) as unknown as Record<string, string | null>[]) {
    for (const field of CANDIDATE_FIELDS) {
      const value = (row[field] ?? "").trim();
      if (!value) continue;
      const map = counts[field];
      map.set(value, (map.get(value) ?? 0) + 1);
    }
  }

  const result: InspectionFieldCandidates = {};
  for (const field of CANDIDATE_FIELDS) {
    result[field] = Array.from(counts[field].entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([value]) => value);
  }
  return result;
}
