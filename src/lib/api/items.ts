import { supabase } from "../supabaseClient";
import type { Item, ItemDetail, ItemListFilters, ItemStatus } from "../types";

export type ItemSortOption =
  | "created_desc"
  | "created_asc"
  | "model_asc"
  | "model_desc"
  | "sale_date_asc"
  | "sale_date_desc";

/** 「棚卸資産」の対象ステータス(検品済・出品待ち + 出品中)。在庫タブの集計表示で使用。 */
const INVENTORY_VALUATION_STATUSES: ItemStatus[] = ["inspected_awaiting_listing", "listed"];

export interface InventoryValuationSummary {
  count: number;
  totalPurchasePrice: number;
}

/**
 * 棚卸資産(ステータスが「検品済・出品待ち」または「出品中」)の商品数・仕入額合計を集計する。
 * 在庫タブに常時表示する用途のため、一覧側の絞り込み(filters)には影響されない全件集計。
 */
export async function fetchInventoryValuationSummary(): Promise<InventoryValuationSummary> {
  const { data, error } = await supabase
    .from("items")
    .select("id, purchases(purchase_price)")
    .in("status", INVENTORY_VALUATION_STATUSES);
  if (error) throw error;

  const rows = (data ?? []) as unknown as Array<{
    id: string;
    purchases: { purchase_price: number } | { purchase_price: number }[] | null;
  }>;

  let totalPurchasePrice = 0;
  for (const row of rows) {
    const purchase = Array.isArray(row.purchases) ? row.purchases[0] : row.purchases;
    totalPurchasePrice += purchase?.purchase_price ?? 0;
  }

  return { count: rows.length, totalPurchasePrice };
}

