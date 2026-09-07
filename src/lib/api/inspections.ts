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
