import { supabase } from "../supabaseClient";
import { ITEM_STATUS_LABELS, EBAY_ACCOUNT_LABELS, EBAY_ACCOUNT_OPTIONS, type ItemStatus } from "../types";
import { COUNTERPARTY_TYPE_OPTIONS, type CounterpartyType } from "../taxDeduction";
import { createItemWithPurchase, type CreateItemWithPurchaseInput } from "./purchases";
import { updateItemStatus, updateItemBasicInfo } from "./items";
import {
  findExistingManagementNos,
  getInventoryDataCounts,
  clearAllInventoryData,
  type InventoryDataCounts,
} from "./purchaseLedgerImport";

export { findExistingManagementNos, getInventoryDataCounts, clearAllInventoryData, type InventoryDataCounts };

/**
 * 在庫タブの「登録データバックアップ」が出力し「バックアップCSVから復元」が読み込む、
 * items・purchases・sales・inspections・item_drive_folders を対象にした CSV 入出力ロジック。
 * (2026-08-29時点でユーザーに確認のうえ、全データを対象とする方針で実装)
 *
 * 1つのCSVファイル内を「## 見出し」行で3セクションに区切るフラット形式:
 *   ## 商品・仕入・売上   … 1商品1行(items+purchases+当該商品の売上1件)
 *   ## 検品データ         … 1検品記録1行(管理番号で商品行と対応付け、1商品に複数件あり得る)
 *   ## Driveフォルダ      … 1フォルダ紐付け1行(管理番号で商品行と対応付け、1商品に複数件あり得る)
 * 検品・Driveフォルダは、対応する商品行が新規作成された場合のみ復元する
 * (既存商品(重複スキップ)には、二重登録を避けるため復元しない)。
 */

export const SECTION_MARKERS = {
  items: "## 商品・仕入・売上",
  inspections: "## 検品データ",
  driveFolders: "## Driveフォルダ",
} as const;

export const ITEMS_CSV_HEADERS = [
  "管理番号",
  "カテゴリ",
  "ブランド",
  "型番",
  "シリアル番号",
  "商品名",
  "ステータス",
  "仕入日",
  "仕入先区分",
  "仕入先名",
  "仕入先URL",
  "仕入高",
  "数量",
  "新品古物区分",
  "取引先区分",
  "販売日",
  "販売時商品名",
  "追跡番号",
  "国内販売価格",
  "国内販売手数料",
  "国内送料受取",
  "発送費用",
  "eBay販売価格USD",
  "eBay送料受取USD",
  "eBayハンドリング手数料USD",
  "eBay広告費USD",
  "為替レート",
  "アカウント",
];

export const INSPECTION_CSV_HEADERS = [
  "管理番号",
  "検品者",
  "検品日時",
  "総評",
  "総評(英語)",
  "電気系統",
  "電気系統(英語)",
  "シャッター",
  "シャッター(英語)",
  "絞り・露出",
  "絞り・露出(英語)",
  "フィルム搬送",
  "フィルム搬送(英語)",
  "ファインダー",
  "ファインダー(英語)",
  "レンズ",
  "レンズ(英語)",
  "その他",
  "その他(英語)",
  "コンディショングレード",
];

export const DRIVE_FOLDER_CSV_HEADERS = [
  "管理番号",
  "フォルダパス",
  "モデルフォルダ名",
  "商品フォルダ名",
  "DriveフォルダID",
  "現在の段階",
  "登録日時",
];

// ---- バックアップ(DB → CSV) ----

