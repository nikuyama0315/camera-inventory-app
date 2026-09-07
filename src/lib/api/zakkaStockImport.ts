import { createItemWithPurchase, type CreateItemWithPurchaseInput } from "./purchases";
import { updateItemStatus } from "./items";
import { ITEM_STATUS_LABELS, type ItemStatus } from "../types";
import { COUNTERPARTY_TYPE_OPTIONS, type CounterpartyType } from "../taxDeduction";

/**
 * 「仕入・販売帳」エクセルシートの雑貨在庫ブロック(既定は行529〜881、C〜H列)から在庫システムへの
 * 一括取込ロジック。2026-09-03 ユーザー指示により追加。「カメラ」エクセルシート経由の取込
 * (cameraStockImport.ts)と同じ構造で、items+purchasesのみを作成する(売上データは作成しない)。
 *
 * 対象列(1始まり、シート実物のヘッダー行で確認済み): C=仕入日, D=仕入品名, E=仕入先, F=仕入先2,
 * G=新品・古物判定, H=仕入高。A列(アカウント区分 C/M)・B列(Sales #)はこのブロックでは取込対象外
 * (2026-09-03ユーザー指示により、A列の値に関わらずカテゴリは一律「雑貨」として取り込む方針に確定。
 * 実際にサンプル確認したところ、この行範囲ではA列に「M」だけでなく「C」も混在しており、カメラの
 * アカウント区分とは異なる意味で使われているため)。
 *
 * 【管理番号について】
 * このブロックには管理番号列が存在しないため、Excelの行番号から `Z-R${行番号}` という決定的な
 * 管理番号を生成する(「仕入・販売帳」取込(purchaseLedgerImport.ts)がアカウント文字なし行に対して
 * 使っている `${account}-R${行番号}` と同じ考え方で、既存のC/M/J接頭辞と衝突しないよう「Z」を使用)。
 * 同じファイル・同じ行範囲を再取込しても同じ管理番号になるため、重複判定(findExistingManagementNos)
 * でそのまま重複スキップされる。
 */

// 「仕入先」列 → アプリのsource_type区分へのマッピング(purchaseLedgerImport.ts / cameraStockImport.tsと同じ対応表)。
const SOURCE_TYPE_MAP: Record<string, string> = {
  メルカリ: "mercari",
  ヤフオク: "yahoo_auction",
  ヤフーフリマ: "yahoo_furima",
  ラクマ: "rakuma",
};

const CATEGORY = "雑貨";

// 取引先区分の自動判定キーワード(2026-09-03ユーザー指示)。「仕入先」列の文字列に部分一致するかで判定する。
// 「ブックオフ」「駿河屋」を含む場合→適格請求書発行事業者(インボイスあり)、
// 「手持品」「ラクマ」「メルカリ」「ヤフー」を含む場合→消費者(個人)、
// これら以外は既定で適格請求書発行事業者(インボイスあり)として扱う。
const REGISTERED_SOURCE_KEYWORDS = ["ブックオフ", "駿河屋"];
const CONSUMER_SOURCE_KEYWORDS = ["手持品", "ラクマ", "メルカリ", "ヤフー"];

/** 「仕入先」列の文字列から取引先区分を自動判定する。ドライラン結果の表で行ごとに個別上書き可能。 */
export function determineCounterpartyType(sourceMain: string | null): CounterpartyType {
  const s = sourceMain ?? "";
  if (REGISTERED_SOURCE_KEYWORDS.some((k) => s.includes(k))) return "registered";
  if (CONSUMER_SOURCE_KEYWORDS.some((k) => s.includes(k))) return "consumer";
  return "registered";
}

export interface ZakkaStockRawRow {
  rowNumber: number;
  purchaseDateRaw: unknown; // C 仕入日
  itemName: string | null; // D 仕入品名
  sourceMain: string | null; // E 仕入先
  sourceSub: string | null; // F 仕入先2
  usedGoodsLabel: string | null; // G 新品・古物判定
  purchasePrice: number | null; // H 仕入高
}

export type ImportRowOutcome = "new" | "duplicate" | "error";

export interface MappedZakkaStockRow {
  raw: ZakkaStockRawRow;
  rowNumber: number;
  managementNo: string | null;
  outcome: ImportRowOutcome;
  errors: string[];
  warnings: string[];
  itemInput: CreateItemWithPurchaseInput | null;
  finalStatus: ItemStatus;
}

