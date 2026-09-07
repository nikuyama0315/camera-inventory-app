import { useState } from "react";
import * as XLSX from "xlsx";
import {
  mapCameraStockRawRow,
  executeCameraStockImportRow,
  type CameraStockRawRow,
  type MappedCameraStockRow,
  type ExecuteResult,
  type CameraStockSaleInsertInput,
} from "../../lib/api/cameraStockImport";
import { findExistingManagementNos } from "../../lib/api/purchaseLedgerImport";
import { ITEM_STATUS_LABELS, type ItemStatus } from "../../lib/types";
import { COUNTERPARTY_TYPE_OPTIONS, getDeductionInfo, type CounterpartyType } from "../../lib/taxDeduction";

/**
 * 「カメラ在庫(未出品・出品中商品)の一括取込」(CameraStockImportPanel.tsx)と同じ列レイアウト・
 * 同じ変換ロジック(cameraStockImport.ts、mapCameraStockRawRow)をそのまま再利用した、対象シート・
 * 行範囲・既定ステータスのみが異なる取込機能(2026-09-03追加)。
 *
 * ユーザー添付の実エクセル(仕入販売帳古物台帳_2026.xlsx)で確認した結果、「Sheet1」シートは
 * 「カメラ」シートと全く同じ列構成(A=機種名, B=仕入日, C=仕入品名, D=仕入先, E=仕入先2,
 * F=新品・古物判定, L=仕入高合計, M=ステータス, N=管理番号, O=状態)で、行2〜181(計180行)に
 * 実データがあることを確認済み(M列は全行「販売済み」)。そのため新規のマッピング関数は作成せず、
 * 既存のcameraStockImport.tsをそのまま流用している。
 *
 * 「カメラ」シート取込との違いはこの4点:
 * ①読み込みシート名が「Sheet1」、②既定の行範囲が2〜181、③既定ステータスの初期値が
 * 「sold」(販売済み)、④items+purchasesに加えてsalesレコードも作成する。
 *
 * 【sales作成方式について(2026-09-03、4度目の改訂)】
 * 当初(初版)はSheet1に実データが無いことを理由に、販売日をセンチネル値「9999-12-31」・金額を
 * 全て0円とする仮登録方式で実装したが、ユーザー指示「仕入日・仕入品名・仕入先・仕入先2の一致を
 * キーとして、仕入・販売帳シートとマッチングし、売上額、販売日は仕入・販売帳シートの値をセット
 * してください。販売日を9999-12-31にする仕様は廃止します」により全面的に方式変更した(2度目の改訂)。
 * その後、ユーザー指示「マッチング条件から、仕入日をはずして」により突合キーから仕入日を除外し、
 * 「仕入品名・仕入先・仕入先2」の3項目に変更(3度目の改訂)。さらにその後、ユーザー指示「マッチング
 * 条件を仕入先 仕入先2 新品・古物判定 仕入高(円)に変更」により、仕入品名も突合キーから外し、
 * 「仕入先・仕入先2・新品古物判定・仕入高(円)」の4項目に変更した(4度目の改訂、現行仕様)。
 *
 * 新方式: ドライラン時、同じアップロードファイル内の「仕入・販売帳」シートも読み込み、
 * 「仕入先・仕入先2・新品古物判定・仕入高(円)」の4項目が完全一致する行を突合キーとして検索する
 * (仕入品名・仕入日は突合キーに含めない)。
 * - 一致が1件かつ販売日も有効: その行の「販売日」「販売Item title」「追跡情報」「邦プラットフォーム
 *   価格・手数料・送料徴収額」「送料支払額」「eBay価格・送料徴収額・手数料(ドル)」「月末レート」を
 *   実際の売上データとして使用する(purchaseLedgerImport.tsのSaleInsertInput構築ロジックと同じ列対応)。
 * - 一致が1件だが販売日が空欄・不正: 金額等は一致した行の実データを使うが、販売日だけ仮値
 *   「FALLBACK_SALE_DATE(2025-12-01)」を使って売上データを登録する(2026-09-03、ユーザー指示
 *   「未一致になったものの販売日は2025-12-1をセットしてください」に対応。5度目の改訂)。
 * - 一致が0件: 販売日は仮値「2025-12-01」、金額は全て0円で売上データを登録する(同上のユーザー指示に
 *   対応。以前(初版)はこのケースは売上データを一切作成しなかったが、5度目の改訂でこの方式に変更)。
 * - 一致が2件以上(複数該当): 誤った売上データを紐付けてしまう事故を避けるため、この行はエラーとして
 *   取込対象外にする(仕入・販売帳側の突合ロジック(purchaseLedgerImport.tsのapplyCameraAttributeMatches)
 *   と同じ「複数該当時はエラー」という設計方針を踏襲)。この仮日付ルールは適用しない。
 *
 * この方針に基づき組み立てたCameraStockSaleInsertInputを、cameraStockImport.tsの
 * executeCameraStockImportRow()の第2引数として渡すことでsalesも作成する(第2引数省略時は
 * 従来通りsalesを作成しないため、「カメラ在庫(未出品・出品中商品)の一括取込」側の挙動には
 * 影響しない)。
 */