export interface InventoryBackupItemRow {
  managementNo: string;
  category: string;
  brand: string | null;
  model: string | null;
  serialNumber: string | null;
  title: string | null;
  status: ItemStatus;
  /** eBayアカウント区分(soulcamera/soulmenjapan/other)。未設定はnull。2026-09-03追加。 */
  account: string | null;
  purchaseDate: string | null;
  sourceType: string | null;
  sourceName: string | null;
  sourceUrl: string | null;
  purchasePrice: number | null;
  quantity: number | null;
  isUsedGoods: boolean | null;
  counterpartyType: CounterpartyType | null;
  saleDate: string | null;
  saleItemTitle: string | null;
  trackingInfo: string | null;
  jpPlatformPrice: number | null;
  jpPlatformFee: number | null;
  jpPlatformShippingCollected: number | null;
  shippingCostPaid: number | null;
  ebayPriceUsd: number | null;
  ebayShippingCollectedUsd: number | null;
  ebayHandlingFeeUsd: number | null;
  ebayAdFeeUsd: number | null;
  exchangeRate: number | null;
}

export interface InventoryBackupInspectionRow {
  managementNo: string;
  inspectedBy: string | null;
  inspectedAt: string;
  overallNotes: string | null;
  overallNotesEn: string | null;
  electricalNotes: string | null;
  electricalNotesEn: string | null;
  shutterNotes: string | null;
  shutterNotesEn: string | null;
  apertureExposureNotes: string | null;
  apertureExposureNotesEn: string | null;
  filmTransportNotes: string | null;
  filmTransportNotesEn: string | null;
  viewfinderNotes: string | null;
  viewfinderNotesEn: string | null;
  lensNotes: string | null;
  lensNotesEn: string | null;
  otherNotes: string | null;
  otherNotesEn: string | null;
  conditionGrade: string | null;
}

export interface InventoryBackupDriveFolderRow {
  managementNo: string;
  driveFolderPath: string;
  modelFolderName: string | null;
  itemFolderName: string | null;
  driveFolderId: string | null;
  currentStage: string | null;
  registeredAt: string;
}

export interface InventoryBackupData {
  items: InventoryBackupItemRow[];
  inspections: InventoryBackupInspectionRow[];
  driveFolders: InventoryBackupDriveFolderRow[];
}

interface RawPurchaseJoin {
  purchase_date: string;
  source_type: string;
  source_name: string | null;
  source_url: string | null;
  purchase_price: number;
  quantity: number;
  is_used_goods: boolean;
  counterparty_type: CounterpartyType;
}

interface RawSaleJoin {
  sale_date: string;
  sale_item_title: string | null;
  tracking_info: string | null;
  jp_platform_price: number;
  jp_platform_fee: number;
  jp_platform_shipping_collected: number;
  shipping_cost_paid: number;
  ebay_price_usd: number;
  ebay_shipping_collected_usd: number;
  ebay_handling_fee_usd: number;
  ebay_ad_fee_usd: number;
  exchange_rate: number;
}

interface RawInspectionJoin {
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
  condition_grade: string | null;
}

interface RawDriveFolderJoin {
  drive_folder_path: string;
  model_folder_name: string | null;
  item_folder_name: string | null;
  drive_folder_id: string | null;
  current_stage: string | null;
  registered_at: string;
}

interface RawItemQueryRow {
  management_no: string;
  category: string;
  brand: string | null;
  model: string | null;
  serial_number: string | null;
  title: string | null;
  status: ItemStatus;
  account: string | null;
  purchases: RawPurchaseJoin[] | RawPurchaseJoin | null;
  sales: RawSaleJoin[] | RawSaleJoin | null;
  inspections: RawInspectionJoin[] | null;
  item_drive_folders: RawDriveFolderJoin[] | RawDriveFolderJoin | null;
}

