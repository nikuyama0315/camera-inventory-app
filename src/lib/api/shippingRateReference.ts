import { supabase } from "../supabaseClient";

export interface ShippingRateReferenceRow {
  id: number;
  brand: string;
  model: string;
  shipping_service: string;
  service_type: string;
  incoterms: string;
  package_type: string;
  dimension_1_cm: number | null;
  dimension_2_cm: number | null;
  dimension_3_cm: number | null;
  chargeable_weight_kg: number | null;
  amount_paid_jpy: number | null;
  duty_vat_other_jpy: number | null;
  destination_country: string | null;
  ship_to: string | null;
}

export type ShippingRateReferenceInput = Omit<ShippingRateReferenceRow, "id">;

/**
 * 送料設定早見表(2026-10-01新規)。CPaSSの実績データ(ユーザー提供エクセル242行)を
 * 元に、ブランド〜重量までの条件から実際に支払った送料(amount_paid_jpy)を検索する機能、
 * および同データを画面上で追加・編集・削除できるようにするためのAPI。
 */
export async function fetchShippingRateReference(): Promise<ShippingRateReferenceRow[]> {
  const { data, error } = await supabase
    .from("shipping_rate_reference")
    .select("*")
    .order("brand")
    .order("model");
  if (error) throw error;
  return data as ShippingRateReferenceRow[];
}

export async function createShippingRateReference(
  input: ShippingRateReferenceInput,
): Promise<ShippingRateReferenceRow> {
  const { data, error } = await supabase
    .from("shipping_rate_reference")
    .insert(input)
    .select()
    .single();
  if (error) throw error;
  return data as ShippingRateReferenceRow;
}

export async function updateShippingRateReference(
  id: number,
  input: ShippingRateReferenceInput,
): Promise<void> {
  const { error } = await supabase
    .from("shipping_rate_reference")
    .update({ ...input, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

export async function deleteShippingRateReference(id: number): Promise<void> {
  const { error } = await supabase.from("shipping_rate_reference").delete().eq("id", id);
  if (error) throw error;
}
