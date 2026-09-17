import { createItemWithPurchase, type CreateItemWithPurchaseInput } from "./purchases";
import { updateItemBasicInfo, updateItemStatus } from "./items";
import { saveInspection } from "./inspections";
import { ITEM_STATUS_LABELS, type ItemStatus } from "../types";
import { COUNTERPARTY_TYPE_OPTIONS, type CounterpartyType } from "../taxDeduction";
import { supabase } from "../supabaseClient";

/**
 * 「カメラ」エクセルシート(在庫中の商品を管理する部分、行2〜151相当)から在庫システムへの一括取込ロジック。
 * 2026-08-30 ユーザー指示により追加。「仕入・販売帳」シート経由の取込(purchaseLedgerImport.ts)が
 * 販売済み商品を対象にしているのに対し、こちらは在庫中(出品中・未出品)の商品が対象。
 *
 * 対象列(1始まり、シート実物のヘッダー行で確認済み): A=機種名, B=仕入日, C=仕入品名, D=仕入先,
 * E=仕入先2, F=新品・古物判定, L=仕入高合計(ポイント考慮なし), M=ステータス(S/L), N=管理番号, O=状態(検品「その他」へ取込)。
 *
 * 【管理番号について】
 * このシートのN列(管理番号)は「260412-02」のようなYYMMDD-連番形式で、本アプリの管理番号自動生成機能
 * (suggestManagementNo、RPC: generate_management_no)と同じ形式(2026-08-30にユーザーが西暦の頭2桁を
 * 落とす形式に変更したもの)。つまりこのシートの商品は、既にアプリ上で登録済み(重複としてスキップされる)
 * ものと、まだ未登録のものが混在している可能性がある。重複判定は「仕入・販売帳」取込と同じく
 * items.management_no の完全一致で行うため、findExistingManagementNos をそのまま再利用する。
 *
 * 一部の管理番号には「!!」という接頭辞が付いている(2026-08-30時点で151件中19件)。ユーザーへの再確認の結果、
 * この接頭辞は取り除かず、セルの値をそのまま管理番号として取り込む方針に確定した(2026-08-31ユーザー指示)。
 *
 * 【ステータスについて】
 * M列(S=未出品/L=出品、ユーザー確認済み)は、将来的に値の種類を拡張したいとのユーザー指示のため、
 * items.status(既存のItemStatus enum)には変換せず、items.listing_status_code列に生の文字列
 * (S/L/空欄)としてそのまま保存する。実際の商品ステータス(ItemStatus)は「仕入・販売帳」取込と同様に、
 * ドライラン画面の「既定ステータス」選択(全行共通の初期値)+ドライラン結果表での行ごとの個別上書き、
 * という2段構えで決定する(ユーザー指示によりこの挙動を踏襲)。
 *
 * 【仕入日が空欄の行(手持ち品)について】
 * B列コメント「ブランク＝手持ち品」より、仕入日が空欄の行は手元に元々あった品物(購入取引が無い)ことを示す。
 * このアプリのcreate_item_with_purchase RPCは仕入日を必須とするため、空欄の場合は管理番号の先頭6桁
 * (YYMMDD)から日付を推定して仕入日として使用し、その旨を警告に表示する(管理番号からも推定できない
 * 場合はエラー行として取込対象外にする)。
 *
 * 【状態(O列)について】
 * 「検品」タブの「その他」項目(inspections.other_notes)へ保存する(2026-08-31、購入メモ(purchases.notes)
 * への保存から変更。ユーザー指示により、状態に関する自由記述は仕入情報ではなく検品情報として扱う方針に統一)。
 * createItemWithPurchase(RPC経由)はinspectionsを作成しないため、商品作成後にsaveInspectionで
 * other_notesのみを設定した検品レコードを新規作成する(他の検品項目は空欄のまま)。
 */

// 「仕入先」列 → アプリのsource_type区分へのマッピング(purchaseLedgerImport.tsと同じ対応表)。
const SOURCE_TYPE_MAP: Record<string, string> = {
  メルカリ: "mercari",
  ヤフオク: "yahoo_auction",
  ヤフーフリマ: "yahoo_furima",
  ラクマ: "rakuma",
};

const CATEGORY = "カメラ関連品";