const SHEET_NAME = "Sheet1";
const DEFAULT_START_ROW = 2;
const DEFAULT_END_ROW = 181;

// 「仕入・販売帳」シート(LedgerImportPage.tsxが読み込んでいるものと同一シート)。突合専用に読み込む。
const LEDGER_SHEET_NAME = "仕入・販売帳";

// 列番号(1始まり、「カメラ」シート取込(CameraStockImportPanel.tsx)と同一)
const COL = {
  model: 1, // A 機種名
  purchaseDate: 2, // B 仕入日
  itemName: 3, // C 仕入品名
  sourceMain: 4, // D 仕入先
  sourceSub: 5, // E 仕入先2
  usedGoodsLabel: 6, // F 新品・古物判定
  purchasePrice: 12, // L 仕入高合計(ポイント考慮なし)
  statusCode: 13, // M ステータス
  managementNo: 14, // N 管理番号
  conditionNotes: 15, // O 状態
};

// 「仕入・販売帳」シート側の列番号(1始まり、LedgerImportPage.tsxのCOLと同一)。売上マッチングに必要な列のみ。
const LEDGER_COL = {
  serial: 2, // B Sales #(sales_record_referenceにそのまま保存)
  sourceMain: 5, // E 仕入先
  sourceSub: 6, // F 仕入先2
  usedGoodsLabel: 7, // G 新品・古物判定
  purchasePrice: 8, // H 仕入高(円)
  saleItemTitle: 13, // M 販売Item title
  saleDate: 14, // N 販売日
  trackingInfo: 15, // O 追跡情報
  jpPrice: 16, // P 邦プラットフォーム販売価格(円)
  jpFee: 17, // Q 邦プラットフォーム手数料(円)
  jpShippingCollected: 18, // R 邦プラットフォーム送料徴収額(円)
  shippingCostPaid: 19, // S 送料支払額(円)
  ebayPriceUsd: 21, // U eBay販売価格(ドル)
  ebayShippingCollectedUsd: 22, // V eBay送料徴収額(ドル)
  ebayFeeUsd: 23, // W eBay手数料(ドル)
  exchangeRate: 29, // AC 月末レート(三菱UFJ TTM)
};

function cell(row: unknown[], colNumber1Indexed: number): unknown {
  const v = row[colNumber1Indexed - 1];
  return v === undefined ? null : v;
}

function toStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function toNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
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

/** 機種名・管理番号・仕入品名がすべて空欄の行は空行とみなして取込対象から除外する。 */
function isBlankRow(row: unknown[]): boolean {
  return (
    toStr(cell(row, COL.model)) == null &&
    toStr(cell(row, COL.managementNo)) == null &&
    toStr(cell(row, COL.itemName)) == null
  );
}

function buildRawRows(aoa: unknown[][], startRow: number, endRow: number): CameraStockRawRow[] {
  const result: CameraStockRawRow[] = [];
  for (let r = startRow; r <= endRow; r++) {
    const row = aoa[r - 1];
    if (!row) continue;
    if (isBlankRow(row)) continue;

    result.push({
      rowNumber: r,
      model: toStr(cell(row, COL.model)),
      purchaseDateRaw: cell(row, COL.purchaseDate),
      itemName: toStr(cell(row, COL.itemName)),
      sourceMain: toStr(cell(row, COL.sourceMain)),
      sourceSub: toStr(cell(row, COL.sourceSub)),
      usedGoodsLabel: toStr(cell(row, COL.usedGoodsLabel)),
      purchasePrice: toNum(cell(row, COL.purchasePrice)),
      statusCode: toStr(cell(row, COL.statusCode)),
      managementNoRaw: toStr(cell(row, COL.managementNo)),
      conditionNotes: toStr(cell(row, COL.conditionNotes)),
    });
  }
  return result;
}

/** 取込候補内(バッチ内)で管理番号が重複している行を検出し、2件目以降を重複扱いにする。 */
function markInBatchDuplicates(rows: MappedCameraStockRow[]): void {
  const seen = new Map<string, number>();
  for (const row of rows) {
    if (row.outcome !== "new" || !row.managementNo) continue;
    const count = seen.get(row.managementNo) ?? 0;
    seen.set(row.managementNo, count + 1);
    if (count > 0) {
      row.outcome = "duplicate";
      row.warnings.push("この取込データ内で管理番号が重複しています(先に出てきた行のみ取込対象とします)");
    }
  }
}