/** items・purchases・sales・inspections・item_drive_folders を結合し、バックアップCSV出力用のデータを取得する。 */
export async function fetchAllInventoryBackupData(): Promise<InventoryBackupData> {
  const { data, error } = await supabase
    .from("items")
    .select(
      "management_no, category, brand, model, serial_number, title, status, account, " +
        "purchases(purchase_date, source_type, source_name, source_url, purchase_price, quantity, is_used_goods, counterparty_type), " +
        "sales(sale_date, sale_item_title, tracking_info, jp_platform_price, jp_platform_fee, jp_platform_shipping_collected, shipping_cost_paid, ebay_price_usd, ebay_shipping_collected_usd, ebay_handling_fee_usd, ebay_ad_fee_usd, exchange_rate), " +
        "inspections(inspected_by, inspected_at, overall_notes, overall_notes_en, electrical_notes, electrical_notes_en, shutter_notes, shutter_notes_en, aperture_exposure_notes, aperture_exposure_notes_en, film_transport_notes, film_transport_notes_en, viewfinder_notes, viewfinder_notes_en, lens_notes, lens_notes_en, other_notes, other_notes_en, condition_grade), " +
        "item_drive_folders(drive_folder_path, model_folder_name, item_folder_name, drive_folder_id, current_stage, registered_at)",
    )
    .order("management_no", { ascending: true });
  if (error) throw error;

  const rows = data as unknown as RawItemQueryRow[];

  const items: InventoryBackupItemRow[] = rows.map((row) => {
    const purchase = Array.isArray(row.purchases) ? row.purchases[0] : row.purchases;
    const sale = Array.isArray(row.sales) ? row.sales[0] : row.sales;
    return {
      managementNo: row.management_no,
      category: row.category,
      brand: row.brand,
      model: row.model,
      serialNumber: row.serial_number,
      title: row.title,
      status: row.status,
      account: row.account,
      purchaseDate: purchase?.purchase_date ?? null,
      sourceType: purchase?.source_type ?? null,
      sourceName: purchase?.source_name ?? null,
      sourceUrl: purchase?.source_url ?? null,
      purchasePrice: purchase?.purchase_price ?? null,
      quantity: purchase?.quantity ?? null,
      isUsedGoods: purchase?.is_used_goods ?? null,
      counterpartyType: purchase?.counterparty_type ?? null,
      saleDate: sale?.sale_date ?? null,
      saleItemTitle: sale?.sale_item_title ?? null,
      trackingInfo: sale?.tracking_info ?? null,
      jpPlatformPrice: sale?.jp_platform_price ?? null,
      jpPlatformFee: sale?.jp_platform_fee ?? null,
      jpPlatformShippingCollected: sale?.jp_platform_shipping_collected ?? null,
      shippingCostPaid: sale?.shipping_cost_paid ?? null,
      ebayPriceUsd: sale?.ebay_price_usd ?? null,
      ebayShippingCollectedUsd: sale?.ebay_shipping_collected_usd ?? null,
      ebayHandlingFeeUsd: sale?.ebay_handling_fee_usd ?? null,
      ebayAdFeeUsd: sale?.ebay_ad_fee_usd ?? null,
      exchangeRate: sale?.exchange_rate ?? null,
    };
  });

  const inspections: InventoryBackupInspectionRow[] = [];
  const driveFolders: InventoryBackupDriveFolderRow[] = [];
  for (const row of rows) {
    for (const insp of row.inspections ?? []) {
      inspections.push({
        managementNo: row.management_no,
        inspectedBy: insp.inspected_by,
        inspectedAt: insp.inspected_at,
        overallNotes: insp.overall_notes,
        overallNotesEn: insp.overall_notes_en,
        electricalNotes: insp.electrical_notes,
        electricalNotesEn: insp.electrical_notes_en,
        shutterNotes: insp.shutter_notes,
        shutterNotesEn: insp.shutter_notes_en,
        apertureExposureNotes: insp.aperture_exposure_notes,
        apertureExposureNotesEn: insp.aperture_exposure_notes_en,
        filmTransportNotes: insp.film_transport_notes,
        filmTransportNotesEn: insp.film_transport_notes_en,
        viewfinderNotes: insp.viewfinder_notes,
        viewfinderNotesEn: insp.viewfinder_notes_en,
        lensNotes: insp.lens_notes,
        lensNotesEn: insp.lens_notes_en,
        otherNotes: insp.other_notes,
        otherNotesEn: insp.other_notes_en,
        conditionGrade: insp.condition_grade,
      });
    }
    // item_drive_foldersはitem_idにUNIQUE制約があるため、PostgRESTが1件のみ紐づく商品では
    // 配列ではなく単一オブジェクトを返す(purchases/salesと同じ挙動)。配列に正規化してから処理する。
    const driveFolderRows = Array.isArray(row.item_drive_folders)
      ? row.item_drive_folders
      : row.item_drive_folders
        ? [row.item_drive_folders]
        : [];
    for (const f of driveFolderRows) {
      driveFolders.push({
        managementNo: row.management_no,
        driveFolderPath: f.drive_folder_path,
        modelFolderName: f.model_folder_name,
        itemFolderName: f.item_folder_name,
        driveFolderId: f.drive_folder_id,
        currentStage: f.current_stage,
        registeredAt: f.registered_at,
      });
    }
  }

  return { items, inspections, driveFolders };
}

