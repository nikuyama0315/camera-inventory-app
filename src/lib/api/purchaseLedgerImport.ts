import { supabase } from "../supabaseClient";
import { createItemWithPurchase, updatePurchase, type CreateItemWithPurchaseInput } from "./purchases";
import { updateItemStatus, updateItemBasicInfo } from "./items";
import type { ItemStatus } from "../types";
import type { CounterpartyType } from "../taxDeduction";

/**
 * 「仕入・販売帳」エクセルシートから在庫システムへの一括取込ロジック。
 * 2026-08-29 時点で確認した実データ(仕入販売帳古物台帳_2026.xlsx)の列構成・既存インポート実績
 * (management_no が "C"+No. 形式の138件が既に取込済み)に基づいてマッピングしている。
 *
 * 取引先区分(counterparty_type、消費税の仕入税額控除率の判定に使う)はエクセル側に対応する列が無いため、
 * この関数では既定値「consumer(消費者)」でマッピングする(第3引数、呼び出し元は現状常に"consumer"を渡す)。
 * (2026-08-29: 従来は確認なしで「consumer」に決め打ちしていたが、freee CSV出力の税区分判定に使われることが
 * 分かったため、ドライラン画面上で明示的に選択・確認できるようにした。さらに同日、取込全体への一律適用では
 * 事業者からの仕入が混ざる場合に不便なため、この一律適用の仕組みは廃止し、ドライラン結果の表(LedgerImportPage.tsx)
 * 側で商品ごとに`itemInput.counterparty_type`を個別に上書きできるようにした)。
 *
 * 2026-08-29: 衣類(J)・雑貨(M)の行はB列「No.」が空欄なことがほとんどで、従来はNo.が無いとエラー扱いにして
 * 取込対象外にしていたため、衣類・雑貨の売上データ(邦プラットフォームの販売価格・手数料を含む)が実質的に
 * 一切データベースへ取り込まれていなかった。No.が空欄の場合は行番号ベースの仮の管理番号を自動採番して
 * 取込可能にした。また、販売日が空欄なのに販売額(邦プラットフォーム/eBay)が入力されている行は、
 * 売上データが作られない(仕入のみ登録される)ことをドライラン画面で強く警告するようにした(criticalWarnings)。
 *
 * 2026-08-31: カメラ(C)行の管理番号体系を、カメラ在庫シート経由の取込(cameraStockImport.ts)と統一しようとした
 * (従来の「C」+No.連番方式を廃止し、B列にカメラ在庫シートと同じ管理番号を直接記入する運用)が、同日中に
 * ユーザーがシート側のB列を独自の識別子「Sales #」(eBayのSales Record Number相当、例: 469)を記入する運用に
 * 変更したため、この統一方式は破棄した(詳細は下記2026-08-31(2)参照)。
 *
 * 2026-08-31(2): 上記を受けてカメラ(C)行の取込方式を再設計。B列「Sales #」はitems.management_noとは無関係の
 * 別IDのため、C行はB列の値をmanagement_noとして扱わない(上書きしない)。カメラ(C)行の商品は「カメラ」シート側
 * (cameraStockImport.ts)で既に登録済みという前提とし、両シート共通の「仕入品名・仕入先・仕入先2・
 * 仕入高」の4項目が全て一致することで既存商品を突合する(applyCameraAttributeMatches。当初は「仕入先・
 * 仕入先2・新品/古物判定・仕入高」の4項目(仕入品名を含まない)だったが、ユーザー指示により2026-09-01(7)に
 * 「仕入品名・仕入先・仕入先2・仕入高」(新品/古物判定を含まない)へ変更した)。
 * 2026-09-01(5): 突合結果の扱いをユーザー指示によりさらに変更。一致した場合はitems/purchasesを新規作成せず、
 * 突合先の既存商品をこの行の内容で上書き更新してから売上(sales)データを追加登録する(matchedExistingItemId /
 * matchedPurchaseId、従来は「売上のみ追加登録」だったが「商品情報も上書き更新」に変更)。ただし突合先に
 * 既に売上データが登録済みの場合(再取込等)は、売上の重複登録を避けるため商品情報の更新のみ行い、売上の
 * 追加登録はスキップする(matchedHasExistingSale、LedgerImportPage.tsxのドライラン処理で
 * findItemsWithExistingSales()により判定)。一致しなかった場合はエラーにはせず、mapRawRow()が採番した仮の
 * 管理番号(`C-R${行番号}`)のまま新規商品として登録する(従来は「取込対象外のエラー」だったが「新規登録」に
 * 変更)。2項目以上該当し一意に特定できない場合のみ、誤った商品を更新しないためエラー行として取込対象外にする
 * (この「複数該当時はエラーのまま」という点はユーザー指示に明記されていないための設計判断)。
 * B列「Sales #」自体の値は、C/M/J全アカウント区分共通で`sales.sales_record_reference`列にそのまま保存する
 * (management_noとは完全に独立したフィールドとして両方保持し、どちらも他方で上書きしない)。
 * M(雑貨)・J(衣類)行は、別シートでの先行登録が無いため引き続き本シート内で新規にitems/purchasesを作成する
 * 従来方式のまま(管理番号もB列の値から`${account}${serial}`形式で生成する、変更なし)。
 */

