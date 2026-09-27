import { supabase } from "../supabaseClient";
import type { ItemStatus } from "../types";

/**
 * 「直販プラットフォーム登録用CSV作成」機能(CSV出力タブ)向けの一覧行。
 * 在庫タブの一覧表示(items.ts の ItemWithPurchase)と似ているが、出品カテゴリ(platform_category)・
 * グレード・付属品・検品の英訳項目(condition_description生成用)も併せて必要なため、
 * 既存のItemWithPurchaseを拡張せずこの機能専用の型・取得関数として独立させている。
 */
export interface PlatformExportItem {
  id: string;
  management_no: string;
  brand: string | null;
  model: string | null;
  /** 既存の業務分類カテゴリ(カメラ関連品/雑貨/衣類)。絞り込みパネル・一覧表示の「カテゴリ」に使用。 */
  category: string;
  status: ItemStatus;
  purchase_date: string | null;
  /** 直近の売上の販売アイテム名(eBay等の出品タイトル)。CSVのtitle列に使用。 */
  sale_item_title: string | null;
  /** 出品カテゴリ(film_camera/digital_camera/lens/accessory)。CSVのcategory列に使用。 */
  platform_category: string | null;
  grade: string | null;
  accessories_included: string | null;
  /**
   * 検品タブの状態チェック表(FUNCTIONAL_CHECK_ITEMS、"ok"|"ng"|"na"|null)。
   * 2026-09-27変更(ユーザー指示): condition_descriptionはこの8項目のうち"ok"のものだけを
   * 英語ラベルで連結する方式に変更した(旧: overall/appearance/viewfinder/lens/other_notes_enの
   * [Total][Body][Finder][Lens][Functional]連結方式は廃止)。
   */
  check_shutter: string | null;
  check_flash: string | null;
  check_autofocus: string | null;
  check_auto_exposure: string | null;
  check_film_winding: string | null;
  check_film_rewinding: string | null;
  check_film_counter: string | null;
  check_self_timer: string | null;
  /** 検品「レンズ」の英訳。condition_descriptionの2行目に使用(2026-09-27追加)。 */
  lens_notes_en: string | null;
  /** 検品「ファインダー」の英訳。condition_descriptionの3行目に使用(2026-09-27追加)。 */
  viewfinder_notes_en: string | null;
}

type RawInspectionRow = {
  inspected_at: string;
  check_shutter: string | null;
  check_flash: string | null;
  check_autofocus: string | null;
  check_auto_exposure: string | null;
  check_film_winding: string | null;
  check_film_rewinding: string | null;
  check_film_counter: string | null;
  check_self_timer: string | null;
  lens_notes_en: string | null;
  viewfinder_notes_en: string | null;
};

type RawRow = {
  id: string;
  management_no: string;
  brand: string | null;
  model: string | null;
  category: string;
  status: ItemStatus;
  platform_category: string | null;
  grade: string | null;
  accessories_included: string | null;
  purchases: { purchase_date: string } | { purchase_date: string }[] | null;
  sales:
    | { sale_date: string; sale_item_title: string | null }
    | { sale_date: string; sale_item_title: string | null }[]
    | null;
  inspections: RawInspectionRow | RawInspectionRow[] | null;
};

/**
 * 商品を取得する(絞り込みはクライアント側、在庫タブの一覧表示と同じ方針)。
 *
 * 2026-09-10修正(ユーザー指摘「一覧を展開する(1000件) 1000件の根拠は?」): .range()指定無しの
 * select()はSupabase(PostgREST)側のデフォルト上限(max-rows、既定1000件)で暗黙的に打ち切られる。
 * .range()で1000件ずつページングし、取得件数がページサイズ未満になるまで繰り返すことで、
 * 件数に関わらず本当の全件を取得する。
 *
 * 2026-09-10追加(ユーザー指示): この機能の対象を「Soulcameraアカウントで、検品済・出品待ち
 * または出品中のもの」に限定した(直販プラットフォームへの新規登録・出品中の内容確認が目的のため、
 * 他アカウント・他ステータス(販売済み等)は対象外)。account="soulcamera" かつ
 * status IN (inspected_awaiting_listing, listed) をクエリ側で絞り込む。
 */
