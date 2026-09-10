import { supabase } from "../supabaseClient";
import type { ItemStatus } from "../types";

export interface SkuLookupRow {
  id: string;
  management_no: string;
  title: string | null;
  status: ItemStatus;
  drive_current_stage: string | null;
  drive_model_folder_name: string | null;
  drive_item_folder_name: string | null;
  drive_folder_path: string | null;
}

/**
 * Custom label(SKU)= items.management_no に対する部分一致検索。
 * eBayのTransaction Report等でCustom labelとして使われている文字列の一部を入力し、
 * 対応する商品の現在のステータス・Google Driveフォルダの所在ステージを確認する。
 */
export async function searchBySkuFragment(fragment: string): Promise<SkuLookupRow[]> {
  const trimmed = fragment.trim();
  if (!trimmed) return [];

  const { data, error } = await supabase
    .from("items")
    .select("id, management_no, title, status, item_drive_folders(current_stage, model_folder_name, item_folder_name, drive_folder_path)")
    .ilike("management_no", `%${trimmed}%`)
    .order("management_no", { ascending: false })
    .limit(50);

  if (error) throw error;

  return (data as unknown as Array<{
    id: string;
    management_no: string;
    title: string | null;
    status: ItemStatus;
    item_drive_folders: {
      current_stage: string | null;
      model_folder_name: string | null;
      item_folder_name: string | null;
      drive_folder_path: string | null;
    } | { current_stage: string | null; model_folder_name: string | null; item_folder_name: string | null; drive_folder_path: string | null }[] | null;
  }>).map((row) => {
    const folder = Array.isArray(row.item_drive_folders)
      ? row.item_drive_folders[0]
      : row.item_drive_folders;
    return {
      id: row.id,
      management_no: row.management_no,
      title: row.title,
      status: row.status,
      drive_current_stage: folder?.current_stage ?? null,
      drive_model_folder_name: folder?.model_folder_name ?? null,
      drive_item_folder_name: folder?.item_folder_name ?? null,
      drive_folder_path: folder?.drive_folder_path ?? null,
    };
  });
}

export interface EbayLiveSkuMatch {
  itemId: string;
  sku: string | null;
  soulcameraItemInfo: string | null;
  title: string | null;
  quantityAvailable: number;
  viewItemUrl: string | null;
  matchSource: "soulcamera_item_info" | "sku";
  matchedText: string;
}

/**
 * SKU検索「ライブ検索」(2026-09-10追加)。soulcameraアカウントのeBayアクティブ出品(USサイトのみ)を
 * 対象に、Item Specificsの「Soulcamera Item Info」があればそれを優先して検索対象文字列とし、
 * 無ければCustom Label(SKU)にフォールバックして、入力文字列の部分一致で検索する。
 * DBには保存されていない値のため、検索の都度eBay APIから取得する(ebay-sku-live-search Edge Function)。
 */
export async function searchEbayLiveBySkuFragment(fragment: string): Promise<EbayLiveSkuMatch[]> {
  const trimmed = fragment.trim();
  if (!trimmed) return [];

  const { data, error } = await supabase.functions.invoke("ebay-sku-live-search", {
    body: { query: trimmed },
  });
  if (error) throw error;
  if (data && typeof data === "object" && "error" in data && (data as { error?: unknown }).error) {
    throw new Error(String((data as { error: unknown }).error));
  }
  return (data as { matches: EbayLiveSkuMatch[] }).matches;
}