// ---- 復元(CSV → DB) ----

/** CSV全体をパース済みの行配列から、3セクションに分割する。 */
export function splitInventoryBackupSections(
  rows: string[][],
): { items: string[][]; inspections: string[][]; driveFolders: string[][] } | { sectionError: string } {
  const idxItems = rows.findIndex((r) => r.length === 1 && r[0].trim() === SECTION_MARKERS.items);
  const idxInspections = rows.findIndex((r) => r.length === 1 && r[0].trim() === SECTION_MARKERS.inspections);
  const idxDriveFolders = rows.findIndex((r) => r.length === 1 && r[0].trim() === SECTION_MARKERS.driveFolders);
  if (idxItems === -1 || idxInspections === -1 || idxDriveFolders === -1) {
    return {
      sectionError:
        "CSVのセクション区切り(「## 商品・仕入・売上」等)が見つかりません。在庫タブの「登録データバックアップ」で出力したCSVファイルを指定してください",
    };
  }
  return {
    items: rows.slice(idxItems + 1, idxInspections),
    inspections: rows.slice(idxInspections + 1, idxDriveFolders),
    driveFolders: rows.slice(idxDriveFolders + 1),
  };
}

function checkHeader(rows: string[][], expected: string[], label: string): string | null {
  if (rows.length === 0) return null; // 該当セクションが0件でも許容する
  const header = rows[0];
  const matches = expected.every((h, i) => (header[i] ?? "").trim() === h);
  if (!matches) {
    return `CSVの「${label}」セクションのヘッダー列が想定と異なります(想定: ${expected.join(",")})`;
  }
  return null;
}

export interface InspectionInsertInput {
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
  condition_grade: string | null;
}

export interface DriveFolderInsertInput {
  drive_folder_path: string;
  model_folder_name: string | null;
  item_folder_name: string | null;
  drive_folder_id: string | null;
  current_stage: string | null;
  registered_at: string;
}

export interface SaleInsertInput {
  sale_date: string;
  sale_item_title: string | null;
  tracking_info: string | null;
  jp_platform_price: number;
  jp_platform_fee: number;
  jp_platform_shipping_collected: number;
  shipping_cost_paid: number;
  ebay_price_usd: number;
  ebay_shipping_collected_usd: number;
  ebay_handling_fee_usd: number;
  ebay_ad_fee_usd: number;
  exchange_rate: number;
}

export type ImportRowOutcome = "new" | "duplicate" | "error";