function isValidDate(d: unknown): d is Date {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const CURRENT_YEAR = new Date().getFullYear();

/**
 * 1行分の生データを、DB取込用の形式に変換・検証する(同期処理のみ、DBアクセスなし)。
 * 重複判定(既存management_noとの照合)は別関数(findExistingManagementNos、purchaseLedgerImport.tsから再利用)で行う。
 */
export function mapZakkaStockRawRow(
  raw: ZakkaStockRawRow,
  defaultStatus: ItemStatus,
  counterpartyType: CounterpartyType,
): MappedZakkaStockRow {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 管理番号: このブロックには管理番号列が存在しないため、行番号から決定的に生成する。
  const managementNo = `Z-R${raw.rowNumber}`;

  let purchaseDate: string | null = null;
  if (isValidDate(raw.purchaseDateRaw)) {
    const d = raw.purchaseDateRaw;
    if (d.getFullYear() < 2000 || d.getFullYear() > CURRENT_YEAR + 1) {
      errors.push(`仕入日の年が不自然です(${d.getFullYear()}年)。入力ミスの可能性があります`);
    } else {
      purchaseDate = formatDate(d);
    }
  } else if (raw.purchaseDateRaw == null || raw.purchaseDateRaw === "") {
    errors.push("仕入日(C列)が空欄です");
  } else {
    errors.push(`仕入日が日付形式ではありません(値: ${JSON.stringify(raw.purchaseDateRaw)})`);
  }

  if (!raw.itemName || !raw.itemName.trim()) {
    warnings.push("仕入品名が空欄です");
  }

  if (raw.purchasePrice == null) {
    errors.push("仕入高(H列)が空欄です");
  }

  const usedLabel = (raw.usedGoodsLabel ?? "").trim();
  let isUsedGoods = true;
  if (usedLabel === "古物") {
    isUsedGoods = true;
  } else if (usedLabel === "新品") {
    isUsedGoods = false;
  } else {
    warnings.push(`新品・古物判定が不明のため「古物」として扱います(値: "${raw.usedGoodsLabel ?? ""}")`);
  }

  const sourceType = raw.sourceMain ? SOURCE_TYPE_MAP[raw.sourceMain.trim()] ?? "other" : "other";
  const sourceName = (raw.sourceSub && raw.sourceSub.trim()) || (raw.sourceMain && raw.sourceMain.trim()) || undefined;

  const hasErrors = errors.length > 0;

  const itemInput: CreateItemWithPurchaseInput | null =
    hasErrors || !purchaseDate
      ? null
      : {
          purchase_date: purchaseDate,
          source_type: sourceType,
          source_name: sourceName,
          purchase_price: raw.purchasePrice ?? 0,
          quantity: 1,
          category: CATEGORY,
          management_no: managementNo,
          title: raw.itemName ?? undefined,
          is_used_goods: isUsedGoods,
          counterparty_type: counterpartyType,
        };

  return {
    raw,
    rowNumber: raw.rowNumber,
    managementNo,
    outcome: hasErrors ? "error" : "new",
    errors,
    warnings,
    itemInput,
    finalStatus: defaultStatus,
  };
}

export interface ExecuteResult {
  rowNumber: number;
  managementNo: string | null;
  success: boolean;
  /** true の場合、既存の登録済み商品と管理番号が一致したため実際の登録・更新は行わずスキップしたことを示す。 */
  skipped?: boolean;
  message: string;
}

/** 1行分を実際にDBへ取り込む(items+purchases作成 → ステータス更新)。 */
export async function executeZakkaStockImportRow(row: MappedZakkaStockRow): Promise<ExecuteResult> {
  if (!row.itemInput) {
    return { rowNumber: row.rowNumber, managementNo: row.managementNo, success: false, message: "取込対象外の行です" };
  }
  try {
    const result = await createItemWithPurchase(row.itemInput);

    if (row.finalStatus !== "awaiting_arrival") {
      await updateItemStatus(result.item_id, row.finalStatus);
    }

    const appliedStatusLabel = ITEM_STATUS_LABELS[row.finalStatus];
    const appliedCounterpartyType = row.itemInput?.counterparty_type;
    const appliedCounterpartyLabel =
      COUNTERPARTY_TYPE_OPTIONS.find((o) => o.value === appliedCounterpartyType)?.label ?? appliedCounterpartyType;
    return {
      rowNumber: row.rowNumber,
      managementNo: result.management_no,
      success: true,
      message: `取込完了(登録ステータス: ${appliedStatusLabel} / 取引先区分: ${appliedCounterpartyLabel})`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "不明なエラー";
    return { rowNumber: row.rowNumber, managementNo: row.managementNo, success: false, message };
  }
}