// 1列目「アカウント」の区分。C=カメラ関連品, M=雑貨, J=衣類(「衣類・雑貨」シートと同じ区分で確認済み)。
export const ACCOUNT_CATEGORY_MAP: Record<string, string> = {
  C: "カメラ関連品",
  M: "雑貨",
  J: "衣類",
};

// 「仕入先」列 → アプリのsource_type区分へのマッピング。該当なしは "other"。
const SOURCE_TYPE_MAP: Record<string, string> = {
  メルカリ: "mercari",
  ヤフオク: "yahoo_auction",
  ヤフーフリマ: "yahoo_furima",
  ラクマ: "rakuma",
};

export interface LedgerRawRow {
  rowNumber: number;
  account: string | null;
  serial: number | null;
  /** No.(Sales #)列の生の文字列値。数値化できない文字列も保持できるよう文字列型にしている。
   * カメラ(C)行のmanagement_noには使わない(2026-08-31改訂、詳細はファイル先頭コメント参照)。 */
  serialRaw: string | null;
  /** 「Sales #」列(B列)の値をそのまま保持する。management_noとは独立して`sales.sales_record_reference`に保存する。 */
  salesRecordRef: string | null;
  purchaseDateRaw: unknown;
  itemName: string | null;
  sourceMain: string | null;
  sourceSub: string | null;
  usedGoodsLabel: string | null;
  purchasePrice: number | null;
  quantity: number | null;
  saleItemTitle: string | null;
  saleDateRaw: unknown;
  trackingInfo: string | null;
  jpPrice: number | null;
  jpFee: number | null;
  jpShippingCollected: number | null;
  shippingCostPaid: number | null;
  ebayPriceUsd: number | null;
  ebayShippingCollectedUsd: number | null;
  ebayFeeUsd: number | null;
  exchangeRate: number | null;
}

export type ImportRowOutcome = "new" | "duplicate" | "error";