/** 「仕入・販売帳」シートから読み取る、突合候補1件分の売上関連データ。 */
interface LedgerSaleCandidate {
  serialRaw: string | null;
  saleDateRaw: unknown;
  saleItemTitle: string | null;
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

/**
 * 仕入先(D列)または仕入先2(E列)に「フォレスト」「Graphy」のいずれかが含まれる行は、取引先区分の
 * 既定値を「適格請求書発行事業者(インボイスあり)」にする(2026-09-03、ユーザー指示「仕入先に
 * 「フォレスト」「Graphy」が含まれるものは、取引先区分を適格請求書発行事業者(インボイスあり)で
 * とりこむように」に対応)。それ以外は従来通り既定値「消費者(個人)」とする。いずれの場合もドライラン
 * 結果の表で行ごとに個別に選択し直せる点は変わらない。
 *
 * 【2026-09-03、E列(仕入先2)も判定対象に追加(初版の不具合修正)】
 * 初版はD列(仕入先)のみを判定対象としていたが、実データ(仕入販売帳古物台帳_2026.xlsx Sheet1)を
 * 確認したところ、「フォレストカメラ」「フォレストカメラ ヤフオク!店」「MountGraphy」は全てE列
 * (仕入先2、メルカリ・ヤフオク等の出品者名)に入っており、D列(仕入先、プラットフォーム名)には
 * 一件も現れないことが判明した(D列の値はメルカリ/ヤフオク/ラクマ等のプラットフォーム名のみ)。
 * そのためD列だけの判定では一件も一致せず、ドライラン結果の初期選択が常に「消費者(個人)」のままに
 * なってしまう不具合があった。ユーザー指摘「ドライランの初期選択肢表示が意図通りになっていません」
 * を受けて、D列・E列のどちらかに該当文字列が含まれていれば対象とするよう修正した。
 */
function deriveDefaultCounterpartyType(sourceMain: string | null, sourceSub: string | null): CounterpartyType {
  const combined = `${(sourceMain ?? "").trim()} ${(sourceSub ?? "").trim()}`;
  if (combined.includes("フォレスト") || combined.includes("Graphy")) return "registered";
  return "consumer";
}

/** 「仕入先・仕入先2・新品古物判定・仕入高(円)」の4項目から突合キーを組み立てる。 */
function buildLedgerMatchKey(
  sourceMain: string,
  sourceSub: string,
  usedGoodsLabel: string,
  purchasePrice: number,
): string {
  return JSON.stringify([sourceMain.trim(), sourceSub.trim(), usedGoodsLabel.trim(), purchasePrice]);
}

/** 「仕入・販売帳」シートの全行(2行目〜末尾)を読み込み、突合キーごとの候補一覧を作る。 */
function buildLedgerMatchIndex(aoa: unknown[][]): Map<string, LedgerSaleCandidate[]> {
  const index = new Map<string, LedgerSaleCandidate[]>();
  for (let r = 2; r <= aoa.length; r++) {
    const row = aoa[r - 1];
    if (!row) continue;
    const purchasePrice = toNum(cell(row, LEDGER_COL.purchasePrice));
    if (purchasePrice == null) continue; // 仕入高が無い行は突合対象外
    const sourceMain = toStr(cell(row, LEDGER_COL.sourceMain)) ?? "";
    const sourceSub = toStr(cell(row, LEDGER_COL.sourceSub)) ?? "";
    const usedGoodsLabel = toStr(cell(row, LEDGER_COL.usedGoodsLabel)) ?? "";
    const key = buildLedgerMatchKey(sourceMain, sourceSub, usedGoodsLabel, purchasePrice);
    const list = index.get(key) ?? [];
    list.push({
      serialRaw: toStr(cell(row, LEDGER_COL.serial)),
      saleDateRaw: cell(row, LEDGER_COL.saleDate),
      saleItemTitle: toStr(cell(row, LEDGER_COL.saleItemTitle)),
      trackingInfo: toStr(cell(row, LEDGER_COL.trackingInfo)),
      jpPrice: toNum(cell(row, LEDGER_COL.jpPrice)),
      jpFee: toNum(cell(row, LEDGER_COL.jpFee)),
      jpShippingCollected: toNum(cell(row, LEDGER_COL.jpShippingCollected)),
      shippingCostPaid: toNum(cell(row, LEDGER_COL.shippingCostPaid)),
      ebayPriceUsd: toNum(cell(row, LEDGER_COL.ebayPriceUsd)),
      ebayShippingCollectedUsd: toNum(cell(row, LEDGER_COL.ebayShippingCollectedUsd)),
      ebayFeeUsd: toNum(cell(row, LEDGER_COL.ebayFeeUsd)),
      exchangeRate: toNum(cell(row, LEDGER_COL.exchangeRate)),
    });
    index.set(key, list);
  }
  return index;
}

type SaleMatchStatus = "matched" | "no_match" | "ambiguous";

/** MappedCameraStockRowに、仕入・販売帳との突合結果(saleInput・突合ステータス)を追加した型。 */
interface MappedSoldRow extends MappedCameraStockRow {
  saleInput: CameraStockSaleInsertInput | null;
  saleMatchStatus: SaleMatchStatus;
}

// 仕入・販売帳シートと一致しなかった(または一致したが販売日が空欄・不正だった)行に使う仮の販売日
// (2026-09-03、ユーザー指示「未一致になったものの販売日は2025-12-1をセットしてください」に対応。
// 「複数該当(エラー)」の行にはこの仮値は使わず、従来通り取込対象外のまま)。
const FALLBACK_SALE_DATE = "2025-12-01";
// 為替レートが取得できない場合の既定値(他の一括取込機能と同じ150円/ドル)。
const FALLBACK_EXCHANGE_RATE = 150;

const SALE_MATCH_LABELS: Record<SaleMatchStatus, string> = {
  matched: "一致",
  no_match: `未一致(仮日付${FALLBACK_SALE_DATE}で登録)`,
  ambiguous: "複数該当(エラー)",
};

const SALE_MATCH_COLORS: Record<SaleMatchStatus, string> = {
  matched: "var(--text-primary, inherit)",
  no_match: "var(--text-muted)",
  ambiguous: "var(--danger-text)",
};

/**
 * mapCameraStockRawRowでマッピング済みの各行に対し、「仕入・販売帳」シートとの突合結果を適用する。
 * 突合キーはSheet1側の「仕入先・仕入先2・新品古物判定・仕入高(円)」の4項目(2026-09-03、ユーザー指示
 * 「マッチング条件を仕入先 仕入先2 新品・古物判定 仕入高(円)に変更」により、仕入品名・仕入日は
 * キーから外れた)。
 */
function applyLedgerSaleMatch(
  mapped: MappedCameraStockRow[],
  ledgerIndex: Map<string, LedgerSaleCandidate[]>,
): MappedSoldRow[] {
  return mapped.map((row) => {
    if (!row.itemInput) {
      return { ...row, saleInput: null, saleMatchStatus: "no_match" };
    }

    const key = buildLedgerMatchKey(
      row.raw.sourceMain ?? "",
      row.raw.sourceSub ?? "",
      row.raw.usedGoodsLabel ?? "",
      row.raw.purchasePrice ?? 0,
    );
    const candidates = ledgerIndex.get(key) ?? [];

    if (candidates.length > 1) {
      return {
        ...row,
        outcome: "error",
        errors: [
          ...row.errors,
          "「仕入先・仕入先2・新品古物判定・仕入高」が一致する仕入・販売帳シートの行が複数見つかったため、売上データを一意に特定できませんでした(誤った売上データを紐付けないため、この行はエラーとして取込対象外にします)",
        ],
        saleInput: null,
        saleMatchStatus: "ambiguous",
      };
    }

    if (candidates.length === 1) {
      const c = candidates[0];
      if (!isValidDate(c.saleDateRaw)) {
        const fallbackSaleInput: CameraStockSaleInsertInput = {
          sale_date: FALLBACK_SALE_DATE,
          sale_item_title: c.saleItemTitle ?? row.raw.itemName,
          tracking_info: c.trackingInfo,
          sales_record_reference: c.serialRaw,
          jp_platform_price: c.jpPrice ?? 0,
          jp_platform_fee: c.jpFee ?? 0,
          jp_platform_shipping_collected: c.jpShippingCollected ?? 0,
          shipping_cost_paid: c.shippingCostPaid ?? 0,
          ebay_price_usd: c.ebayPriceUsd ?? 0,
          ebay_shipping_collected_usd: c.ebayShippingCollectedUsd ?? 0,
          ebay_handling_fee_usd: c.ebayFeeUsd ?? 0,
          ebay_ad_fee_usd: 0,
          exchange_rate: c.exchangeRate ?? FALLBACK_EXCHANGE_RATE,
        };
        return {
          ...row,
          warnings: [
            ...row.warnings,
            `仕入・販売帳シートに一致する行が見つかりましたが、販売日が空欄・不正なため、販売日は仮の「${FALLBACK_SALE_DATE}」として売上データを登録します(その他の金額は一致した行の値を使用。正確な販売日が分かり次第、売上・粗利タブで修正してください)`,
          ],
          saleInput: fallbackSaleInput,
          saleMatchStatus: "no_match",
        };
      }
      const saleInput: CameraStockSaleInsertInput = {
        sale_date: formatDate(c.saleDateRaw),
        sale_item_title: c.saleItemTitle ?? row.raw.itemName,
        tracking_info: c.trackingInfo,
        sales_record_reference: c.serialRaw,
        jp_platform_price: c.jpPrice ?? 0,
        jp_platform_fee: c.jpFee ?? 0,
        jp_platform_shipping_collected: c.jpShippingCollected ?? 0,
        shipping_cost_paid: c.shippingCostPaid ?? 0,
        ebay_price_usd: c.ebayPriceUsd ?? 0,
        ebay_shipping_collected_usd: c.ebayShippingCollectedUsd ?? 0,
        ebay_handling_fee_usd: c.ebayFeeUsd ?? 0,
        ebay_ad_fee_usd: 0,
        exchange_rate: c.exchangeRate ?? 150,
      };
      return {
        ...row,
        warnings: [
          ...row.warnings,
          `仕入・販売帳シートの該当行と一致したため、実際の売上データ(販売日: ${saleInput.sale_date})を登録します`,
        ],
        saleInput,
        saleMatchStatus: "matched",
      };
    }

    const fallbackSaleInput: CameraStockSaleInsertInput = {
      sale_date: FALLBACK_SALE_DATE,
      sale_item_title: row.raw.itemName,
      tracking_info: null,
      sales_record_reference: null,
      jp_platform_price: 0,
      jp_platform_fee: 0,
      jp_platform_shipping_collected: 0,
      shipping_cost_paid: 0,
      ebay_price_usd: 0,
      ebay_shipping_collected_usd: 0,
      ebay_handling_fee_usd: 0,
      ebay_ad_fee_usd: 0,
      exchange_rate: FALLBACK_EXCHANGE_RATE,
    };
    return {
      ...row,
      warnings: [
        ...row.warnings,
        `仕入・販売帳シートに「仕入先・仕入先2・新品古物判定・仕入高」が一致する行が見つからなかったため、販売日は仮の「${FALLBACK_SALE_DATE}」・金額は全て0円で売上データを登録します(正確な販売日・売上額が分かり次第、売上・粗利タブで修正してください)`,
      ],
      saleInput: fallbackSaleInput,
      saleMatchStatus: "no_match",
    };
  });
}

const OUTCOME_LABELS: Record<MappedCameraStockRow["outcome"], string> = {
  new: "新規",
  duplicate: "重複(スキップ)",
  error: "エラー",
};

const OUTCOME_COLORS: Record<MappedCameraStockRow["outcome"], string> = {
  new: "var(--text-primary, inherit)",
  duplicate: "var(--text-muted)",
  error: "var(--danger-text)",
};

export default function SoldCameraStockImportPanel() {
  const [file, setFile] = useState<File | null>(null);
  const [startRow, setStartRow] = useState(DEFAULT_START_ROW);
  const [endRow, setEndRow] = useState(DEFAULT_END_ROW);
  const [defaultStatus, setDefaultStatus] = useState<ItemStatus>("sold");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mappedRows, setMappedRows] = useState<MappedSoldRow[] | null>(null);
  const [filter, setFilter] = useState<"all" | MappedSoldRow["outcome"]>("all");

