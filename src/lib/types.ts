import type { Sale } from "./api/sales";

/**
 * eBayアカウント区分(2026-09-02追加)。soulcamera・soulmenjapanはライブAPI同期(ebay_credentials)を
 * 持つ実アカウント。'other'(その他)は、どちらのeBayアカウントにも該当しない売上・商品向けの分類。
 */
export type EbayAccount = "soulcamera" | "soulmenjapan" | "other";

export const EBAY_ACCOUNT_LABELS: Record<EbayAccount, string> = {
  soulcamera: "soulcamera",
  soulmenjapan: "soulmenjapan",
  other: "その他",
};

export const EBAY_ACCOUNT_OPTIONS: EbayAccount[] = ["soulcamera", "soulmenjapan", "other"];

/** ライブ同期(eBay Sell API呼び出し)で選択可能なアカウント。認証情報(ebay_credentials)を持つ2アカウントのみ。 */
export const EBAY_SYNC_SHOP_IDS: Array<"soulcamera" | "soulmenjapan"> = ["soulcamera", "soulmenjapan"];

export type ItemStatus =
  | "awaiting_arrival"
  | "awaiting_inspection"
  | "inspected_return_requested"
  | "inspected_returned"
  | "inspected_awaiting_listing"
  | "listed"
  | "sold"
  | "returned_item_received"
  | "on_hold";

export const ITEM_STATUS_LABELS: Record<ItemStatus, string> = {
  awaiting_arrival: "入荷待ち",
  awaiting_inspection: "着荷・検品待ち",
  inspected_return_requested: "検品済・返品依頼中",
  inspected_returned: "検品済・返品済",
  inspected_awaiting_listing: "検品済・出品待ち",
  listed: "出品中",
  sold: "販売済み",
  returned_item_received: "リターン受領品",
  // 2026-09-06追加。eBay側に情報が見つからない等、正常なステータス進行フローの外で一時的に保留する商品向け。
  // ADVANCE_STEPS(BasicInfoTab.tsx)には対応する遷移を定義していないため、専用ボタンからは遷移せず、
  // 「ステータス(修正用)」プルダウンでの手動設定のみが対象。
  on_hold: "保留",
};

export interface Item {
  id: string;
  management_no: string;
  category: string;
  brand: string | null;
  model: string | null;
  serial_number: string | null;
  /** シリアル番号(レンズ)。2026-09-22追加。 */
  lens_serial_number: string | null;
  /** タイプ(自由記述)。2026-09-22追加、機種名の下に表示。 */
  type: string | null;
  title: string | null;
  /** eBay等の出品タイトル(ITEM TITLE)。販売前の商品でも登録可能(半角換算80文字まで、UI側で検証)。2026-09-21追加。 */
  item_title: string | null;
  status: ItemStatus;
  created_at: string;
  updated_at: string;
  /** 直販プラットフォーム出品用のカテゴリ(film_camera/digital_camera/lens/accessory)。既存のcategory列とは別物。 */
  platform_category: string | null;
  /** 直販プラットフォーム出品用のグレード(top_mint/mint/near_mint/excellent/very_good/as-is/for_parts/junk)。 */
  grade: string | null;
  /** 直販プラットフォーム出品用の付属品(自由記述)。 */
  accessories_included: string | null;
  /** eBayアカウント区分(soulcamera/soulmenjapan/other)。未設定はnull。 */
  account: string | null;
}

export interface Purchase {
  id: string;
  item_id: string;
  purchase_date: string;
  source_type: string;
  source_name: string | null;
  source_url: string | null;
  purchase_price: number;
  quantity: number;
  is_used_goods: boolean;
  counterparty_type: "consumer" | "registered" | "unregistered";
  notes: string | null;
  created_at: string;
}