export interface SaleInsertInput {
  sale_date: string;
  sale_item_title: string | null;
  tracking_info: string | null;
  /** 「Sales #」列の値。items.management_noとは別物として保持する。 */
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

export interface MappedRow {
  raw: LedgerRawRow;
  rowNumber: number;
  managementNo: string | null;
  outcome: ImportRowOutcome;
  errors: string[];
  warnings: string[];
  /** 販売日が空欄なのに販売額が入力されている、など見落とすと売上データが欠落する重大な警告。 */
  criticalWarnings: string[];
  itemInput: CreateItemWithPurchaseInput | null;
  saleInput: SaleInsertInput | null;
  finalStatus: ItemStatus;
  /** カメラ(C)行のみ: 「仕入品名・仕入先・仕入先2・仕入高」突合で見つかった既存商品(カメラシート取込済み)のID。
   *  設定されている場合、items/purchasesは新規作成せず、この商品をitemInputの内容で更新(上書き)してから
   *  売上を追加登録する(2026-09-01(4)、「売上のみ追加登録」から変更)。
   *  applyCameraAttributeMatches()で解決するため、mapRawRow()の時点ではnull。 */
  matchedExistingItemId?: string | null;
  /** 上記で突合した既存商品の現在の仕入高(sales.purchase_price_snapshotに使う)。 */
  matchedPurchasePrice?: number | null;
  /** 上記で突合した既存商品のpurchasesレコードのID(updatePurchase()での更新に使う)。 */
  matchedPurchaseId?: string | null;
  /** 突合先の既存商品に既に売上(sales)データが登録済みかどうか(applyCameraAttributeMatches()の呼び出し元、
   *  LedgerImportPageのドライラン処理でfindItemsWithExistingSales()を使って設定する)。trueの場合、
   *  executeImportRow()は商品情報の更新は行うが、売上の重複登録を避けるため新規の売上登録はスキップする。 */
  matchedHasExistingSale?: boolean;
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
 * 重複判定(既存management_noとの照合)は別関数(findExistingManagementNos)で行う。
 */
export function mapRawRow(
  raw: LedgerRawRow,
  defaultStatusForUnsold: ItemStatus,
  counterpartyType: CounterpartyType,
): MappedRow {
  const errors: string[] = [];
  const warnings: string[] = [];

  const account = (raw.account ?? "").trim();
  const category = ACCOUNT_CATEGORY_MAP[account];
  if (!category) {
    errors.push(`不明なアカウント区分です(値: "${raw.account ?? ""}")`);
  }

  // 販売日(売却済みかどうか)の判定は、カメラ(C)行・雑貨/衣類(M/J)行で共通のロジック。
  let saleDate: string | null = null;
  let saleDateError = false;
  const criticalWarnings: string[] = [];
  if (raw.saleDateRaw != null && raw.saleDateRaw !== "") {
    if (!isValidDate(raw.saleDateRaw)) {
      errors.push(`販売日が日付形式ではありません(値: ${JSON.stringify(raw.saleDateRaw)})`);
      saleDateError = true;
    } else {
      const d = raw.saleDateRaw;
      if (d.getFullYear() < 2000 || d.getFullYear() > CURRENT_YEAR + 1) {
        errors.push(`販売日の年が不自然です(${d.getFullYear()}年)。入力ミスの可能性があります`);
        saleDateError = true;
      } else {
        saleDate = formatDate(d);
      }
    }
  } else {
    // 販売日が空欄でも、邦プラットフォーム/eBayの金額が入力されている場合は「売れているのに販売日の
    // 入力漏れで売上データが作られない」ケースの可能性が高いため、強い警告を出す(2026-08-29)。
    const hasSaleAmounts = [
      raw.jpPrice,
      raw.jpFee,
      raw.jpShippingCollected,
      raw.ebayPriceUsd,
      raw.ebayShippingCollectedUsd,
      raw.ebayFeeUsd,
    ].some((v) => v != null && v !== 0);
    if (hasSaleAmounts) {
      criticalWarnings.push(
        "販売日が空欄のため売上データは取り込まれません(仕入・商品データのみ登録されます)。邦プラットフォーム/eBayの販売価格・手数料が入力されているため、エクセル側の販売日の入力漏れの可能性があります",
      );
    }
  }

  const finalStatus: ItemStatus = saleDate ? "sold" : defaultStatusForUnsold;

  if (account === "C") {
    // カメラ(C)行: 2026-09-01(4)突合方式変更。B列「Sales #」はitems.management_noとは無関係の別IDのため、
    // management_noとしては使わない(上書きしない)。この行の商品は「カメラ」シート側(cameraStockImport.ts)で
    // 既に登録済みという前提とし、両シート共通の「仕入品名・仕入先・仕入先2・仕入高」の4項目が全て
    // 一致することで既存商品を突合する(突合はDBアクセスを要するため、この関数では行わず
    // applyCameraAttributeMatches()で後段実施する)。ここではM/J行と同様にitemInputを組み立てておき、
    // 後段の突合結果に応じて使い分ける: 一致した場合は既存商品をこの内容で更新(上書き)し、一致しなかった
    // 場合は下記の仮の管理番号のまま新規商品として登録する(ユーザー指示により、一致しない場合もエラーで
    // スキップせず登録する方式に変更、2026-09-01)。
    const provisionalManagementNo = `C-R${raw.rowNumber}`;

    let purchaseDate: string | null = null;
    if (!isValidDate(raw.purchaseDateRaw)) {
      errors.push(`仕入日が日付形式ではありません(値: ${JSON.stringify(raw.purchaseDateRaw)})`);
    } else {
      const d = raw.purchaseDateRaw;
      if (d.getFullYear() < 2000 || d.getFullYear() > CURRENT_YEAR + 1) {
        errors.push(`仕入日の年が不自然です(${d.getFullYear()}年)。入力ミスの可能性があります`);
      } else {
        purchaseDate = formatDate(d);
      }
    }

    if (!raw.itemName || !raw.itemName.trim()) {
      errors.push("仕入品名が空欄のため、カメラシート側の商品と突合できません");
    }
    if (raw.purchasePrice == null) {
      errors.push("仕入高が空欄のため、カメラシート側の商品と突合できません");
    }

    const { sourceType, sourceName, isUsedGoods, usedGoodsWarning } = deriveCameraMatchAttributes(raw);
    if (usedGoodsWarning) warnings.push(usedGoodsWarning);

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
            category: category ?? "カメラ関連品",
            management_no: provisionalManagementNo,
            title: raw.itemName ?? undefined,
            is_used_goods: isUsedGoods,
            counterparty_type: counterpartyType,
          };

    const saleInput: SaleInsertInput | null =
      !itemInput || !saleDate || saleDateError
        ? null
        : {
            sale_date: saleDate,
            sale_item_title: raw.saleItemTitle,
            tracking_info: raw.trackingInfo,
            sales_record_reference: raw.salesRecordRef,
            jp_platform_price: raw.jpPrice ?? 0,
            jp_platform_fee: raw.jpFee ?? 0,
            jp_platform_shipping_collected: raw.jpShippingCollected ?? 0,
            shipping_cost_paid: raw.shippingCostPaid ?? 0,
            ebay_price_usd: raw.ebayPriceUsd ?? 0,
            ebay_shipping_collected_usd: raw.ebayShippingCollectedUsd ?? 0,
            ebay_handling_fee_usd: raw.ebayFeeUsd ?? 0,
            ebay_ad_fee_usd: 0,
            exchange_rate: raw.exchangeRate ?? 150,
          };

    return {
      raw,
      rowNumber: raw.rowNumber,
      managementNo: itemInput ? provisionalManagementNo : null,
      outcome: hasErrors ? "error" : "new",
      errors,
      warnings,
      criticalWarnings,
      itemInput,
      saleInput,
      finalStatus,
      matchedExistingItemId: null,
      matchedPurchasePrice: null,
      matchedPurchaseId: null,
      matchedHasExistingSale: false,
    };
  }