  const [executing, setExecuting] = useState(false);
  const [executeResults, setExecuteResults] = useState<Map<number, ExecuteResult>>(new Map());
  const [executeProgress, setExecuteProgress] = useState<{ done: number; total: number } | null>(null);

  async function handleDryRun() {
    if (!file) {
      setError("エクセルファイルを選択してください");
      return;
    }
    setBusy(true);
    setError(null);
    setMappedRows(null);
    setFilter("all");
    setExecuteResults(new Map());
    setExecuteProgress(null);
    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: "array", cellDates: true });
      const sheet = wb.Sheets[SHEET_NAME];
      if (!sheet) {
        throw new Error(
          `シート「${SHEET_NAME}」が見つかりません(このファイルのシート一覧: ${wb.SheetNames.join(", ")})`,
        );
      }
      const ledgerSheet = wb.Sheets[LEDGER_SHEET_NAME];
      if (!ledgerSheet) {
        throw new Error(
          `シート「${LEDGER_SHEET_NAME}」が見つかりません(このファイルのシート一覧: ${wb.SheetNames.join(", ")})。売上データの突合に必要です`,
        );
      }

      const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null });
      const rawRows = buildRawRows(aoa, startRow, endRow);

      const ledgerAoa = XLSX.utils.sheet_to_json<unknown[]>(ledgerSheet, { header: 1, raw: true, defval: null });
      const ledgerIndex = buildLedgerMatchIndex(ledgerAoa);

      // 取引先区分は行ごとに異なりうるため、既定値「消費者(個人)」で一律マッピングするが、
      // 仕入先(D列)または仕入先2(E列)に「フォレスト」「Graphy」が含まれる行だけは既定値を
      // 「適格請求書発行事業者(インボイスあり)」にする(deriveDefaultCounterpartyType、2026-09-03
      // ユーザー指示対応。実データではE列に入っているため、E列も判定対象に含める必要があった)。
      // いずれの場合もドライラン結果の表で行ごとに個別選択できる(「カメラ」シート取込と同じ方式)。
      const mapped = rawRows.map((raw) =>
        mapCameraStockRawRow(raw, defaultStatus, deriveDefaultCounterpartyType(raw.sourceMain, raw.sourceSub)),
      );

      // 「仕入先・仕入先2・新品古物判定・仕入高」で仕入・販売帳シートと突合し、実際の売上データ
      // (販売日・売上額等)をセットする(一致0件/販売日空欄は売上データ無しの警告、複数一致はエラー)。
      const mappedWithSales = applyLedgerSaleMatch(mapped, ledgerIndex);

      const candidateNos = mappedWithSales
        .filter((m) => m.outcome === "new" && m.managementNo)
        .map((m) => m.managementNo as string);
      const existing = await findExistingManagementNos(candidateNos);
      for (const m of mappedWithSales) {
        if (m.outcome === "new" && m.managementNo && existing.has(m.managementNo)) {
          m.outcome = "duplicate";
          m.warnings.push("既にシステムに取込済みの管理番号です");
        }
      }
      markInBatchDuplicates(mappedWithSales);

      setMappedRows(mappedWithSales);
    } catch (err) {
      setError(err instanceof Error ? err.message : "ドライランに失敗しました");
    } finally {
      setBusy(false);
    }
  }

  async function handleExecute() {
    if (!mappedRows) return;
    const targets = mappedRows.filter((m) => m.outcome === "new" && m.itemInput);
    if (targets.length === 0) return;
    if (
      !window.confirm(
        `${targets.length}件のデータを実際に取り込みます。この操作は取り消せません。よろしいですか?`,
      )
    ) {
      return;
    }
    setExecuting(true);
    setExecuteProgress({ done: 0, total: targets.length });

    // 重複としてスキップする行(既存の登録済み商品と管理番号が一致した行)も、実行結果欄に
    // スキップした旨をログとして明示する。既存商品の更新は行わない。
    const results = new Map<number, ExecuteResult>();
    for (const row of mappedRows) {
      if (row.outcome === "duplicate") {
        results.set(row.rowNumber, {
          rowNumber: row.rowNumber,
          managementNo: row.managementNo,
          success: true,
          skipped: true,
          message: "スキップしました(管理番号が既存の登録済み商品と一致するため、新規登録は行っていません)",
        });
      }
    }
    setExecuteResults(new Map(results));

    let doneCount = 0;
    for (const row of targets) {
      const result = await executeCameraStockImportRow(row, row.saleInput);
      results.set(row.rowNumber, result);
      doneCount += 1;
      setExecuteResults(new Map(results));
      setExecuteProgress({ done: doneCount, total: targets.length });
    }
    setExecuting(false);
  }

  function handleRowStatusChange(rowNumber: number, value: ItemStatus) {
    setMappedRows((prev) =>
      prev ? prev.map((r) => (r.rowNumber === rowNumber ? { ...r, finalStatus: value } : r)) : prev,
    );
  }

  function handleRowCounterpartyChange(rowNumber: number, value: CounterpartyType) {
    setMappedRows((prev) =>
      prev
        ? prev.map((r) =>
            r.rowNumber === rowNumber && r.itemInput
              ? { ...r, itemInput: { ...r.itemInput, counterparty_type: value } }
              : r,
          )
        : prev,
    );
  }

  const summary = mappedRows
    ? {
        new: mappedRows.filter((m) => m.outcome === "new").length,
        duplicate: mappedRows.filter((m) => m.outcome === "duplicate").length,
        error: mappedRows.filter((m) => m.outcome === "error").length,
      }
    : null;

  const executeSuccessCount = Array.from(executeResults.values()).filter((r) => r.success && !r.skipped).length;
  const executeFailCount = Array.from(executeResults.values()).filter((r) => !r.success).length;
  const executeSkippedCount = Array.from(executeResults.values()).filter((r) => r.skipped).length;

  const filteredRows = mappedRows
    ? filter === "all"
      ? mappedRows
      : mappedRows.filter((m) => m.outcome === filter)
    : null;

  const FILTER_OPTIONS: { key: "all" | MappedSoldRow["outcome"]; label: string; count: number | null }[] = [
    { key: "all", label: "すべて", count: mappedRows ? mappedRows.length : null },
    { key: "new", label: "新規", count: summary ? summary.new : null },
    { key: "duplicate", label: "重複(スキップ)", count: summary ? summary.duplicate : null },
    { key: "error", label: "エラー", count: summary ? summary.error : null },
  ];

  return (
    <div>
      <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 0, marginBottom: 16 }}>
        「Sheet1」エクセルシートの指定行範囲(既定は販売済み商品が並ぶ2〜181行)を読み込み、商品・仕入・売上データとして
        一括登録します(「カメラ在庫(未出品・出品中商品)の一括取込」と同じ列構成・同じロジックを使用。こちらは
        販売済み一覧のため、items・purchasesに加えてsales(売上)データも作成します)。既定ステータスの初期値は
        「販売済み」ですが、必要に応じてドライラン結果の表で行ごとに変更できます。
      </p>
      <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 0, marginBottom: 16 }}>
        売上データ(販売日・売上額等)は、同じアップロードファイル内の「仕入・販売帳」シートと
        「仕入先・仕入先2・新品古物判定・仕入高(円)」の4項目が完全一致する行を突合して取得します。
        一致する行が無い場合、または一致した行の販売日が空欄・不正な場合は、金額等は分かる範囲の値
        (一致した行が無い場合は全て0円)を使い、販売日だけ仮の「2025-12-01」として売上データを登録します
        (正確な販売日・売上額が分かり次第、売上・粗利タブで修正してください。ドライラン結果の警告欄・
        「売上マッチ」列に表示されます)。一致する行が複数見つかった場合は、誤った売上データを紐付けない
        ためエラーとして取込対象外にします(この場合は仮日付も使いません)。
      </p>
      <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 0, marginBottom: 16 }}>
        まず「ドライラン実行」で内容(特に「売上マッチ」列・警告欄)を確認してから、「取込実行」で
        実際にデータベースへ登録してください。取込実行は取り消せないため、必ずドライラン結果を
        確認してからにしてください。
      </p>

      <div
        style={{
          display: "flex",
          gap: 16,
          alignItems: "center",
          flexWrap: "wrap",
          marginBottom: 12,
          padding: "12px 14px",
          border: "0.5px solid var(--border)",
          borderRadius: 12,
          background: "var(--surface-2)",
        }}
      >
        <input
          type="file"
          accept=".xlsx"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setMappedRows(null);
            setFilter("all");
            setExecuteResults(new Map());
            setError(null);
          }}
        />
        <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          開始行:
          <input
            type="number"
            value={startRow}
            onChange={(e) => setStartRow(Number(e.target.value) || DEFAULT_START_ROW)}
            style={{ width: 70, marginLeft: 4 }}
          />
        </label>
        <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          終了行:
          <input
            type="number"
            value={endRow}
            onChange={(e) => setEndRow(Number(e.target.value) || DEFAULT_END_ROW)}
            style={{ width: 70, marginLeft: 4 }}
          />
        </label>
        <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          既定ステータス:
          <select
            value={defaultStatus}
            onChange={(e) => setDefaultStatus(e.target.value as ItemStatus)}
            style={{ marginLeft: 4 }}
          >
            {(Object.keys(ITEM_STATUS_LABELS) as ItemStatus[]).map((s) => (
              <option key={s} value={s}>
                {ITEM_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <button onClick={handleDryRun} disabled={busy || !file}>
          {busy ? "ドライラン実行中..." : "ドライラン実行"}
        </button>
      </div>

      <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 0, marginBottom: 12 }}>
        既定ステータス・取引先区分は、下記のドライラン結果の表で商品ごとに個別選択できます。M列(ステータス)の
        生の値は、商品の「在庫シートステータスコード」として別途そのまま保存され、既定ステータスの
        自動判定には使用していません(取込前にご自身で行ごとに選択してください)。取引先区分は、仕入先または
        仕入先2に「フォレスト」「Graphy」が含まれる行のみ既定値が「適格請求書発行事業者(インボイスあり)」に、
        それ以外は「消費者(個人)」になります(いずれも変更可能です)。
      </p>

      {error && <p style={{ fontSize: 13, color: "var(--danger-text)", marginBottom: 12 }}>{error}</p>}

      {summary && (
        <div
          style={{
            display: "flex",
            gap: 16,
            alignItems: "center",
            flexWrap: "wrap",
            marginBottom: 12,
            padding: "12px 14px",
            border: "0.5px solid var(--border)",
            borderRadius: 12,
          }}
        >
          <span style={{ fontSize: 13 }}>
            新規: <strong>{summary.new}</strong>件 / 重複(スキップ): {summary.duplicate}件 / エラー: {summary.error}件
          </span>
          <button onClick={handleExecute} disabled={executing || summary.new === 0}>
            {executing
              ? `取込実行中... (${executeProgress?.done ?? 0}/${executeProgress?.total ?? 0})`
              : `取込実行(新規${summary.new}件)`}
          </button>
          {executeResults.size > 0 && !executing && (
            <span style={{ fontSize: 13 }}>
              → 完了: 成功{executeSuccessCount}件
              {executeSkippedCount > 0 && (
                <span style={{ color: "var(--text-muted)" }}> / スキップ{executeSkippedCount}件</span>
              )}
              {executeFailCount > 0 && (
                <span style={{ color: "var(--danger-text)" }}> / 失敗{executeFailCount}件</span>
              )}
            </span>
          )}
        </div>
      )}

      {mappedRows && (
        <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
          {FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              onClick={() => setFilter(opt.key)}
              style={{
                fontSize: 12,
                padding: "3px 10px",
                fontWeight: filter === opt.key ? 700 : 400,
                background: filter === opt.key ? "var(--accent)" : undefined,
                color: filter === opt.key ? "var(--surface, #fff)" : undefined,
              }}
            >
              {opt.label}
              {opt.count != null ? `(${opt.count})` : ""}
            </button>
          ))}
        </div>
      )}

      {filteredRows && filteredRows.length === 0 && (
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>該当する行はありません</p>
      )}

      {filteredRows && filteredRows.length > 0 && (
        <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-secondary)" }}>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>行</th>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>管理番号</th>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>判定</th>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>機種名</th>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>品名</th>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>仕入先</th>
              <th style={{ padding: "6px 4px", fontWeight: 500, textAlign: "right" }}>仕入高</th>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>シートステータス</th>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>売上マッチ</th>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>登録ステータス</th>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>取引先区分</th>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>エラー・警告</th>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>実行結果</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row) => {
              const execResult = executeResults.get(row.rowNumber);
              return (
                <tr key={row.rowNumber} style={{ borderTop: "0.5px solid var(--border)" }}>
                  <td style={{ padding: "6px 4px" }}>{row.rowNumber}</td>
                  <td style={{ padding: "6px 4px" }}>{row.managementNo ?? "-"}</td>
                  <td style={{ padding: "6px 4px", color: OUTCOME_COLORS[row.outcome] }}>
                    {OUTCOME_LABELS[row.outcome]}
                  </td>
                  <td style={{ padding: "6px 4px" }}>{row.raw.model ?? "-"}</td>
                  <td style={{ padding: "6px 4px" }}>{row.raw.itemName ?? "-"}</td>
                  <td style={{ padding: "6px 4px" }}>
                    {[row.raw.sourceMain, row.raw.sourceSub].filter(Boolean).join(" / ") || "-"}
                  </td>
                  <td style={{ padding: "6px 4px", textAlign: "right" }}>
                    {row.raw.purchasePrice != null ? row.raw.purchasePrice.toLocaleString() : "-"}
                  </td>
                  <td style={{ padding: "6px 4px" }}>{row.listingStatusCode ?? "-"}</td>
                  <td style={{ padding: "6px 4px" }}>
                    <div style={{ color: SALE_MATCH_COLORS[row.saleMatchStatus] }}>
                      {SALE_MATCH_LABELS[row.saleMatchStatus]}
                    </div>
                    {row.saleInput && (
                      <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.6, marginTop: 2 }}>
                        <div>販売日: {row.saleInput.sale_date}</div>
                        <div>販売Item title: {row.saleInput.sale_item_title ?? "-"}</div>
                        <div>Sales #: {row.saleInput.sales_record_reference ?? "-"}</div>
                        <div>追跡情報: {row.saleInput.tracking_info ?? "-"}</div>
                        <div>邦¥価格: {row.saleInput.jp_platform_price.toLocaleString()}</div>
                        <div>邦¥手数料: {row.saleInput.jp_platform_fee.toLocaleString()}</div>
                        <div>邦¥送料回収: {row.saleInput.jp_platform_shipping_collected.toLocaleString()}</div>
                        <div>送料負担: {row.saleInput.shipping_cost_paid.toLocaleString()}</div>
                        <div>eBay価格($): {row.saleInput.ebay_price_usd.toLocaleString()}</div>
                        <div>eBay送料回収($): {row.saleInput.ebay_shipping_collected_usd.toLocaleString()}</div>
                        <div>eBay手数料($): {row.saleInput.ebay_handling_fee_usd.toLocaleString()}</div>
                        <div>為替レート: {row.saleInput.exchange_rate.toLocaleString()}</div>
                      </div>
                    )}
                  </td>
                  <td style={{ padding: "6px 4px" }}>
                    {row.itemInput ? (
                      <select
                        value={row.finalStatus}
                        onChange={(e) => handleRowStatusChange(row.rowNumber, e.target.value as ItemStatus)}
                        style={{ fontSize: 12 }}
                      >
                        {(Object.keys(ITEM_STATUS_LABELS) as ItemStatus[]).map((s) => (
                          <option key={s} value={s}>
                            {ITEM_STATUS_LABELS[s]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td style={{ padding: "6px 4px" }}>
                    {row.itemInput ? (
                      (() => {
                        const info = getDeductionInfo(row.itemInput.counterparty_type);
                        return (
                          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                            <select
                              value={row.itemInput.counterparty_type}
                              onChange={(e) =>
                                handleRowCounterpartyChange(row.rowNumber, e.target.value as CounterpartyType)
                              }
                              style={{ fontSize: 12 }}
                            >
                              {COUNTERPARTY_TYPE_OPTIONS.map((o) => (
                                <option key={o.value} value={o.value}>
                                  {o.label}
                                </option>
                              ))}
                            </select>
                            <span
                              style={{
                                fontSize: 11,
                                color: info.rate === 0 ? "var(--danger-text)" : "var(--text-muted)",
                              }}
                            >
                              控除率 {info.rate}%
                            </span>
                          </div>
                        );
                      })()
                    ) : (
                      "-"
                    )}
                  </td>
                  <td style={{ padding: "6px 4px" }}>
                    {row.errors.map((e, i) => (
                      <div key={`e${i}`} style={{ color: "var(--danger-text)" }}>
                        {e}
                      </div>
                    ))}
                    {row.warnings.map((w, i) => (
                      <div key={`w${i}`} style={{ color: "var(--text-muted)" }}>
                        {w}
                      </div>
                    ))}
                  </td>
                  <td
                    style={{
                      padding: "6px 4px",
                      color: execResult && !execResult.success
                        ? "var(--danger-text)"
                        : execResult?.skipped
                          ? "var(--text-muted)"
                          : undefined,
                    }}
                  >
                    {execResult ? execResult.message : ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
