import { supabase } from "../supabaseClient";
import type { ItemListingDraft, ListingPhoto } from "../types";

const LISTING_PHOTOS_BUCKET = "listing-photos";
/** 写真ドロップエリアの上限枚数(ユーザー指示)。 */
export const LISTING_PHOTOS_MAX_COUNT = 24;

export async function fetchListingDraft(itemId: string): Promise<ItemListingDraft | null> {
  const { data, error } = await supabase.from("item_listing_drafts").select("*").eq("item_id", itemId).maybeSingle();
  if (error) throw error;
  return data as ItemListingDraft | null;
}

/** 検品タブ「生成データ保存」ボタン用。4項目だけをupsertする(他の出品タブ項目には触れない)。 */
export async function saveGeneratedListingData(
  itemId: string,
  input: {
    item_title: string;
    soulcamera_item_info: string;
    description_html: string;
    seller_note_text: string;
  },
): Promise<void> {
  const { error } = await supabase.from("item_listing_drafts").upsert({ item_id: itemId, ...input });
  if (error) throw error;
}

/** 出品タブの「保存」ボタン用。渡されたフィールドだけをupsertする。 */
export async function upsertListingDraft(itemId: string, patch: Partial<ItemListingDraft>): Promise<void> {
  const { error } = await supabase.from("item_listing_drafts").upsert({ item_id: itemId, ...patch });
  if (error) throw error;
}

function extFromFileName(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot === -1 || dot === name.length - 1) return "jpg";
  return name.slice(dot + 1).toLowerCase();
}

/** 写真ドロップエリア用。Supabase Storage(listing-photosバケット、公開)へアップロードし、
 *  eBayのPictureURLにそのまま渡せる公開URLを返す。 */
export async function uploadListingPhoto(itemId: string, file: File): Promise<ListingPhoto> {
  const ext = extFromFileName(file.name);
  const path = `${itemId}/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from(LISTING_PHOTOS_BUCKET).upload(path, file, { upsert: false });
  if (error) throw error;
  const { data } = supabase.storage.from(LISTING_PHOTOS_BUCKET).getPublicUrl(path);
  return { path, url: data.publicUrl };
}

export async function deleteListingPhoto(path: string): Promise<void> {
  const { error } = await supabase.storage.from(LISTING_PHOTOS_BUCKET).remove([path]);
  if (error) throw error;
}

export interface ItemSpecificsSampleResult {
  itemSpecificsText: string;
  itemPrice: string | null;
  sourceItemId: string;
  sourceOrderNumber: string | null;
  sourceItemTitle: string | null;
}

/** 「Item specifics」欄の「サンプルデータ取得」ボタン用。直近の販売済みデータ(ebay_transaction_lines)
 *  からタイトルが一致するものを探し、そのeBay ItemIDのItem SpecificsをGetItemで取得する。 */
export async function fetchItemSpecificsSample(
  query: string,
  shopId: "soulcamera" | "soulmenjapan",
): Promise<ItemSpecificsSampleResult> {
  const { data, error } = await supabase.functions.invoke("listing-item-specifics-lookup", {
    body: { query, shopId },
  });
  if (error) throw error;
  if (!data || typeof data !== "object" || "error" in data) {
    throw new Error((data as { error?: string })?.error ?? "サンプルデータの取得に失敗しました");
  }
  return data as ItemSpecificsSampleResult;
}

export interface PublishListingResult {
  success: boolean;
  ebayItemId?: string;
  error?: string;
}

/** 「出品する」ボタン用。Edge Function経由でeBay Trading API AddFixedPriceItemを実行する。 */
export async function publishListing(
  itemId: string,
  shopId: "soulcamera" | "soulmenjapan",
): Promise<PublishListingResult> {
  const { data, error } = await supabase.functions.invoke("listing-publish", {
    body: { itemId, shopId },
  });
  if (error) throw error;
  return data as PublishListingResult;
}
