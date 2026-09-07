import { supabase } from "../supabaseClient";
import type { CounterpartyType } from "../taxDeduction";

export interface CreateItemWithPurchaseInput {
  purchase_date: string;
  source_type: string;
  source_name?: string;
  source_url?: string;
  purchase_price: number;
  quantity?: number;
  category: string;
  brand?: string;
  model?: string;
  serial_number?: string;
  management_no: string;
  title?: string;
  is_used_goods: boolean;
  counterparty_type: CounterpartyType;
}

export interface CreateItemWithPurchaseResult {
  item_id: string;
  management_no: string;
}

/** 管理番号の初期候補を取得する(検品日=登録日ベースのYYMMDD-XX形式)。取得後は自由に編集可能。 */
export async function suggestManagementNo(baseDate: string): Promise<string> {
  const { data, error } = await supabase.rpc("generate_management_no", {
    p_base_date: baseDate,
  });
  if (error) throw error;
  return data as string;
}

/** 基本情報タブでの新古判定(is_used_goods)の編集 */
export async function updatePurchaseIsUsedGoods(purchaseId: string, isUsedGoods: boolean): Promise<void> {
  const { error } = await supabase.from("purchases").update({ is_used_goods: isUsedGoods }).eq("id", purchaseId);
  if (error) throw error;
}

export interface PurchasePatch {
  purchase_date?: string;
  source_type?: string;
  source_name?: string | null;
  source_url?: string | null;
  purchase_price?: number;
  quantity?: number;
  is_used_goods?: boolean;
  counterparty_type?: CounterpartyType;
  notes?: string | null;
}

/** 基本情報タブでの仕入情報全般の編集(仕入日・仕入先・仕入高・数量・新古判定) */
export async function updatePurchase(purchaseId: string, patch: PurchasePatch): Promise<void> {
  const { error } = await supabase.from("purchases").update(patch).eq("id", purchaseId);
  if (error) throw error;
}

export async function createItemWithPurchase(
  input: CreateItemWithPurchaseInput,
): Promise<CreateItemWithPurchaseResult> {
  const { data, error } = await supabase.rpc("create_item_with_purchase", {
    p_purchase_date: input.purchase_date,
    p_source_type: input.source_type,
    p_source_name: input.source_name ?? null,
    p_source_url: input.source_url ?? null,
    p_purchase_price: input.purchase_price,
    p_quantity: input.quantity ?? 1,
    p_category: input.category,
    p_brand: input.brand ?? null,
    p_model: input.model ?? null,
    p_serial_number: input.serial_number ?? null,
    p_management_no: input.management_no,
    p_title: input.title ?? null,
    p_is_used_goods: input.is_used_goods,
    p_counterparty_type: input.counterparty_type,
  });

  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row as CreateItemWithPurchaseResult;
}