export interface Inspection {
  id: string;
  item_id: string;
  inspected_by: string | null;
  inspected_at: string;
  overall_notes: string | null;
  overall_notes_en: string | null;
  electrical_notes: string | null;
  electrical_notes_en: string | null;
  shutter_notes: string | null;
  shutter_notes_en: string | null;
  aperture_exposure_notes: string | null;
  aperture_exposure_notes_en: string | null;
  film_transport_notes: string | null;
  film_transport_notes_en: string | null;
  viewfinder_notes: string | null;
  viewfinder_notes_en: string | null;
  lens_notes: string | null;
  lens_notes_en: string | null;
  other_notes: string | null;
  other_notes_en: string | null;
  /** 検品項目「外観」の自由記述。直販プラットフォーム登録用CSVのcondition_description [Body]に使用。 */
  appearance_notes: string | null;
  appearance_notes_en: string | null;
  /** 検品項目「フラッシュ」「オートフォーカス」「ズーム」「フィルムカウンター」「セルフタイマー」の自由記述(2026-09-17追加)。 */
  flash_notes: string | null;
  flash_notes_en: string | null;
  autofocus_notes: string | null;
  autofocus_notes_en: string | null;
  zoom_notes: string | null;
  zoom_notes_en: string | null;
  film_counter_notes: string | null;
  film_counter_notes_en: string | null;
  self_timer_notes: string | null;
  self_timer_notes_en: string | null;
  condition_grade: string | null;
  /** 状態チェック表(2026-09-22追加)。各機能のOK/NG。未選択はnull。 */
  check_shutter: "ok" | "ng" | "na" | null;
  check_flash: "ok" | "ng" | "na" | null;
  check_autofocus: "ok" | "ng" | "na" | null;
  check_auto_exposure: "ok" | "ng" | "na" | null;
  check_film_winding: "ok" | "ng" | "na" | null;
  check_film_rewinding: "ok" | "ng" | "na" | null;
  check_film_counter: "ok" | "ng" | "na" | null;
  check_self_timer: "ok" | "ng" | "na" | null;
  /** 光学チェック表(レンズ/ファインダー、2026-09-22追加)。No/Few/Middle/Large。未選択はnull。 */
  optical_lens_dust: "none" | "few" | "middle" | "large" | null;
  optical_lens_fungus: "none" | "few" | "middle" | "large" | null;
  optical_lens_haze: "none" | "few" | "middle" | "large" | null;
  optical_lens_mark: "none" | "few" | "middle" | "large" | null;
  optical_finder_dust: "none" | "few" | "middle" | "large" | null;
  optical_finder_fungus: "none" | "few" | "middle" | "large" | null;
  optical_finder_haze: "none" | "few" | "middle" | "large" | null;
  optical_finder_mark: "none" | "few" | "middle" | "large" | null;
}

export interface ItemDriveFolder {
  id: string;
  item_id: string;
  drive_folder_path: string;
  model_folder_name: string | null;
  item_folder_name: string | null;
  drive_folder_id: string | null;
  current_stage: string | null;
  registered_at: string;
}

/**
 * 売上(sales)に結合するeBay取引明細(ebay_transaction_lines)の要約(2026-09-06追加、在庫タブ
 * 「詳細編集」→「販売」タブ表示用)。Ad Fee General(広告料)はこのテーブルには無く、
 * ebay_tax_invoice_linesをorder_number/item_id(=item_number)で別途集計する(fetchAdFeeForOrderItem参照)。
 */
export interface EbayTransactionLineDetail {
  order_number: string | null;
  transaction_date: string | null;
  sales_record_reference: string | null;
  custom_label: string | null;
  item_title: string | null;
  item_id: string | null;
  /** eBay買い手のユーザー名(2026-09-06追加)。90日より前に成立した過去の注文はeBay APIの仕様上
   *  再取得できないため、本機能追加前に同期済みの行は空欄のまま残る。 */
  buyer_username: string | null;
  buyer_country: string | null;
  item_subtotal: number | null;
  shipping_and_handling: number | null;
  final_value_fee: number | null;
  international_fee: number | null;
  /** 2026-09-06: transaction currency (e.g. "USD"/"EUR"/"GBP"). Non-USD amounts need exchange_rate applied for display. */
  transaction_currency: string | null;
  /** 2026-09-06: USD exchange rate at transaction time (1 when transaction_currency is USD). */
  exchange_rate: number | null;
}