export async function fetchItemList(
  filters: ItemListFilters = {},
  limit?: number,
  sort: ItemSortOption = "created_desc",
): Promise<Item[]> {
  let query = supabase
    .from("items")
    .select("id, management_no, category, brand, model, serial_number, title, status, created_at, updated_at, account");

  if (sort === "model_asc") {
    query = query.order("model", { ascending: true, nullsFirst: false });
  } else if (sort === "model_desc") {
    query = query.order("model", { ascending: false, nullsFirst: false });
  } else if (sort === "created_asc") {
    query = query.order("created_at", { ascending: true });
  } else {
    query = query.order("created_at", { ascending: false });
  }

  if (filters.status === "not_sold") {
    query = query.neq("status", "sold");
  } else if (filters.status) {
    query = query.eq("status", filters.status);
  }
  if (filters.account) {
    query = query.eq("account", filters.account);
  }
  if (filters.category) {
    query = query.eq("category", filters.category);
  }
  if (filters.brand) {
    // ブランド欄はUI上「ブランド/機種」として案内している。台帳一括取込等では
    // items.brand列にデータが入らず(機種名は全てitems.model列にまとめて保存される)ため、
    // brand列のみへの絞り込みでは取込商品が一件もヒットしない不具合があった。
    // brand・model両方に対する部分一致(OR)に変更し、他タブ(一覧表示・CSV出力)の
    // 「ブランド/機種」絞り込みと同じ挙動に揃えた(2026-09-02)。
    query = query.or(`brand.ilike.%${filters.brand}%,model.ilike.%${filters.brand}%`);
  }
  if (filters.keyword) {
    query = query.or(
      `management_no.ilike.%${filters.keyword}%,serial_number.ilike.%${filters.keyword}%,model.ilike.%${filters.keyword}%`,
    );
  }
  if (limit) {
    query = query.limit(limit);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data as Item[];
}

export interface ItemWithPurchase extends Item {
  purchase_date: string | null;
  purchase_price: number | null;
  /** 仕入先種別(purchases.source_type、SOURCE_TYPE_OPTIONSの値)。未仕入または未設定ならnull。 */
  source_type: string | null;
  /** 仕入先・出品者名(purchasesの仕入先2優先マージ済み値)。未仕入または未設定ならnull。 */
  source_name: string | null;
  sale_date: string | null;
  /** 直近の売上(sales)レコードの販売アイテム名(eBay等の出品タイトル)。未販売ならnull。 */
  sale_item_title: string | null;
  /** 直近の売上(sales)レコードのSales #(仕入・販売帳のSales #列)。未販売ならnull。 */
  sales_record_reference: string | null;
  /** 直近の売上(sales)レコードの追跡番号(sales.tracking_info)。未販売ならnull。2026-09-06追加。 */
  tracking_info: string | null;
  /** 直近の売上(sales)レコードの送料支払額(sales.shipping_cost_paid)。未販売ならnull。2026-09-10追加。 */
  shipping_cost_paid: number | null;
  /** 直近の売上(sales)レコードの邦プラットフォーム販売価格(sales.jp_platform_price)。未販売ならnull。2026-09-15追加。 */
  jp_platform_price: number | null;
  /** 直近の売上(sales)レコードの粗利(sales.gross_profit_jpy、DB側の生成列)。未販売ならnull。2026-09-15追加。 */
  gross_profit_jpy: number | null;
  drive_folder_id: string | null;
  drive_folder_path: string | null;
  drive_model_folder_name: string | null;
  drive_item_folder_name: string | null;
  /** item_drive_folders.current_stage。2026-09-05追加: 「フォルダを開く」ボタンが、機種名フォルダの
   *  有無に関わらずステージに応じた正しいローカルパスを組み立てられるようにするため。 */
  drive_current_stage: string | null;
}

/** 在庫一覧(表形式)向けに、仕入日・仕入高も併せて取得する */
/** items一覧+仕入・売上・Driveフォルダ結合クエリの共通部分(絞り込み条件・ソート順)を組み立てる。
 *  クエリビルダは1回使うと再利用できないため、ページングで複数回叩く際は毎回この関数で新規に組み立て直す。 */
function buildItemListWithPurchaseQuery(filters: ItemListFilters, sort: ItemSortOption) {
  // 追跡番号・販売日での絞り込み指定時のみ sales を !inner 結合にする(2026-09-06追加)。PostgRESTの仕様上、
  // 埋め込みリソース(sales)への絞り込み条件は、!inner を付けない限り親(items)行の抽出には反映されず
  // 埋め込み側の配列内容が絞られるだけになるため、items自体を絞り込みたい場合は !inner が必須。
  // 通常時(絞り込み無し)は従来通り左外部結合のままにし、売上未登録の商品も一覧に含まれるようにする。
  const needsSalesInnerJoin = Boolean(
    filters.trackingNumber ||
      filters.saleDateFrom ||
      filters.saleDateTo ||
      filters.status === "sold_missing_shipping_tracking",
  );
  const salesEmbed = needsSalesInnerJoin
    ? "sales!inner(sale_date, sale_item_title, sales_record_reference, tracking_info, shipping_cost_paid, jp_platform_price, gross_profit_jpy)"
    : "sales(sale_date, sale_item_title, sales_record_reference, tracking_info, shipping_cost_paid, jp_platform_price, gross_profit_jpy)";
  // 出品者名・仕入日での絞り込み指定時のみ purchases を !inner 結合にする(2026-09-15追加、salesと同じ理由)。
  const needsPurchasesInnerJoin = Boolean(
    filters.sourceType || filters.sellerName || filters.purchaseDateFrom || filters.purchaseDateTo,
  );
  const purchasesEmbed = needsPurchasesInnerJoin
    ? "purchases!inner(purchase_date, purchase_price, source_type, source_name)"
    : "purchases(purchase_date, purchase_price, source_type, source_name)";
  let query = supabase
    .from("items")
    .select(
      `id, management_no, category, brand, model, serial_number, title, status, created_at, updated_at, account, ${purchasesEmbed}, ${salesEmbed}, item_drive_folders(drive_folder_id, drive_folder_path, model_folder_name, item_folder_name, current_stage)`,
    );

  if (sort === "model_asc") {
    query = query.order("model", { ascending: true, nullsFirst: false });
  } else if (sort === "model_desc") {
    query = query.order("model", { ascending: false, nullsFirst: false });
  } else if (sort === "created_asc") {
    query = query.order("created_at", { ascending: true });
  } else {
    query = query.order("created_at", { ascending: false });
  }
  // 同一created_at(または同一model)の行が並んだ場合でもページ間で順序が安定するよう、idを第2ソートキーとして追加
  // (2026-09-05追加、下記ページング処理での取りこぼし・重複防止のため)。
  query = query.order("id", { ascending: true });

  if (filters.status === "not_sold") {
    query = query.neq("status", "sold");
  } else if (filters.status === "sold_missing_shipping_tracking") {
    // 2026-09-10追加(ユーザー指示): 販売済み(sold)かつ、直近の売上の送料支払額が未入力(0/未設定)
    // または追跡番号が未入力のものを対象とする。埋め込みリソース(sales)側の条件をOR結合するため、
    // foreignTableオプションを使う(sales!inner結合であることが前提。needsSalesInnerJoin参照)。
    query = query
      .eq("status", "sold")
      .or("shipping_cost_paid.is.null,shipping_cost_paid.eq.0,tracking_info.is.null", { foreignTable: "sales" });
  } else if (filters.status) {
    query = query.eq("status", filters.status);
  }
  if (filters.account) {
    query = query.eq("account", filters.account);
  }
  if (filters.category) {
    query = query.eq("category", filters.category);
  }
  if (filters.brand) {
    // ブランド欄はUI上「ブランド/機種」として案内している。台帳一括取込等では
    // items.brand列にデータが入らず(機種名は全てitems.model列にまとめて保存される)ため、
    // brand列のみへの絞り込みでは取込商品が一件もヒットしない不具合があった。
    // brand・model両方に対する部分一致(OR)に変更し、他タブ(一覧表示・CSV出力)の
    // 「ブランド/機種」絞り込みと同じ挙動に揃えた(2026-09-02)。
    query = query.or(`brand.ilike.%${filters.brand}%,model.ilike.%${filters.brand}%`);
  }
  if (filters.keyword) {
    query = query.or(
      `management_no.ilike.%${filters.keyword}%,serial_number.ilike.%${filters.keyword}%,model.ilike.%${filters.keyword}%`,
    );
  }
  if (filters.trackingNumber) {
    query = query.ilike("sales.tracking_info", `%${filters.trackingNumber}%`);
  }
  if (filters.saleDateFrom) {
    query = query.gte("sales.sale_date", filters.saleDateFrom);
  }
  if (filters.saleDateTo) {
    query = query.lte("sales.sale_date", filters.saleDateTo);
  }
  if (filters.purchaseTitle) {
    query = query.ilike("title", `%${filters.purchaseTitle}%`);
  }
  if (filters.sourceType) {
    query = query.eq("purchases.source_type", filters.sourceType);
  }
  if (filters.sellerName) {
    query = query.ilike("purchases.source_name", `%${filters.sellerName}%`);
  }
  if (filters.purchaseDateFrom) {
    query = query.gte("purchases.purchase_date", filters.purchaseDateFrom);
  }
  if (filters.purchaseDateTo) {
    query = query.lte("purchases.purchase_date", filters.purchaseDateTo);
  }
  return query;
}

/** 1ページあたりの取得件数。PostgRESTのデフォルト上限(このプロジェクトでは1000件)を超えて
 *  全件取得するためのページングに使う(下記参照)。 */
const FETCH_ALL_PAGE_SIZE = 1000;

/**
 * 販売日(sale_date)でのソート(2026-09-06追加)。sale_dateは`sales`テーブル(1対多で埋め込み)
 * の値のため、PostgREST側の.order()では埋め込みリソース内の配列の並び替えにしかならず、items自体
 * (親テーブル)の行順には反映されない。そのため、ItemTableView.tsx(一覧表示モード)の
 * クライアント側ソートと同じ方式で、全件取得後にこの関数でJS側で並び替える。未販売(sale_date無し)の
 * 商品は昇順・降順どちらを選んでも常に末尾に置く(ItemTableView.tsxのsortedItemsと同じ挙動)。
 */
function applySaleDateSort(items: ItemWithPurchase[], sort: ItemSortOption): ItemWithPurchase[] {
  if (sort !== "sale_date_asc" && sort !== "sale_date_desc") return items;
  const sorted = [...items].sort((a, b) => {
    const va = a.sale_date;
    const vb = b.sale_date;
    if (!va && !vb) return 0;
    if (!va) return 1;
    if (!vb) return -1;
    return va < vb ? -1 : va > vb ? 1 : 0;
  });
  if (sort === "sale_date_desc") sorted.reverse();
  return sorted;
}

export async function fetchItemListWithPurchase(
  filters: ItemListFilters = {},
  limit?: number,
  sort: ItemSortOption = "created_desc",
): Promise<ItemWithPurchase[]> {
  // 2026-09-05バグ修正(ユーザー指摘「アカウントがsoulcameraでステータス 販売済み以外 指定で、
  // 絞り込み条件に一致する商品がありません」): 「一覧表示」モードは絞り込みなしで全件取得するよう
  // 変更した(直前の修正)ため、items全体の件数(1162件、2026-09-05時点)がPostgRESTのデフォルトの
  // 最大取得件数(1000件)を超え、作成日時が古い方から162件が黙って切り捨てられていた。ちょうど
  // soulcamera×販売済み以外に該当する136件が全てこの切り捨てられた古い162件の中に含まれていたため、
  // 「詳細編集」モード側の絞り込み(サーバー側、1000件制限にかからないよう絞られる)は正常に動作する
  // 一方、「一覧表示」モード(全件取得後にクライアント側でAND絞り込み)だけが0件になる、という事象が
  // 発生していた(ユーザー報告「ANDが動いていない」はこの意味では正確ではなく、AND自体は正しく動作
  // しており、そもそも対象データが取得できていなかったことが原因)。limit未指定(=全件取得)の場合は
  // `.range()`によるページングで1000件の壁を越えて全件取得するよう修正した。
  if (limit) {
    const { data, error } = await buildItemListWithPurchaseQuery(filters, sort).limit(limit);
    if (error) throw error;
    return applySaleDateSort(mapItemListWithPurchaseRows(data), sort);
  }

  const allRows: unknown[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await buildItemListWithPurchaseQuery(filters, sort).range(
      from,
      from + FETCH_ALL_PAGE_SIZE - 1,
    );
    if (error) throw error;
    allRows.push(...(data ?? []));
    if (!data || data.length < FETCH_ALL_PAGE_SIZE) break;
    from += FETCH_ALL_PAGE_SIZE;
  }
  return applySaleDateSort(mapItemListWithPurchaseRows(allRows), sort);
}

function mapItemListWithPurchaseRows(data: unknown): ItemWithPurchase[] {
  return (data as unknown as Array<
    Item & {
      purchases:
        | { purchase_date: string; purchase_price: number; source_type: string | null; source_name: string | null }
        | { purchase_date: string; purchase_price: number; source_type: string | null; source_name: string | null }[]
        | null;
      sales:
        | {
            sale_date: string;
            sale_item_title: string | null;
            sales_record_reference: string | null;
            tracking_info: string | null;
            shipping_cost_paid: number | null;
            jp_platform_price: number | null;
            gross_profit_jpy: number | null;
          }[]
        | {
            sale_date: string;
            sale_item_title: string | null;
            sales_record_reference: string | null;
            tracking_info: string | null;
            shipping_cost_paid: number | null;
            jp_platform_price: number | null;
            gross_profit_jpy: number | null;
          }
        | null;
      item_drive_folders:
        | { drive_folder_id: string | null; drive_folder_path: string; model_folder_name: string | null; item_folder_name: string | null; current_stage: string | null }
        | { drive_folder_id: string | null; drive_folder_path: string; model_folder_name: string | null; item_folder_name: string | null; current_stage: string | null }[]
        | null;
    }
  >).map((row) => {
    const { purchases, sales, item_drive_folders, ...item } = row;
    const purchase = Array.isArray(purchases) ? purchases[0] : purchases;
    const saleArray = Array.isArray(sales) ? sales : sales ? [sales] : [];
    const latestSale = saleArray.sort((a, b) => (a.sale_date < b.sale_date ? 1 : -1))[0];
    const driveFolder = Array.isArray(item_drive_folders) ? item_drive_folders[0] : item_drive_folders;
    return {
      ...item,
      purchase_date: purchase?.purchase_date ?? null,
      purchase_price: purchase?.purchase_price ?? null,
      source_type: purchase?.source_type ?? null,
      source_name: purchase?.source_name ?? null,
      sale_date: latestSale?.sale_date ?? null,
      sale_item_title: latestSale?.sale_item_title ?? null,
      sales_record_reference: latestSale?.sales_record_reference ?? null,
      tracking_info: latestSale?.tracking_info ?? null,
      shipping_cost_paid: latestSale?.shipping_cost_paid ?? null,
      jp_platform_price: latestSale?.jp_platform_price ?? null,
      gross_profit_jpy: latestSale?.gross_profit_jpy ?? null,
      drive_folder_id: driveFolder?.drive_folder_id ?? null,
      drive_folder_path: driveFolder?.drive_folder_path ?? null,
      drive_model_folder_name: driveFolder?.model_folder_name ?? null,
      drive_item_folder_name: driveFolder?.item_folder_name ?? null,
      drive_current_stage: driveFolder?.current_stage ?? null,
    };
  });
}

function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

export async function fetchItemDetail(itemId: string): Promise<ItemDetail> {
  const { data, error } = await supabase
    .from("items")
    .select(
      "*, purchases(*), inspections(*), item_drive_folders(*), " +
        "sales(*, ebay_transaction_lines(order_number, transaction_date, sales_record_reference, custom_label, " +
        "item_title, item_id, buyer_username, buyer_country, item_subtotal, shipping_and_handling, " +
        "final_value_fee, international_fee, transaction_currency, exchange_rate))",
    )
    // 検品タブはdetail.inspections?.[0]を「現在の検品データ」として扱うため、念のため
    // 新しい順で返す(2026-09-16追加、保存が毎回insertしていた過去分の不具合対策と合わせて)。
    .order("inspected_at", { foreignTable: "inspections", ascending: false })
    .eq("id", itemId)
    .single();

  if (error) throw error;

  // purchases / item_drive_folders は1対1関係のため、PostgRESTは配列ではなく
  // 単一オブジェクト(またはnull)で返す。フロントエンド側は配列前提のコードが多いため、
  // ここで正規化しておく(inspectionsは元々1対多で配列のためそのままtoArrayを通しても影響なし)。
  const raw = data as unknown as Record<string, unknown>;
  const normalized: unknown = {
    ...raw,
    purchases: toArray(raw.purchases as never),
    inspections: toArray(raw.inspections as never),
    item_drive_folders: toArray(raw.item_drive_folders as never),
    sales: toArray(raw.sales as never),
  };
  return normalized as ItemDetail;
}

export interface ItemBasicInfoPatch {
  management_no?: string;
  title?: string | null;
  item_title?: string | null;
  category?: string;
  brand?: string | null;
  model?: string | null;
  serial_number?: string | null;
  status?: ItemStatus; // 修正用の手動変更のみ想定。通常のステータス遷移は各専用アクション経由で行う
  listing_status_code?: string | null; // 「カメラ」在庫シートのステータス列(S/L等)の生値。将来の拡張用の単純な文字列
  platform_category?: string | null; // 直販プラットフォーム出品用のカテゴリ(film_camera/digital_camera/lens/accessory)
  grade?: string | null; // 直販プラットフォーム出品用のグレード(top_mint/mint/near_mint/excellent/very_good/as-is/for_parts/junk)
  accessories_included?: string | null; // 直販プラットフォーム出品用の付属品(自由記述)
  account?: string | null; // eBayアカウント区分(soulcamera/soulmenjapan/other)。未設定に戻す場合はnullを指定。
}

/** 基本情報タブでの編集(管理番号・仕入品名・カテゴリ・ブランド・機種名・シリアル番号) */
export async function updateItemBasicInfo(itemId: string, patch: ItemBasicInfoPatch): Promise<void> {
  const { error } = await supabase.from("items").update(patch).eq("id", itemId);
  if (error) throw error;
}

export async function updateItemStatus(itemId: string, status: ItemStatus): Promise<void> {
  const { data: current, error: fetchError } = await supabase
    .from("items")
    .select("status")
    .eq("id", itemId)
    .single();
  if (fetchError) throw fetchError;

  const { error } = await supabase.from("items").update({ status }).eq("id", itemId);
  if (error) throw error;

  // 「販売済み」から「検品済・出品待ち」「出品中」へ戻す場合(=販売の取り消し)は、
  // 紐づくsalesの金額系項目(販売価格・送料・手数料)を0にリセットする(ユーザー指示、2026-09-12)。
  // 追跡情報(tracking_info)は履歴として残すため変更しない。
  if (current?.status === "sold" && INVENTORY_VALUATION_STATUSES.includes(status)) {
    const { error: salesError } = await supabase
      .from("sales")
      .update({
        jp_platform_price: 0,
        jp_platform_fee: 0,
        jp_platform_shipping_collected: 0,
        shipping_cost_paid: 0,
        ebay_price_usd: 0,
        ebay_shipping_collected_usd: 0,
        ebay_handling_fee_usd: 0,
        ebay_ad_fee_usd: 0,
        updated_at: new Date().toISOString(),
      })
      .eq("item_id", itemId);
    if (salesError) throw salesError;
  }
}

export async function markItemArrived(itemId: string): Promise<void> {
  const { error } = await supabase.rpc("mark_item_arrived", { p_item_id: itemId });
  if (error) throw error;
}

export async function completeInspectionToListing(itemId: string): Promise<void> {
  const { error } = await supabase.rpc("complete_inspection_to_listing", { p_item_id: itemId });
  if (error) throw error;
}

/** 「検品済・出品待ち」→「出品中」への専用遷移(2026-09-04追加)。mark_item_arrived等と同じく
 *  ステータスガード無しでどのステータスからでも実行可能(DB側 mark_item_listed 関数を参照)。 */
export async function markItemListed(itemId: string): Promise<void> {
  const { error } = await supabase.rpc("mark_item_listed", { p_item_id: itemId });
  if (error) throw error;
}

export async function completeInspectionToReturnRequest(
  itemId: string,
  returnReason: string,
): Promise<void> {
  const { error } = await supabase.rpc("complete_inspection_to_return_request", {
    p_item_id: itemId,
    p_return_reason: returnReason,
  });
  if (error) throw error;
}

/** 「検品済・返品済」への遷移(2026-09-08追加)。「着荷・検品待ち」「検品済・返品依頼中」の両方から
 *  実行できる、ステータスガード無しの単純な更新(purchase_returns等の副作用は無い)。 */
export async function completeInspectionToReturned(itemId: string): Promise<void> {
  const { error } = await supabase.rpc("complete_inspection_to_returned", { p_item_id: itemId });
  if (error) throw error;
}

/**
 * 商品(items)を関連データごと削除する(在庫タブ「詳細編集」「一覧表示」のレコード削除機能、2026-09-06追加)。
 * 取り返しがつかないため、呼び出し元(画面側)で必ず確認を取ってから呼ぶこと。
 *
 * items削除時の外部キー制約(ON DELETE)を踏まえた削除順序:
 *  - purchases・purchase_returns・inspections・item_drive_folders・item_drive_folder_moves は
 *    CASCADEのため、items削除時にDBが自動的に削除する(ここでは何もしない)。
 *  - sales.item_id は ON DELETE NO ACTION のため、items削除前に手動で削除する必要がある
 *    (clearAllInventoryData と同じ理由、purchaseLedgerImport.ts参照)。
 *  - ebay_transaction_lines.matched_item_id も ON DELETE NO ACTION のため、items削除前に
 *    参照を解除する必要がある。あわせて、削除するsalesが紐付いていたebay_transaction_line(あれば)・
 *    このitemに直接matched_item_idが設定されているebay_transaction_lineの両方について、
 *    match_statusを'unmatched'に戻す(matched_item_id/matched_atもクリア)。これにより、
 *    実際のeBay取引データ自体は削除せず「売上・粗利」タブのレビューキューに未登録として復帰し、
 *    誤って削除した場合や実データがまだ有効な場合に再登録できるようにしている
 *    (match_statusが'registered'のまま孤立すると、レビューキューの一覧条件
 *    (unmatched/matched_pending)から外れてしまい、実質的に取引データが見えなくなってしまうため)。
 *  - expenses.related_item_id も ON DELETE NO ACTION のため、items削除前に参照を解除する
 *    (経費データ自体は削除しない、clearAllInventoryDataと同じ方針)。
 */
export async function deleteItem(itemId: string): Promise<void> {
  const { data: relatedSales, error: salesFetchError } = await supabase
    .from("sales")
    .select("ebay_transaction_line_id")
    .eq("item_id", itemId);
  if (salesFetchError) throw salesFetchError;

  const { data: matchedLines, error: matchedFetchError } = await supabase
    .from("ebay_transaction_lines")
    .select("id")
    .eq("matched_item_id", itemId);
  if (matchedFetchError) throw matchedFetchError;

  const ebayLineIdsToReset = new Set<string>();
  for (const row of (relatedSales ?? []) as Array<{ ebay_transaction_line_id: string | null }>) {
    if (row.ebay_transaction_line_id) ebayLineIdsToReset.add(row.ebay_transaction_line_id);
  }
  for (const row of (matchedLines ?? []) as Array<{ id: string }>) {
    ebayLineIdsToReset.add(row.id);
  }

  const { error: salesDeleteError } = await supabase.from("sales").delete().eq("item_id", itemId);
  if (salesDeleteError) throw salesDeleteError;

  if (ebayLineIdsToReset.size > 0) {
    const { error: resetError } = await supabase
      .from("ebay_transaction_lines")
      .update({ matched_item_id: null, match_status: "unmatched", matched_at: null })
      .in("id", Array.from(ebayLineIdsToReset));
    if (resetError) throw resetError;
  }

  const { error: expenseError } = await supabase
    .from("expenses")
    .update({ related_item_id: null })
    .eq("related_item_id", itemId);
  if (expenseError) throw expenseError;

  const { error } = await supabase.from("items").delete().eq("id", itemId);
  if (error) throw error;
}

export interface BrandModelOptions {
  brands: string[];
  models: string[];
}

/** ブランド・機種名の入力候補(datalist用)を、登録済み商品から重複無しで取得する(2026-09-15追加)。
 *  itemsは1000件を超えるため、PostgRESTのデフォルト上限を回避するrangeページネーションで全件走査する
 *  (ebay-listing-check Edge Functionのfetch AllItems()と同じ対策)。 */
export async function fetchDistinctBrandsAndModels(): Promise<BrandModelOptions> {
  const pageSize = 1000;
  const brands = new Set<string>();
  const models = new Set<string>();
  let from = 0;
  while (true) {
    const { data, error } = await supabase.from("items").select("brand, model").range(from, from + pageSize - 1);
    if (error) throw error;
    const rows = data ?? [];
    for (const row of rows) {
      const b = (row.brand ?? "").trim();
      if (b) brands.add(b);
      const m = (row.model ?? "").trim();
      if (m) models.add(m);
    }
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return {
    brands: Array.from(brands).sort((a, b) => a.localeCompare(b, "ja")),
    models: Array.from(models).sort((a, b) => a.localeCompare(b, "ja")),
  };
}