  // ここから雑貨(M)・衣類(J)行。別シートでの先行登録が無いため、従来通り本シート内で新規にitems/purchasesを
  // 作成する。No.(Sales #)が空欄の行は、行番号ベースの仮の管理番号を自動採番して取込可能にする(2026-08-29)。
  // 後で「在庫」タブから管理番号を編集できる。
  let managementNo: string | null;
  if (raw.serial == null) {
    managementNo = `${account}-R${raw.rowNumber}`;
    warnings.push(
      `No.(シリアル番号)が空欄のため、行番号から仮の管理番号「${managementNo}」を自動採番しました(正式な管理番号に変更したい場合は取込後に商品の管理番号を編集してください)`,
    );
  } else {
    managementNo = `${account}${raw.serial}`;
  }

  let purchaseDate: string | null = null;
  if (!isValidDate(raw.purchaseDateRaw)) {
    errors.push(`仕入日が日付形式ではありません(値: ${JSON.stringify(raw.purchaseDateRaw)})`);
  } else {
    const d = raw.purchaseDateRaw;
    if (d.getFullYear() < 2000 || d.getFullYear() > CURRENT_YEAR + 1) {
      errors.push(`仕入日の年が不自然です(${d.getFullYear()}年)。入力ミスの可能性があります`);
    } else {
      purchaseDate = formatDate(d);
    }
  }