export interface MappedInventoryRow {
  rowNumber: number;
  managementNo: string | null;
  displayTitle: string | null;
  displayPurchasePrice: number | null;
  outcome: ImportRowOutcome;
  errors: string[];
  warnings: string[];
  itemInput: CreateItemWithPurchaseInput | null;
  finalStatus: ItemStatus;
  /** eBayアカウント区分(soulcamera/soulmenjapan/other)。未設定・不明値はnull。2026-09-03追加。 */
  account: string | null;
  saleInput: SaleInsertInput | null;
  inspections: InspectionInsertInput[];
  driveFolders: DriveFolderInsertInput[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const STATUS_LABEL_TO_VALUE: Record<string, ItemStatus> = Object.fromEntries(
  (Object.keys(ITEM_STATUS_LABELS) as ItemStatus[]).map((s) => [ITEM_STATUS_LABELS[s], s]),
);

const ACCOUNT_LABEL_TO_VALUE: Record<string, string> = Object.fromEntries(
  EBAY_ACCOUNT_OPTIONS.map((a) => [EBAY_ACCOUNT_LABELS[a], a]),
);

const COUNTERPARTY_LABEL_TO_VALUE: Record<string, CounterpartyType> = Object.fromEntries(
  COUNTERPARTY_TYPE_OPTIONS.map((o) => [o.label, o.value]),
);

function toNumOrNull(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function blankToNull(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

function mapInspectionRow(cols: string[], warnings: string[]): InspectionInsertInput {
  const inspectedAt = cols[2]?.trim() || "";
  if (!inspectedAt) {
    warnings.push("検品データの検品日時が空欄のため、復元実行時刻として登録します");
  }
  return {
    inspected_by: blankToNull(cols[1] ?? ""),
    inspected_at: inspectedAt || new Date().toISOString(),
    overall_notes: blankToNull(cols[3] ?? ""),
    overall_notes_en: blankToNull(cols[4] ?? ""),
    electrical_notes: blankToNull(cols[5] ?? ""),
    electrical_notes_en: blankToNull(cols[6] ?? ""),
    shutter_notes: blankToNull(cols[7] ?? ""),
    shutter_notes_en: blankToNull(cols[8] ?? ""),
    aperture_exposure_notes: blankToNull(cols[9] ?? ""),
    aperture_exposure_notes_en: blankToNull(cols[10] ?? ""),
    film_transport_notes: blankToNull(cols[11] ?? ""),
    film_transport_notes_en: blankToNull(cols[12] ?? ""),
    viewfinder_notes: blankToNull(cols[13] ?? ""),
    viewfinder_notes_en: blankToNull(cols[14] ?? ""),
    lens_notes: blankToNull(cols[15] ?? ""),
    lens_notes_en: blankToNull(cols[16] ?? ""),
    other_notes: blankToNull(cols[17] ?? ""),
    other_notes_en: blankToNull(cols[18] ?? ""),
    condition_grade: blankToNull(cols[19] ?? ""),
  };
}

function mapDriveFolderRow(cols: string[], errors: string[]): DriveFolderInsertInput | null {
  const path = (cols[1] ?? "").trim();
  if (!path) {
    errors.push("Driveフォルダデータのフォルダパスが空欄です");
    return null;
  }
  const registeredAt = (cols[6] ?? "").trim();
  return {
    drive_folder_path: path,
    model_folder_name: blankToNull(cols[2] ?? ""),
    item_folder_name: blankToNull(cols[3] ?? ""),
    drive_folder_id: blankToNull(cols[4] ?? ""),
    current_stage: blankToNull(cols[5] ?? ""),
    registered_at: registeredAt || new Date().toISOString(),
  };
}

/**
 * バックアップCSV(パース済みの行配列)全体を検証し、DB復元用の形式に変換する(同期処理のみ、DBアクセスなし)。
 * 検品・Driveフォルダは管理番号で商品行に紐付ける。
 */
export function mapInventoryBackupRows(sections: {
  items: string[][];
  inspections: string[][];
  driveFolders: string[][];
}): { rows: MappedInventoryRow[]; headerErrors: string[] } {
  const headerErrors: string[] = [];
  const itemsHeaderError = checkHeader(sections.items, ITEMS_CSV_HEADERS, "商品・仕入・売上");
  if (itemsHeaderError) headerErrors.push(itemsHeaderError);
  const inspectionsHeaderError = checkHeader(sections.inspections, INSPECTION_CSV_HEADERS, "検品データ");
  if (inspectionsHeaderError) headerErrors.push(inspectionsHeaderError);
  const driveFoldersHeaderError = checkHeader(sections.driveFolders, DRIVE_FOLDER_CSV_HEADERS, "Driveフォルダ");
  if (driveFoldersHeaderError) headerErrors.push(driveFoldersHeaderError);
  if (headerErrors.length > 0) return { rows: [], headerErrors };

  // 検品・Driveフォルダを管理番号でグルーピングしておく
  const inspectionsByNo = new Map<string, string[][]>();
  for (let i = 1; i < sections.inspections.length; i++) {
    const cols = sections.inspections[i];
    if (cols.length === 1 && (cols[0] ?? "").trim() === "") continue;
    const no = (cols[0] ?? "").trim();
    if (!no) continue;
    const arr = inspectionsByNo.get(no);
    if (arr) arr.push(cols);
    else inspectionsByNo.set(no, [cols]);
  }
  const driveFoldersByNo = new Map<string, string[][]>();
  for (let i = 1; i < sections.driveFolders.length; i++) {
    const cols = sections.driveFolders[i];
    if (cols.length === 1 && (cols[0] ?? "").trim() === "") continue;
    const no = (cols[0] ?? "").trim();
    if (!no) continue;
    const arr = driveFoldersByNo.get(no);
    if (arr) arr.push(cols);
    else driveFoldersByNo.set(no, [cols]);
  }

  const mapped: MappedInventoryRow[] = [];
  for (let i = 1; i < sections.items.length; i++) {
    const r = sections.items[i];
    if (r.length === 1 && (r[0] ?? "").trim() === "") continue;
    const rowNumber = i + 1;

    const errors: string[] = [];
    const warnings: string[] = [];

    const managementNo = (r[0] ?? "").trim();
    if (!managementNo) errors.push("管理番号が空欄です");

    const category = (r[1] ?? "").trim();
    if (!category) errors.push("カテゴリが空欄です");

    const accountLabel = (r[27] ?? "").trim();
    let account: string | null = null;
    if (accountLabel && ACCOUNT_LABEL_TO_VALUE[accountLabel]) {
      account = ACCOUNT_LABEL_TO_VALUE[accountLabel];
    } else if (accountLabel) {
      warnings.push(`アカウントが不明な値のため未設定として扱います(値: "${accountLabel}")`);
    }

    const statusLabel = (r[6] ?? "").trim();
    let status: ItemStatus = "awaiting_arrival";
    if (statusLabel && STATUS_LABEL_TO_VALUE[statusLabel]) {
      status = STATUS_LABEL_TO_VALUE[statusLabel];
    } else if (statusLabel) {
      warnings.push(
        `ステータスが不明な値のため「${ITEM_STATUS_LABELS.awaiting_arrival}」として扱います(値: "${statusLabel}")`,
      );
    } else {
      warnings.push(`ステータスが空欄のため「${ITEM_STATUS_LABELS.awaiting_arrival}」として扱います`);
    }

    const purchaseDate = (r[7] ?? "").trim();
    if (!DATE_RE.test(purchaseDate)) {
      errors.push(`仕入日の形式が不正です(値: "${r[7] ?? ""}")。YYYY-MM-DD形式である必要があります`);
    }

    const purchasePrice = toNumOrNull(r[11] ?? "");
    if (purchasePrice == null) {
      errors.push(`仕入高が数値として読み取れません(値: "${r[11] ?? ""}")`);
    }

    const quantityParsed = toNumOrNull(r[12] ?? "");
    const quantity = quantityParsed ?? 1;
    if (quantityParsed == null && (r[12] ?? "").trim() !== "") {
      warnings.push(`数量が数値として読み取れないため1として扱います(値: "${r[12] ?? ""}")`);
    }

    const usedLabel = (r[13] ?? "").trim();
    let isUsedGoods = true;
    if (usedLabel === "古物") isUsedGoods = true;
    else if (usedLabel === "新品") isUsedGoods = false;
    else if (usedLabel !== "")
      warnings.push(`新品・古物判定が不明のため「古物」として扱います(値: "${usedLabel}")`);

    const counterpartyLabel = (r[14] ?? "").trim();
    let counterpartyType: CounterpartyType = "consumer";
    if (counterpartyLabel && COUNTERPARTY_LABEL_TO_VALUE[counterpartyLabel]) {
      counterpartyType = COUNTERPARTY_LABEL_TO_VALUE[counterpartyLabel];
    } else if (
      counterpartyLabel === "consumer" ||
      counterpartyLabel === "registered" ||
      counterpartyLabel === "unregistered"
    ) {
      counterpartyType = counterpartyLabel;
    } else {
      warnings.push(
        counterpartyLabel === ""
          ? `取引先区分が空欄のため「消費者(個人)」として扱います`
          : `取引先区分が不明な値のため「消費者(個人)」として扱います(値: "${counterpartyLabel}")`,
      );
    }

    const sourceType = (r[8] ?? "").trim() || "other";
    const sourceName = (r[9] ?? "").trim() || undefined;
    const sourceUrl = (r[10] ?? "").trim() || undefined;
    const brand = (r[2] ?? "").trim() || undefined;
    const model = (r[3] ?? "").trim() || undefined;
    const serialNumber = (r[4] ?? "").trim() || undefined;
    const title = (r[5] ?? "").trim() || undefined;

    const hasErrors = errors.length > 0;

    const itemInput: CreateItemWithPurchaseInput | null =
      hasErrors || !managementNo || purchasePrice == null
        ? null
        : {
            purchase_date: purchaseDate,
            source_type: sourceType,
            source_name: sourceName,
            source_url: sourceUrl,
            purchase_price: purchasePrice,
            quantity,
            category,
            brand,
            model,
            serial_number: serialNumber,
            management_no: managementNo,
            title,
            is_used_goods: isUsedGoods,
            counterparty_type: counterpartyType,
          };

    // 売上データ(販売日が入力されている場合のみ)
    let saleInput: SaleInsertInput | null = null;
    const saleDateRaw = (r[15] ?? "").trim();
    if (saleDateRaw !== "") {
      if (!DATE_RE.test(saleDateRaw)) {
        errors.push(`販売日の形式が不正です(値: "${r[15] ?? ""}")。YYYY-MM-DD形式である必要があります`);
      } else if (itemInput) {
        saleInput = {
          sale_date: saleDateRaw,
          sale_item_title: (r[16] ?? "").trim() || null,
          tracking_info: (r[17] ?? "").trim() || null,
          jp_platform_price: toNumOrNull(r[18] ?? "") ?? 0,
          jp_platform_fee: toNumOrNull(r[19] ?? "") ?? 0,
          jp_platform_shipping_collected: toNumOrNull(r[20] ?? "") ?? 0,
          shipping_cost_paid: toNumOrNull(r[21] ?? "") ?? 0,
          ebay_price_usd: toNumOrNull(r[22] ?? "") ?? 0,
          ebay_shipping_collected_usd: toNumOrNull(r[23] ?? "") ?? 0,
          ebay_handling_fee_usd: toNumOrNull(r[24] ?? "") ?? 0,
          ebay_ad_fee_usd: toNumOrNull(r[25] ?? "") ?? 0,
          exchange_rate: toNumOrNull(r[26] ?? "") ?? 150,
        };
      }
    } else if (status === "sold") {
      warnings.push("ステータスが「販売済み」ですが販売日が空欄のため、売上データは復元されません");
    }

    if (purchasePrice != null) {
      warnings.push("復元後の粗利計算に使う仕入高スナップショットは、復元時点の仕入高で再計算されます");
    }

    // 検品・Driveフォルダを管理番号で対応付け(重複扱いの行では実行時にスキップする)
    const inspectionCols = managementNo ? inspectionsByNo.get(managementNo) ?? [] : [];
    const driveFolderCols = managementNo ? driveFoldersByNo.get(managementNo) ?? [] : [];
    const inspections = inspectionCols.map((cols) => mapInspectionRow(cols, warnings));
    const driveFolders = driveFolderCols
      .map((cols) => mapDriveFolderRow(cols, errors))
      .filter((v): v is DriveFolderInsertInput => v !== null);

    if (inspections.length > 0) {
      warnings.push(`検品データ${inspections.length}件が対応付けられています`);
    }
    if (driveFolders.length > 0) {
      warnings.push(`Driveフォルダデータ${driveFolders.length}件が対応付けられています`);
    }

    mapped.push({
      rowNumber,
      managementNo: managementNo || null,
      displayTitle: title ?? category ?? null,
      displayPurchasePrice: purchasePrice,
      outcome: errors.length > 0 ? "error" : "new",
      errors,
      warnings,
      itemInput,
      finalStatus: status,
      account,
      saleInput,
      inspections,
      driveFolders,
    });
  }

  return { rows: mapped, headerErrors: [] };
}

/** 復元候補内(バッチ内)で管理番号が重複している行を検出し、2件目以降を重複扱いにする。 */
export function markInBatchDuplicateItems(rows: MappedInventoryRow[]): void {
  const seen = new Map<string, number>();
  for (const row of rows) {
    if (row.outcome !== "new" || !row.managementNo) continue;
    const count = seen.get(row.managementNo) ?? 0;
    seen.set(row.managementNo, count + 1);
    if (count > 0) {
      row.outcome = "duplicate";
      row.warnings.push("この復元データ内で管理番号が重複しています(先に出てきた行のみ復元対象とします)");
    }
  }
}

export interface InventoryExecuteResult {
  rowNumber: number;
  managementNo: string | null;
  success: boolean;
  message: string;
}

/**
 * 1行分(商品+仕入+該当すれば売上+検品+Driveフォルダ)を実際にDBへ復元する。
 * 既存の仕入台帳インポート機能と同じく createItemWithPurchase → updateItemStatus の順で商品を作成し、
 * その後に売上・検品・Driveフォルダを作成する。重複扱いの行(既存商品)は呼び出し元でスキップすること。
 */
export async function executeInventoryRestoreRow(row: MappedInventoryRow): Promise<InventoryExecuteResult> {
  if (!row.itemInput) {
    return { rowNumber: row.rowNumber, managementNo: row.managementNo, success: false, message: "復元対象外の行です" };
  }
  try {
    const result = await createItemWithPurchase(row.itemInput);

    if (row.finalStatus !== "awaiting_arrival") {
      await updateItemStatus(result.item_id, row.finalStatus);
    }

    if (row.account) {
      await updateItemBasicInfo(result.item_id, { account: row.account });
    }

    const partialFailures: string[] = [];

    if (row.saleInput) {
      const { error: saleError } = await supabase.from("sales").insert({
        item_id: result.item_id,
        ...row.saleInput,
        purchase_price_snapshot: row.itemInput.purchase_price,
      });
      if (saleError) partialFailures.push(`売上データ: ${saleError.message}`);
    }

    if (row.inspections.length > 0) {
      const { error: inspError } = await supabase
        .from("inspections")
        .insert(row.inspections.map((i) => ({ ...i, item_id: result.item_id })));
      if (inspError) partialFailures.push(`検品データ: ${inspError.message}`);
    }

    if (row.driveFolders.length > 0) {
      const { error: folderError } = await supabase
        .from("item_drive_folders")
        .insert(row.driveFolders.map((f) => ({ ...f, item_id: result.item_id })));
      if (folderError) partialFailures.push(`Driveフォルダ: ${folderError.message}`);
    }

    if (partialFailures.length > 0) {
      return {
        rowNumber: row.rowNumber,
        managementNo: result.management_no,
        success: false,
        message: `商品は作成しましたが、一部データの登録に失敗しました(${partialFailures.join(" / ")})`,
      };
    }

    return { rowNumber: row.rowNumber, managementNo: result.management_no, success: true, message: "復元完了" };
  } catch (err) {
    const message = err instanceof Error ? err.message : "不明なエラー";
    return { rowNumber: row.rowNumber, managementNo: row.managementNo, success: false, message };
  }
}

