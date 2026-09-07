import { supabase } from "../supabaseClient";
import { COUNTERPARTY_TYPE_OPTIONS, getDeductionInfo, type CounterpartyType } from "../taxDeduction";

/**
 * freee会計の「取引の一括登録」インポートCSV形式(21列)に対応する1行分のデータ。
 * 列の並び順はfreeeの仕様に厳密に従う必要があるため、キー名がそのまま出力列名になる。
 *
 * 税区分の表記(「課税売上10%」「輸出売上」「課対仕入（控80）10%」等)はfreeeのヘルプセンター・
 * 開発者向け資料をもとにしたものだが、freee側の実際のマスタ表記と完全一致するかは初回インポート時に
 * 必ず確認すること(一致しない場合は取込エラーになるか、意図しない税区分として扱われる可能性がある)。
 */
export interface FreeeCsvRow {
  収支区分: "収入" | "支出";
  管理番号: string;
  発生日: string;
  決済期日: string;
  取引先コード: string;
  取引先: string;
  勘定科目: string;
  税区分: string;
  金額: string;
  税計算区分: string;
  税額: string;
  備考: string;
  品目: string;
  部門: string;
  メモタグ: string;
  セグメント1: string;
  セグメント2: string;
  セグメント3: string;
  決済日: string;
  決済口座: string;
  決済金額: string;
}

/** 決済情報(決済日・決済口座)。指定した場合、対象行の決済日・決済口座・決済金額(=金額と同額)を埋める。 */
export interface SettlementInfo {
  date: string; // "YYYY-MM-DD"
  account: string;
}

const FREEE_CSV_HEADERS: (keyof FreeeCsvRow)[] = [
  "収支区分",
  "管理番号",
  "発生日",
  "決済期日",
  "取引先コード",
  "取引先",
  "勘定科目",
  "税区分",
  "金額",
  "税計算区分",
  "税額",
  "備考",
  "品目",
  "部門",
  "メモタグ",
  "セグメント1",
  "セグメント2",
  "セグメント3",
  "決済日",
  "決済口座",
  "決済金額",
];

/** 経費のcategory(このシステム独自の分類名)から、freeeの一般的な勘定科目名への変換テーブル。 */
const EXPENSE_CATEGORY_TO_ACCOUNT_ITEM: Record<string, string> = {
  消耗品: "消耗品費",
  送料: "荷造運賃",
  通信費: "通信費",
  支払報酬: "支払手数料",
  支払手数料: "支払手数料",
  交際費: "接待交際費",
  広告宣伝費: "広告宣伝費",
  販売手数料: "支払手数料",
  その他: "雑費",
};

function toFreeeDate(isoDate: string): string {
  return isoDate.split("-").join("/");
}

function monthRange(yearMonth: string): { monthStart: string; monthEnd: string } {
  const monthStart = `${yearMonth}-01`;
  const monthStartDate = new Date(monthStart);
  const monthEndDate = new Date(monthStartDate.getFullYear(), monthStartDate.getMonth() + 1, 0);
  const monthEnd = monthEndDate.toISOString().slice(0, 10);
  return { monthStart, monthEnd };
}

