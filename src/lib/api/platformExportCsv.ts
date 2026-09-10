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
  /** 検品「全体」の英訳。condition_descriptionの[Total]に使用。 */
  overall_notes_en: string | null;
  /** 検品「外観」の英訳。condition_descriptionの[Body]に使用。 */
  appearance_notes_en: string | null;
  /** 検品「ファインダー」の英訳。condition_descriptionの[Finder]に使用。 */
  viewfinder_notes_en: string | null;
  /** 検品「レンズ」の英訳。condition_descriptionの[Lens]に使用。 */
  lens_notes_en: string | null;
  /** 検品「その他」の英訳。condition_descriptionの[Functional]に使用。 */
  other_notes_en: string | null;
}

type RawInspectionRow = {
  inspected_at: string;
  overall_notes_en: string | null;
  appearance_notes_en: string | null;
  viewfinder_notes_en: string | null;
  lens_notes_en: string | null;
  other_notes_en: string | null;
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
 * 商品を全件取得する(絞り込みはクライアント側、在庫タブの一覧表示と同じ方針)。
 *
 * 2026-09-10修正(ユーザー指摘「一覧を展開する(1000件) 1000件の根拠は?」): .range()指定無しの
 * select()はSupabase(PostgREST)側のデフォルト上限(max-rows、既定1000件)で暗黙的に打ち切られる。
 * items全体が1167件(2026-09-10時点)あるため、修正前は167件が一覧・CSVの両方から漏れていた
 * (「全件取得」のつもりが実際には先頭1000件のみだった不具合)。.range()で1000件ずつページングし、
 * 取得件数がページサイズ未満になるまで繰り返すことで、件数に関わらず本当の全件を取得する。
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
          "inspections(inspected_at, overall_notes_en, appearance_notes_en, viewfinder_notes_en, lens_notes_en, other_notes_en)",
      )
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
      overall_notes_en: latestInspection?.overall_notes_en ?? null,
      appearance_notes_en: latestInspection?.appearance_notes_en ?? null,
      viewfinder_notes_en: latestInspection?.viewfinder_notes_en ?? null,
      lens_notes_en: latestInspection?.lens_notes_en ?? null,
      other_notes_en: latestInspection?.other_notes_en ?? null,
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

/** [Total]/[Body]/[Finder]/[Lens]/[Functional] の順で検品英訳を連結する。値が無い項目は出力しない。 */
function buildConditionDescription(item: PlatformExportItem): string {
  const parts: string[] = [];
  if (item.overall_notes_en) parts.push(`[Total] ${item.overall_notes_en}`);
  if (item.appearance_notes_en) parts.push(`[Body] ${item.appearance_notes_en}`);
  if (item.viewfinder_notes_en) parts.push(`[Finder] ${item.viewfinder_notes_en}`);
  if (item.lens_notes_en) parts.push(`[Lens] ${item.lens_notes_en}`);
  if (item.other_notes_en) parts.push(`[Functional] ${item.other_notes_en}`);
  return parts.join("\n");
}

/** 選択されたアイテムから「直販プラットフォーム登録用CSV」の文字列(ヘッダー行込み、改行はCRLF)を組み立てる。 */
export function buildDirectSalesCsv(items: PlatformExportItem[]): string {
  const headerLine = DIRECT_SALES_CSV_HEADERS.join(",");
  const lines = items.map((item) => {
    const row: Record<(typeof DIRECT_SALES_CSV_HEADERS)[number], string> = {
      external_id: item.management_no ?? "",
      title: item.sale_item_title ?? "",
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