export async function fetchPlatformExportItems(): Promise<PlatformExportItem[]> {
  const PAGE_SIZE = 1000;
  const rawRows: RawRow[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("items")
      .select(
        "id, management_no, brand, model, category, status, platform_category, grade, accessories_included, " +
          "purchases(purchase_date), sales(sale_date, sale_item_title), " +
          "inspections(inspected_at, check_shutter, check_flash, check_autofocus, check_auto_exposure, " +
          "check_film_winding, check_film_rewinding, check_film_counter, check_self_timer, " +
          "lens_notes_en, viewfinder_notes_en)",
      )
      .eq("account", "soulcamera")
      .in("status", ["inspected_awaiting_listing", "listed"])
      .order("created_at", { ascending: false })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data as unknown as RawRow[]) ?? [];
    rawRows.push(...page);
    if (page.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return rawRows.map((row) => {
    const { purchases, sales, inspections, ...item } = row;
    const purchase = Array.isArray(purchases) ? purchases[0] : purchases;
    const saleArray = Array.isArray(sales) ? sales : sales ? [sales] : [];
    const latestSale = saleArray.sort((a, b) => (a.sale_date < b.sale_date ? 1 : -1))[0];
    const inspectionArray = Array.isArray(inspections) ? inspections : inspections ? [inspections] : [];
    const latestInspection = inspectionArray.sort((a, b) => (a.inspected_at < b.inspected_at ? 1 : -1))[0];
    return {
      ...item,
      purchase_date: purchase?.purchase_date ?? null,
      sale_item_title: latestSale?.sale_item_title ?? null,
      check_shutter: latestInspection?.check_shutter ?? null,
      check_flash: latestInspection?.check_flash ?? null,
      check_autofocus: latestInspection?.check_autofocus ?? null,
      check_auto_exposure: latestInspection?.check_auto_exposure ?? null,
      check_film_winding: latestInspection?.check_film_winding ?? null,
      check_film_rewinding: latestInspection?.check_film_rewinding ?? null,
      check_film_counter: latestInspection?.check_film_counter ?? null,
      check_self_timer: latestInspection?.check_self_timer ?? null,
      lens_notes_en: latestInspection?.lens_notes_en ?? null,
      viewfinder_notes_en: latestInspection?.viewfinder_notes_en ?? null,
    };
  });
}

/**
 * 添付いただいたテンプレートCSV(20260817.csv)のヘッダー・列順そのまま。
 * external_id/title/category/grade/accessories_included/condition_description の6列のみ値を埋め、
 * それ以外(serial_number/year_made/price_usd/stock_quantity/weight_grams/dimensions_cm)は常に空欄で出力する。
 */
const DIRECT_SALES_CSV_HEADERS = [
  "external_id",
  "title",
  "category",
  "condition_description",
  "grade",
  "serial_number",
  "year_made",
  "accessories_included",
  "price_usd",
  "stock_quantity",
  "weight_grams",
  "dimensions_cm",
] as const;

function csvEscape(value: string): string {
  if (/["\n\r,]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * 検品タブの状態チェック表(FUNCTIONAL_CHECK_ITEMSと同じ並び順)で"ok"がマークされている項目の
 * 英語ラベルを", "(カンマ+スペース)で連結し、末尾に" Confirmed working."を付加する
 * (2026-09-27変更、ユーザー指示)。1件もOKが無い場合は空文字を返す。
 */
const CONDITION_CHECK_ITEMS: { key: keyof PlatformExportItem; label: string }[] = [
  { key: "check_shutter", label: "Shutter" },
  { key: "check_flash", label: "Flash" },
  { key: "check_autofocus", label: "Auto focus" },
  { key: "check_auto_exposure", label: "Auto exposure" },
  { key: "check_film_winding", label: "Film winding" },
  { key: "check_film_rewinding", label: "Film rewinding" },
  { key: "check_film_counter", label: "Film counter" },
  { key: "check_self_timer", label: "Self timer" },
];

function buildConditionDescription(item: PlatformExportItem): string {
  const okLabels = CONDITION_CHECK_ITEMS.filter((c) => item[c.key] === "ok").map((c) => c.label);
  const lines: string[] = [];
  if (okLabels.length > 0) lines.push(`[Tested functions] ${okLabels.join(", ")} Confirmed working.`);
  if (item.lens_notes_en) lines.push(item.lens_notes_en);
  if (item.viewfinder_notes_en) lines.push(item.viewfinder_notes_en);
  return lines.join("\n");
}

/** 選択されたアイテムから「直販プラットフォーム登録用CSV」の文字列(ヘッダー行込み、改行はCRLF)を組み立てる。 */
export function buildDirectSalesCsv(items: PlatformExportItem[]): string {
  const headerLine = DIRECT_SALES_CSV_HEADERS.join(",");
  const lines = items.map((item) => {
    const row: Record<(typeof DIRECT_SALES_CSV_HEADERS)[number], string> = {
      external_id: item.management_no ?? "",
      // 2026-09-27変更(ユーザー指示): titleは「ブランド 機種名 管理番号」をスペース区切りで連結する
      // 方式に変更した(旧: 直近の売上のsale_item_title(eBay出品タイトル等)を使用)。
      title: [item.brand, item.model, item.management_no].filter(Boolean).join(" "),
      category: item.platform_category ?? "",
      condition_description: buildConditionDescription(item),
      grade: item.grade ?? "",
      serial_number: "",
      year_made: "",
      accessories_included: item.accessories_included ?? "",
      price_usd: "",
      stock_quantity: "",
      weight_grams: "",
      dimensions_cm: "",
    };
    return DIRECT_SALES_CSV_HEADERS.map((h) => csvEscape(row[h])).join(",");
  });
  return [headerLine, ...lines].join("\r\n");
}