function csvEscape(value: string): string {
  if (/["\n\r,]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** FreeeCsvRowの配列から、ヘッダー行付きのCSV文字列(改行はCRLF)を組み立てる。 */
export function buildFreeeCsv(rows: FreeeCsvRow[]): string {
  const headerLine = FREEE_CSV_HEADERS.join(",");
  const lines = rows.map((row) => FREEE_CSV_HEADERS.map((h) => csvEscape(row[h])).join(","));
  return [headerLine, ...lines].join("\r\n");
}

type RowBase = Omit<
  FreeeCsvRow,
  "取引先" | "勘定科目" | "税区分" | "金額" | "税計算区分" | "税額" | "決済日" | "決済口座" | "決済金額"
>;
type RowSpecific = Pick<FreeeCsvRow, "取引先" | "勘定科目" | "税区分" | "金額" | "税計算区分" | "税額">;

/** 共通項目(base)とドメイン固有項目(specific)を合成し、決済情報が指定されていれば決済日・決済口座・決済金額(=金額と同額)を埋める。 */
function buildRow(base: RowBase, specific: RowSpecific, settlement: SettlementInfo | undefined): FreeeCsvRow {
  const settled = !!(settlement && settlement.date && settlement.account);
  return {
    ...base,
    ...specific,
    決済日: settled ? toFreeeDate(settlement!.date) : "",
    決済口座: settled ? settlement!.account : "",
    決済金額: settled ? specific.金額 : "",
  };
}

/**
 * 仕入税額控除の経過措置を踏まえた、購入1件分の税区分文字列を返す。
 * - consumer(消費者/古物商特例) / registered(インボイス登録事業者): 常に全額控除 → 「課税仕入10%」
 * - unregistered(インボイス未登録事業者): 仕入日時点の経過措置に応じて
 *   「課対仕入（控80）10%」(2023/10〜2026/9) → 「課対仕入（控50）10%」(2026/10〜2029/9) → 「対象外」(2029/10以降、控除不可)
 * 経過措置の判定は`taxDeduction.ts`の`getDeductionInfo`をそのまま利用し、判定基準日は「仕入日」とする
 * (レポート閲覧時点ではなく取引発生時点の制度を反映するため)。
 */
function purchaseTaxCategory(counterpartyType: CounterpartyType, purchaseDateIso: string): string {
  const info = getDeductionInfo(counterpartyType, new Date(purchaseDateIso));
  if (info.rate === 100) return "課税仕入10%";
  if (info.rate === 80) return "課対仕入（控80）10%";
  if (info.rate === 50) return "課対仕入（控50）10%";
  return "対象外";
}

/**
 * 売上データ(sales)を対象月分取得し、freee形式の行に変換する。
 * - 1件の売上に国内プラットフォーム分・eBay分の両方の金額があり得るため、それぞれ別行として出力する
 *   (税区分が異なるため。片方が0円の場合はその行を出力しない)。
 * - 金額は生成列(`jp_platform_subtotal`・`usd_subtotal_jpy`。前者はDB側で税・送料込みで計算済み、
 *   後者はさらにその売上時点の`exchange_rate`で円換算済み)をそのまま使用する。ExportPage上部のTTMレートは
 *   ここでは使用しない(二重換算を避けるため)。
 * - 税区分は、国内プラットフォーム分は「課税売上10%」、eBay分(海外発送)は輸出免税として「輸出売上」を設定する。
 * - `settlement`(任意)を指定すると、国内(jp)・eBay(ebay)それぞれの行に決済日・決済口座・決済金額を反映する
 *   (チャネルによって決済口座が異なることが多いため、jp/ebayを別々に指定できるようにしている)。
 */
export async function fetchSalesFreeeRows(
  yearMonth: string,
  settlement?: { jp?: SettlementInfo; ebay?: SettlementInfo },
): Promise<FreeeCsvRow[]> {
  const { monthStart, monthEnd } = monthRange(yearMonth);
  const { data, error } = await supabase
    .from("sales")
    .select(
      "sale_date, sale_item_title, tracking_info, jp_platform_subtotal, usd_subtotal_jpy, items(management_no)",
    )
    .gte("sale_date", monthStart)
    .lte("sale_date", monthEnd)
    .order("sale_date", { ascending: true });
  if (error) throw error;

  type Row = {
    sale_date: string;
    sale_item_title: string | null;
    tracking_info: string | null;
    jp_platform_subtotal: number;
    usd_subtotal_jpy: number;
    items: { management_no: string } | { management_no: string }[] | null;
  };

  const rows: FreeeCsvRow[] = [];
  for (const row of data as unknown as Row[]) {
    const managementNo = Array.isArray(row.items) ? row.items[0]?.management_no : row.items?.management_no;
    const memoParts = [row.sale_item_title, row.tracking_info].filter((v): v is string => !!v);
    const base: RowBase = {
      収支区分: "収入",
      管理番号: "",
      発生日: toFreeeDate(row.sale_date),
      決済期日: "",
      取引先コード: "",
      備考: memoParts.join(" / "),
      品目: managementNo ?? "",
      部門: "",
      メモタグ: "",
      セグメント1: "",
      セグメント2: "",
      セグメント3: "",
    };

    const hasJp = row.jp_platform_subtotal !== 0;
    const hasEbay = row.usd_subtotal_jpy !== 0;

    if (hasJp) {
      rows.push(
        buildRow(
          base,
          {
            取引先: "国内プラットフォーム",
            勘定科目: "売上高",
            税区分: "課税売上10%",
            金額: String(Math.round(row.jp_platform_subtotal)),
            税計算区分: "内税",
            税額: "",
          },
          settlement?.jp,
        ),
      );
    }
    if (hasEbay) {
      rows.push(
        buildRow(
          base,
          {
            取引先: "eBay",
            勘定科目: "売上高",
            税区分: "輸出売上",
            金額: String(Math.round(row.usd_subtotal_jpy)),
            税計算区分: "内税",
            税額: "",
          },
          settlement?.ebay,
        ),
      );
    }
    if (!hasJp && !hasEbay) {
      // 国内・eBayどちらの金額も0円の売上行(取りこぼし防止のため1行だけ出力する)
      rows.push(
        buildRow(
          base,
          {
            取引先: "",
            勘定科目: "売上高",
            税区分: "課税売上10%",
            金額: "0",
            税計算区分: "内税",
            税額: "",
          },
          undefined,
        ),
      );
    }
  }

  return rows;
}

/**
 * 仕入データ(purchases)を対象月分取得し、freee形式の行に変換する。
 * - 金額はpurchase_price(円建て)をそのまま使用する。
 * - 税区分は`counterparty_type`(消費者/インボイス登録/未登録)と仕入日をもとに、
 *   仕入税額控除の経過措置を反映した区分(`purchaseTaxCategory`)を設定する。
 * - `settlement`(任意)を指定すると、全行に決済日・決済口座・決済金額を反映する。
 */
export async function fetchPurchasesFreeeRows(
  yearMonth: string,
  settlement?: SettlementInfo,
): Promise<FreeeCsvRow[]> {
  const { monthStart, monthEnd } = monthRange(yearMonth);
  const { data, error } = await supabase
    .from("purchases")
    .select("purchase_date, source_name, purchase_price, notes, counterparty_type, items(management_no)")
    .gte("purchase_date", monthStart)
    .lte("purchase_date", monthEnd)
    .order("purchase_date", { ascending: true });
  if (error) throw error;

  type Row = {
    purchase_date: string;
    source_name: string | null;
    purchase_price: number;
    notes: string | null;
    counterparty_type: CounterpartyType;
    items: { management_no: string } | { management_no: string }[] | null;
  };

  return (data as unknown as Row[]).map((row) => {
    const managementNo = Array.isArray(row.items) ? row.items[0]?.management_no : row.items?.management_no;
    const counterpartyLabel =
      COUNTERPARTY_TYPE_OPTIONS.find((o) => o.value === row.counterparty_type)?.label ?? row.counterparty_type;
    const memoParts = [row.notes, `[取引先区分: ${counterpartyLabel}]`].filter((v): v is string => !!v);

    const base: RowBase = {
      収支区分: "支出",
      管理番号: "",
      発生日: toFreeeDate(row.purchase_date),
      決済期日: "",
      取引先コード: "",
      備考: memoParts.join(" / "),
      品目: managementNo ?? "",
      部門: "",
      メモタグ: "",
      セグメント1: "",
      セグメント2: "",
      セグメント3: "",
    };

    return buildRow(
      base,
      {
        取引先: row.source_name ?? "",
        勘定科目: "仕入高",
        税区分: purchaseTaxCategory(row.counterparty_type, row.purchase_date),
        金額: String(Math.round(row.purchase_price)),
        税計算区分: "内税",
        税額: "",
      },
      settlement,
    );
  });
}

/**
 * 経費データ(expenses)を対象月分取得し、freee形式の行に変換する。
 * - 勘定科目はこのシステムのcategory(消耗品・送料 等)をfreeeの一般的な勘定科目名にマッピングして設定する。
 * - 税区分は既存のtax_category(課税/不課税)をそのまま反映する(経費のみ、追加コストなしで正確な区分が既に取得できているため)。
 * - `settlement`(任意)を指定すると、全行に決済日・決済口座・決済金額を反映する。
 */
export async function fetchExpensesFreeeRows(
  yearMonth: string,
  settlement?: SettlementInfo,
): Promise<FreeeCsvRow[]> {
  const { monthStart, monthEnd } = monthRange(yearMonth);
  const { data, error } = await supabase
    .from("expenses")
    .select("expense_date, category, vendor, description, amount, tax_category, invoice_registration_no, related_item_id")
    .gte("expense_date", monthStart)
    .lte("expense_date", monthEnd)
    .order("expense_date", { ascending: true });
  if (error) throw error;

  type Row = {
    expense_date: string;
    category: string;
    vendor: string | null;
    description: string | null;
    amount: number;
    tax_category: "課税" | "不課税";
    invoice_registration_no: string | null;
    related_item_id: string | null;
  };
  const rows = data as unknown as Row[];

  const itemIds = Array.from(new Set(rows.map((r) => r.related_item_id).filter((v): v is string => !!v)));
  const managementNoMap = new Map<string, string>();
  if (itemIds.length > 0) {
    const { data: items, error: itemsError } = await supabase.from("items").select("id, management_no").in("id", itemIds);
    if (itemsError) throw itemsError;
    for (const item of items as { id: string; management_no: string }[]) {
      managementNoMap.set(item.id, item.management_no);
    }
  }

  return rows.map((row) => {
    const isTaxable = row.tax_category === "課税";
    const memoParts = [row.description, row.invoice_registration_no ? `登録番号: ${row.invoice_registration_no}` : null].filter(
      (v): v is string => !!v,
    );

    const base: RowBase = {
      収支区分: "支出",
      管理番号: "",
      発生日: toFreeeDate(row.expense_date),
      決済期日: "",
      取引先コード: "",
      備考: memoParts.join(" / "),
      品目: row.related_item_id ? managementNoMap.get(row.related_item_id) ?? "" : "",
      部門: "",
      メモタグ: "",
      セグメント1: "",
      セグメント2: "",
      セグメント3: "",
    };

    return buildRow(
      base,
      {
        取引先: row.vendor ?? "",
        勘定科目: EXPENSE_CATEGORY_TO_ACCOUNT_ITEM[row.category] ?? row.category,
        税区分: isTaxable ? "課税仕入10%" : "対象外",
        金額: String(Math.round(row.amount)),
        税計算区分: isTaxable ? "内税" : "",
        税額: "",
      },
      settlement,
    );
  });
}