export interface ItemDetail extends Item {
  purchases: Purchase[];
  inspections: Inspection[];
  item_drive_folders: ItemDriveFolder[];
  /** 各売上に、紐づくeBay取引明細(ebay_transaction_lines)を結合したもの(2026-09-03追加・2026-09-06拡張、
   *  読み取り専用表示用)。紐づく明細が無い(CSV/API未取込、または直接登録された売上)場合はnull。 */
  sales: (Sale & { ebay_transaction_lines: EbayTransactionLineDetail | null })[];
}

export interface ItemListFilters {
  /** "not_sold" は特殊な絞り込み条件で、ステータスが"sold"(販売済み)以外の全件を対象とする(個別のItemStatus値との完全一致ではない)。
   *  "sold_missing_shipping_tracking"も特殊な絞り込み条件で、ステータスが"sold"かつ、直近の売上(sales)の
   *  送料支払額(shipping_cost_paid)が未入力(0または未設定)か追跡番号(tracking_info)が未入力のもの
   *  (2026-09-10追加、ユーザー指示)。 */
  status?: ItemStatus | "not_sold" | "sold_missing_shipping_tracking";
  brand?: string;
  keyword?: string;
  /** 業務分類カテゴリ(items.category、カメラ関連品/雑貨/衣類など)での絞り込み(完全一致)。
   *  自由入力の文字列列でありDBにCHECK制約は無いため、固定の列挙型ではない。未指定なら絞り込まない。
   *  2026-09-06追加。 */
  category?: string;
  /** eBayアカウント区分での絞り込み(完全一致)。未指定なら絞り込まない。 */
  account?: string;
  /** 追跡番号(sales.tracking_info)での絞り込み(部分一致、2026-09-06追加)。指定時は売上(sales)が
   *  存在する商品のみが対象になる(該当する売上が無い商品は結果から除外される)。 */
  trackingNumber?: string;
  /** 販売日(sales.sale_date)での範囲絞り込み(2026-09-06追加)。いずれか指定時は売上(sales)が
   *  存在する商品のみが対象になる(該当する売上が無い商品は結果から除外される)。 */
  saleDateFrom?: string;
  saleDateTo?: string;
  /** 仕入品名(items.title)での絞り込み(部分一致、2026-09-15追加)。 */
  purchaseTitle?: string;
  /** 仕入先種別(purchases.source_type、SOURCE_TYPE_OPTIONSの値)での絞り込み(完全一致、2026-09-15追加)。
   *  指定時は仕入(purchases)が登録済みの商品のみが対象になる(未仕入の商品は結果から除外される)。 */
  sourceType?: string;
  /** 仕入先・出品者名(purchases.source_name)での絞り込み(部分一致、2026-09-15追加)。指定時は
   *  仕入(purchases)が登録済みの商品のみが対象になる(未仕入の商品は結果から除外される)。 */
  sellerName?: string;
  /** 仕入日(purchases.purchase_date)での範囲絞り込み(2026-09-15追加)。いずれか指定時は仕入
   *  (purchases)が登録済みの商品のみが対象になる(未仕入の商品は結果から除外される)。 */
  purchaseDateFrom?: string;
  purchaseDateTo?: string;
  /** 更新日(items.updated_at)での範囲絞り込み(2026-09-23追加)。itemsの列を直接見るため
   *  仕入日・販売日と異なりjoinの切り替えは不要。 */
  updatedAtFrom?: string;
  updatedAtTo?: string;
  /** 登録日時(items.created_at)での範囲絞り込み(2026-09-23追加)。updated_at同様joinの切り替えは不要。 */
  createdAtFrom?: string;
  createdAtTo?: string;
}