  if (!raw.itemName || !raw.itemName.trim()) {
    warnings.push("仕入品名が空欄です");
  }

  if (raw.purchasePrice == null) {
    errors.push("仕入高が空欄です");
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
    hasErrors || !purchaseDate || !managementNo
      ? null
      : {
          purchase_date: purchaseDate,
          source_type: sourceType,
          source_name: sourceName,
          purchase_price: raw.purchasePrice ?? 0,
          quantity: raw.quantity ?? 1,
          category: category ?? "その他",
          management_no: managementNo,
          title: raw.itemName ?? undefined,
          is_used_goods: isUsedGoods,
          counterparty_type: counterpartyType,
        };

  const saleInput: SaleInsertInput | null =
    !itemInput || !saleDate || saleDateError
      ? null
      : {
          sale_date: saleDate,
          sale_item_title: raw.saleItemTitle,
          tracking_info: raw.trackingInfo,
          sales_record_reference: raw.salesRecordRef,
          jp_platform_price: raw.jpPrice ?? 0,
          jp_platform_fee: raw.jpFee ?? 0,
          jp_platform_shipping_collected: raw.jpShippingCollected ?? 0,
          shipping_cost_paid: raw.shippingCostPaid ?? 0,
          ebay_price_usd: raw.ebayPriceUsd ?? 0,
          ebay_shipping_collected_usd: raw.ebayShippingCollectedUsd ?? 0,
          ebay_handling_fee_usd: raw.ebayFeeUsd ?? 0,
          ebay_ad_fee_usd: 0,
          exchange_rate: raw.exchangeRate ?? 150,
        };

  return {
    raw,
    rowNumber: raw.rowNumber,
    managementNo,
    outcome: hasErrors ? "error" : "new",
    errors,
    warnings,
    criticalWarnings,
    itemInput,
    saleInput,
    finalStatus,
    matchedExistingItemId: null,
    matchedPurchasePrice: null,
  };
}

// 「仕入品名」「仕入先」「仕入先2」「仕入高」の4項目から、カメラ(C)行の既存商品との突合キーを
// 組み立てる。カメラシート取込(cameraStockImport.ts)時の正規化ロジックと完全に揃える必要があるため、
// sourceType/sourceNameの導出は「仕入先」列→SOURCE_TYPE_MAPのマッピング結果、「仕入先2」列優先(無ければ
// 「仕入先」列)というcameraStockImport.tsのmapCameraStockRawRow()と同一の変換を用いる
// (2026-09-01(7)、「仕入先・仕入先2・新品/古物判定・仕入高」から「仕入品名・仕入先・仕入先2・仕入高」へ変更、
// 新品/古物判定は突合キーから除外し、代わりに仕入品名を加えた。詳細はファイル先頭コメント参照)。
function buildCameraMatchKey(
  itemName: string,
  sourceType: string,
  sourceName: string | null | undefined,
  purchasePrice: number,
): string {
  return JSON.stringify([itemName, sourceType, sourceName ?? null, purchasePrice]);
}

/** カメラ(C)行の生データから、突合に使う「仕入先・仕入先2・新品古物判定・仕入高」を導出する。
 *  cameraStockImport.tsのmapCameraStockRawRow()と同一の正規化ロジック(SOURCE_TYPE_MAPでの変換、
 *  新品・古物判定の既定値フォールバック)を用いる。 */
function deriveCameraMatchAttributes(raw: LedgerRawRow): {
  sourceType: string;
  sourceName: string | undefined;
  isUsedGoods: boolean;
  usedGoodsWarning: string | null;
} {
  const usedLabel = (raw.usedGoodsLabel ?? "").trim();
  let isUsedGoods = true;
  let usedGoodsWarning: string | null = null;
  if (usedLabel === "古物") {
    isUsedGoods = true;
  } else if (usedLabel === "新品") {
    isUsedGoods = false;
  } else {
    usedGoodsWarning = `新品・古物判定が不明のため「古物」として扱います(値: "${raw.usedGoodsLabel ?? ""}")`;
  }

  const sourceType = raw.sourceMain ? SOURCE_TYPE_MAP[raw.sourceMain.trim()] ?? "other" : "other";
  const sourceName = (raw.sourceSub && raw.sourceSub.trim()) || (raw.sourceMain && raw.sourceMain.trim()) || undefined;

  return { sourceType, sourceName, isUsedGoods, usedGoodsWarning };
}
/**
 * カメラ(C)行の「仕入品名・仕入先・仕入先2・仕入高」突合(2026-09-01(7)、動作を変更)。
 * 「カメラ関連品」カテゴリの既存商品(items+purchases)を全件取得し、対象C行それぞれについて、
 * 4項目が一致する既存商品が見つかった場合はmanagementNo・matchedExistingItemId・matchedPurchaseId・
 * matchedPurchasePriceを解決する(executeImportRow側で既存商品の更新に使う)。一致する商品が無い場合は
 * エラーにはせず、mapRawRow()が採番した仮の管理番号のまま新規商品として登録する扱いにする(警告を追加)。
 * 複数該当して一意に特定できない場合のみエラー行とする(誤った商品を更新してしまう事故を避けるため)。
 * DBアクセスを伴うため、mapRawRow()とは別関数として後段(ドライラン時)に呼び出す。絞り込みクエリを
 * 使わず全件取得するのは、仕入品名でのin()チャンク検索がURL長超過でリクエスト自体が失敗した過去の不具合
 * (2026-09-01発覚・修正)を踏まえた設計。
 */
export async function applyCameraAttributeMatches(rows: MappedRow[]): Promise<void> {
  const targets = rows.filter((r) => (r.raw.account ?? "").trim() === "C" && r.outcome !== "error");
  if (targets.length === 0) return;

  const { data, error } = await supabase
    .from("items")
    .select("id, management_no, title, purchases(id, purchase_price, source_type, source_name)")
    .eq("category", "カメラ関連品");
  if (error) throw error;

  const matchesByKey = new Map<
    string,
    { id: string; management_no: string; purchase_id: string; purchase_price: number }[]
  >();
  for (const row of data as unknown as Array<{
    id: string;
    management_no: string;
    title: string | null;
    purchases:
      | {
          id: string;
          purchase_price: number;
          source_type: string | null;
          source_name: string | null;
        }
      | {
          id: string;
          purchase_price: number;
          source_type: string | null;
          source_name: string | null;
        }[]
      | null;
  }>) {
    const purchase = Array.isArray(row.purchases) ? row.purchases[0] : row.purchases;
    if (!purchase) continue;
    const key = buildCameraMatchKey(
      (row.title ?? "").trim(),
      purchase.source_type ?? "other",
      purchase.source_name,
      purchase.purchase_price,
    );
    const list = matchesByKey.get(key) ?? [];
    list.push({
      id: row.id,
      management_no: row.management_no,
      purchase_id: purchase.id,
      purchase_price: purchase.purchase_price,
    });
    matchesByKey.set(key, list);
  }

  for (const row of targets) {
    if (!row.itemInput) continue; // 仕入日等が不正でmapRawRow()側で既にerror済みのはず

    const attrs = deriveCameraMatchAttributes(row.raw);
    const itemName = (row.raw.itemName ?? "").trim();
    const key = buildCameraMatchKey(itemName, attrs.sourceType, attrs.sourceName, row.itemInput.purchase_price);
    const candidates = matchesByKey.get(key) ?? [];
    const desc = `仕入品名="${itemName}" / 仕入先="${row.raw.sourceMain ?? ""}" / 仕入先2="${
      row.raw.sourceSub ?? ""
    }" / 仕入高=${row.itemInput.purchase_price}円`;

    if (candidates.length > 1) {
      row.outcome = "error";
      row.errors.push(
        `「仕入品名・仕入先・仕入先2・仕入高」が一致するカメラ商品が複数見つかったため一意に特定できませんでした(誤った商品を更新しないためエラーとして取込対象外にします): ${desc}(候補: ${candidates
          .map((c) => c.management_no)
          .join(", ")})`,
      );
      continue;
    }

    if (candidates.length === 1) {
      const match = candidates[0];
      row.managementNo = match.management_no;
      row.matchedExistingItemId = match.id;
      row.matchedPurchaseId = match.purchase_id;
      row.matchedPurchasePrice = match.purchase_price;
    } else {
      row.warnings.push(
        `「仕入品名・仕入先・仕入先2・仕入高」が一致するカメラ商品が見つからなかったため、新規商品(仮の管理番号「${row.itemInput.management_no}」)として登録します: ${desc}`,
      );
    }
  }
}

/** 突合済みのカメラ(C)行のうち、既にsalesデータが登録済みの商品(=このシートの再取込で二重登録になる)を調べる。 */
export async function findItemsWithExistingSales(itemIds: string[]): Promise<Set<string>> {
  if (itemIds.length === 0) return new Set();
  const uniqueIds = Array.from(new Set(itemIds));
  const CHUNK = 200;
  const found = new Set<string>();
  for (let i = 0; i < uniqueIds.length; i += CHUNK) {
    const chunk = uniqueIds.slice(i, i + CHUNK);
    const { data, error } = await supabase.from("sales").select("item_id").in("item_id", chunk);
    if (error) throw error;
    for (const row of data ?? []) {
      found.add((row as { item_id: string }).item_id);
    }
  }
  return found;
}

/** 取込対象候補のmanagement_noのうち、既にDBに存在するものを調べる(重複判定用)。 */
export async function findExistingManagementNos(managementNos: string[]): Promise<Set<string>> {
  if (managementNos.length === 0) return new Set();
  const uniqueNos = Array.from(new Set(managementNos));
  const CHUNK = 200;
  const found = new Set<string>();
  for (let i = 0; i < uniqueNos.length; i += CHUNK) {
    const chunk = uniqueNos.slice(i, i + CHUNK);
    const { data, error } = await supabase.from("items").select("management_no").in("management_no", chunk);
    if (error) throw error;
    for (const row of data ?? []) {
      found.add((row as { management_no: string }).management_no);
    }
  }
  return found;
}

export interface ExecuteResult {
  rowNumber: number;
  managementNo: string | null;
  success: boolean;
  /** true の場合、既存の登録済み商品と管理番号が一致したため実際の登録・更新は行わずスキップしたことを示す。 */
  skipped?: boolean;
  message: string;
}

export interface InventoryDataCounts {
  items: number;
  purchases: number;
  sales: number;
}

/** items/purchases/salesの件数を取得する(「登録データ全クリア」機能の確認表示用)。 */
export async function getInventoryDataCounts(): Promise<InventoryDataCounts> {
  const [itemsRes, purchasesRes, salesRes] = await Promise.all([
    supabase.from("items").select("id", { count: "exact", head: true }),
    supabase.from("purchases").select("id", { count: "exact", head: true }),
    supabase.from("sales").select("id", { count: "exact", head: true }),
  ]);
  if (itemsRes.error) throw itemsRes.error;
  if (purchasesRes.error) throw purchasesRes.error;
  if (salesRes.error) throw salesRes.error;
  return { items: itemsRes.count ?? 0, purchases: purchasesRes.count ?? 0, sales: salesRes.count ?? 0 };
}

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * システム内の在庫関連データ(items・purchases・sales、およびitems削除でCASCADE削除される
 * inspections・item_drive_folders・item_drive_folder_moves・purchase_returns)を全件削除する。
 * 取り返しがつかないため、呼び出し元(画面側)で必ず確認を取ってから呼ぶこと。
 */
export async function clearAllInventoryData(): Promise<void> {
  // expenses.related_item_id は items への外部キー(ON DELETE NO ACTION)のため、
  // items削除前に参照を解除しておく(経費データ自体は削除しない)。
  const { error: expError } = await supabase
    .from("expenses")
    .update({ related_item_id: null })
    .not("related_item_id", "is", null);
  if (expError) throw expError;

  // sales.item_id も items への外部キー(ON DELETE NO ACTION)のため、items削除前に削除する。
  const { error: salesError } = await supabase.from("sales").delete().neq("id", ZERO_UUID);
  if (salesError) throw salesError;

  // items削除により、purchases・inspections・item_drive_folders・item_drive_folder_moves・
  // purchase_returns はCASCADEで自動的に削除される。
  const { error: itemsError } = await supabase.from("items").delete().neq("id", ZERO_UUID);
  if (itemsError) throw itemsError;
}

/** 1行分を実際にDBへ取り込む(items+purchases作成 → ステータス更新 → 該当すればsales作成)。 */
export async function executeImportRow(row: MappedRow): Promise<ExecuteResult> {
  if (row.matchedExistingItemId && row.itemInput) {
    // カメラ(C)行で「仕入品名・仕入先・仕入先2・仕入高」突合により既存商品が見つかった場合: items/purchasesを
    // 新規作成せず、突合先の既存商品をこの行の内容で上書き(更新)してから、売上を追加登録する(2026-09-01、
    // ユーザー指示により「売上のみ追加登録」から「上書き更新」に変更)。management_no自体は更新対象に含めない
    // (突合先の既存商品のものを維持し、Sales #列の値で上書きしない、という従来からの要件を継続)。
    try {
      await updateItemBasicInfo(row.matchedExistingItemId, {
        title: row.itemInput.title ?? null,
      });
      if (row.matchedPurchaseId) {
        await updatePurchase(row.matchedPurchaseId, {
          purchase_date: row.itemInput.purchase_date,
          source_type: row.itemInput.source_type,
          source_name: row.itemInput.source_name ?? null,
          purchase_price: row.itemInput.purchase_price,
          quantity: row.itemInput.quantity,
          is_used_goods: row.itemInput.is_used_goods,
          counterparty_type: row.itemInput.counterparty_type,
        });
      }
      if (row.finalStatus !== "awaiting_arrival") {
        await updateItemStatus(row.matchedExistingItemId, row.finalStatus);
      }

      if (row.saleInput && !row.matchedHasExistingSale) {
        const { error: saleError } = await supabase.from("sales").insert({
          item_id: row.matchedExistingItemId,
          ...row.saleInput,
          purchase_price_snapshot: row.itemInput.purchase_price,
        });
        if (saleError) {
          return {
            rowNumber: row.rowNumber,
            managementNo: row.managementNo,
            success: false,
            message: `商品情報は更新しましたが、売上データの登録に失敗しました: ${saleError.message}`,
          };
        }
      }

      return {
        rowNumber: row.rowNumber,
        managementNo: row.managementNo,
        success: true,
        message: row.matchedHasExistingSale
          ? "取込完了(既存商品を更新。売上データは登録済みのため追加していません)"
          : "取込完了(既存商品を更新)",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "不明なエラー";
      return { rowNumber: row.rowNumber, managementNo: row.managementNo, success: false, message };
    }
  }

  if (!row.itemInput) {
    return { rowNumber: row.rowNumber, managementNo: row.managementNo, success: false, message: "取込対象外の行です" };
  }
  try {
    const result = await createItemWithPurchase(row.itemInput);

    if (row.finalStatus !== "awaiting_arrival") {
      await updateItemStatus(result.item_id, row.finalStatus);
    }

    if (row.saleInput) {
      const { error: saleError } = await supabase.from("sales").insert({
        item_id: result.item_id,
        ...row.saleInput,
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

    return { rowNumber: row.rowNumber, managementNo: result.management_no, success: true, message: "取込完了" };
  } catch (err) {
    const message = err instanceof Error ? err.message : "不明なエラー";
    return { rowNumber: row.rowNumber, managementNo: row.managementNo, success: false, message };
  }
}
