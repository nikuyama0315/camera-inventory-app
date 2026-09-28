import { supabase } from "../supabaseClient";

/** eBay Negotiation APIで検知され、まだオファー未送信のSend Offer対象商品数を取得する。
 * 実際の一覧・送信画面はマーケティング(ebay-automation)側の/send-offersにあり、
 * ここでは画面上部バナー表示用の件数のみを取得する。 */
export async function fetchSendOfferPendingCount(): Promise<number> {
  const { count, error } = await supabase
    .from("send_offer_eligible_items")
    .select("item_id", { count: "exact", head: true })
    .is("offer_sent_at", null);
  if (error) throw error;
  return count ?? 0;
}