export interface CameraStockRawRow {
  rowNumber: number;
  model: string | null; // A 機種名
  purchaseDateRaw: unknown; // B 仕入日(空欄=手持ち品)
  itemName: string | null; // C 仕入品名
  sourceMain: string | null; // D 仕入先
  sourceSub: string | null; // E 仕入先2
  usedGoodsLabel: string | null; // F 新品・古物判定
  purchasePrice: number | null; // L 仕入高合計(ポイント考慮なし)
  statusCode: string | null; // M ステータス(S/L)
  managementNoRaw: string | null; // N 管理番号(!!が付くことがある)
  conditionNotes: string | null; // O 状態
}

export type ImportRowOutcome = "new" | "duplicate" | "error";

export interface MappedCameraStockRow {
  raw: CameraStockRawRow;
  rowNumber: number;
  managementNo: string | null;
  outcome: ImportRowOutcome;
  errors: string[];
  warnings: string[];
  itemInput: CreateItemWithPurchaseInput | null;
  conditionNotes: string | null;
  listingStatusCode: string | null;
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

/** 管理番号の先頭「YYMMDD-」部分から仕入日(YYYY-MM-DD)を推定する。パースできなければnull。 */
function guessDateFromManagementNo(managementNo: string): string | null {
  const m = managementNo.match(/^(\d{2})(\d{2})(\d{2})-\d+/);
  if (!m) return null;
  const [, yy, mm, dd] = m;
  const year = 2000 + Number(yy);
  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * 1行分の生データを、DB取込用の形式に変換・検証する(同期処理のみ、DBアクセスなし)。
 * 重複判定(既存management_noとの照合)は別関数(findExistingManagementNos、purchaseLedgerImport.tsから再利用)で行う。
 */
export function mapCameraStockRawRow(
  raw: CameraStockRawRow,
  defaultStatus: ItemStatus,
  counterpartyType: CounterpartyType,
): MappedCameraStockRow {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 管理番号: 「!!」接頭辞が付いていてもそのまま管理番号として取り込む(2026-08-31ユーザー指示)。
  let managementNo: string | null = null;
  const rawNo = (raw.managementNoRaw ?? "").trim();
  if (!rawNo) {
    errors.push("管理番号(N列)が空欄です");
  } else {
    managementNo = rawNo;
  }

  // 仕入日: 空欄(手持ち品)の場合は管理番号から推定する。
  let purchaseDate: string | null = null;
  if (isValidDate(raw.purchaseDateRaw)) {
    const d = raw.purchaseDateRaw;
    if (d.getFullYear() < 2000 || d.getFullYear() > CURRENT_YEAR + 1) {
      errors.push(`仕入日の年が不自然です(${d.getFullYear()}年)。入力ミスの可能性があります`);
    } else {
      purchaseDate = formatDate(d);
    }
  } else if (raw.purchaseDateRaw == null || raw.purchaseDateRaw === "") {
    const guessed = managementNo ? guessDateFromManagementNo(managementNo) : null;
    if (guessed) {
      purchaseDate = guessed;
      warnings.push(
        `仕入日が空欄(手持ち品)のため、管理番号「${managementNo}」の日付部分から仕入日を「${guessed}」と推定しました。正確な日付が分かる場合は取込後に修正してください`,
      );
    } else {
      errors.push("仕入日が空欄で、かつ管理番号からも日付を推定できませんでした");
    }
  } else {
    errors.push(`仕入日が日付形式ではありません(値: ${JSON.stringify(raw.purchaseDateRaw)})`);
  }

  if (!raw.itemName || !raw.itemName.trim()) {
    warnings.push("仕入品名が空欄です");
  }

  if (raw.purchasePrice == null) {
    errors.push("仕入高(L列)が空欄です");
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

  const listingStatusCode = raw.statusCode && raw.statusCode.trim() ? raw.statusCode.trim() : null;
  const conditionNotes = raw.conditionNotes && raw.conditionNotes.trim() ? raw.conditionNotes.trim() : null;

  const hasErrors = errors.length > 0;

  const itemInput: CreateItemWithPurchaseInput | null =
    hasErrors || !purchaseDate || !managementNo
      ? null
      : {
          purchase_date: purchaseDate,
          source_type: sourceType,
          source_name: sourceName,
          purchase_price: raw.purchasePrice ?? 0,
          quantity: 1,
          category: CATEGORY,
          model: raw.model ?? undefined,
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
    conditionNotes,
    listingStatusCode,
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

/**
 * sales テーブルへの挿入用データ(purchaseLedgerImport.ts の SaleInsertInput と同一形状)。
 * 2026-09-03、「カメラ在庫(Sheet1・販売済み)の一括取込」(SoldCameraStockImportPanel.tsx)対応のため追加。
 * 「カメラ」シート・Sheet1のどちらにも実際の販売日・販売額の列が存在しないため、この型を使う側
 * (SoldCameraStockImportPanel.tsx)で販売日にセンチネル値(9999-12-31、ユーザー確認済み)・
 * 金額欄は全て0円をセットして渡す想定。
 */
export interface CameraStockSaleInsertInput {
  sale_date: string;
  sale_item_title: string | null;
  tracking_info: string | null;
  sales_record_reference: string | null;
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

/**
 * 1行分を実際にDBへ取り込む(items+purchases作成 → ステータス・在庫シートステータスコード更新 → 状態メモ更新
 * → (saleInputが渡された場合のみ)sales作成)。
 * saleInputは「カメラ在庫(未出品・出品中商品)の一括取込」(CameraStockImportPanel.tsx)からは渡されず
 * (未指定=undefined)、従来通りitems+purchasesのみ作成する。「カメラ在庫(Sheet1・販売済み)の一括取込」
 * (SoldCameraStockImportPanel.tsx)からのみ渡され、その場合はsalesレコードも追加作成する
 * (2026-09-03、ユーザー指示により追加)。
 */
export async function executeCameraStockImportRow(
  row: MappedCameraStockRow,
  saleInput?: CameraStockSaleInsertInput | null,
): Promise<ExecuteResult> {
  if (!row.itemInput) {
    return { rowNumber: row.rowNumber, managementNo: row.managementNo, success: false, message: "取込対象外の行です" };
  }
  try {
    const result = await createItemWithPurchase(row.itemInput);

    if (row.finalStatus !== "awaiting_arrival") {
      await updateItemStatus(result.item_id, row.finalStatus);
    }

    if (row.listingStatusCode) {
      await updateItemBasicInfo(result.item_id, { listing_status_code: row.listingStatusCode });
    }

    if (row.conditionNotes) {
      try {
        await saveInspection({
          item_id: result.item_id,
          inspected_by: null,
          overall_notes: null,
          overall_notes_en: null,
          appearance_notes: null,
          appearance_notes_en: null,
          electrical_notes: null,
          electrical_notes_en: null,
          shutter_notes: null,
          shutter_notes_en: null,
          aperture_exposure_notes: null,
          aperture_exposure_notes_en: null,
          film_transport_notes: null,
          film_transport_notes_en: null,
          viewfinder_notes: null,
          viewfinder_notes_en: null,
          lens_notes: null,
          lens_notes_en: null,
          flash_notes: null,
          flash_notes_en: null,
          autofocus_notes: null,
          autofocus_notes_en: null,
          zoom_notes: null,
          zoom_notes_en: null,
          film_counter_notes: null,
          film_counter_notes_en: null,
          self_timer_notes: null,
          self_timer_notes_en: null,
          other_notes: row.conditionNotes,
          other_notes_en: null,
          condition_grade: null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "不明なエラー";
        return {
          rowNumber: row.rowNumber,
          managementNo: result.management_no,
          success: false,
          message: `商品は作成しましたが、状態(検品「その他」)の保存に失敗しました: ${message}`,
        };
      }
    }

    if (saleInput) {
      const { error: saleError } = await supabase.from("sales").insert({
        item_id: result.item_id,
        ...saleInput,
        purchase_price_snapshot: row.itemInput.purchase_price,
      });
      if (saleError) {
        return {
          rowNumber: row.rowNumber,
          managementNo: result.management_no,
          success: false,
          message: `商品は作成しましたが、売上データの登録に失敗しました: ${saleError.message}`,
        };
      }
    }

    const appliedStatusLabel = ITEM_STATUS_LABELS[row.finalStatus];
    const appliedCounterpartyType = row.itemInput?.counterparty_type;
    const appliedCounterpartyLabel =
      COUNTERPARTY_TYPE_OPTIONS.find((o) => o.value === appliedCounterpartyType)?.label ?? appliedCounterpartyType;
    return {
      rowNumber: row.rowNumber,
      managementNo: result.management_no,
      success: true,
      message: saleInput
        ? `取込完了(登録ステータス: ${appliedStatusLabel} / 取引先区分: ${appliedCounterpartyLabel} / 売上データも登録済み・金額は仮登録のため後で修正してください)`
        : `取込完了(登録ステータス: ${appliedStatusLabel} / 取引先区分: ${appliedCounterpartyLabel})`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "不明なエラー";
    return { rowNumber: row.rowNumber, managementNo: row.managementNo, success: false, message };
  }
}
