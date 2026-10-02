import ExcelJS from "exceljs";
import Papa from "papaparse";

/**
 * 2026-10-03新規(ユーザー指示): 送料支払額(sales.shipping_cost_paid)と、運送会社の請求明細との照合。
 * CPaSSの請求明細(InvoiceDetails.xlsx/.csv)・eLogiの発送済一覧CSVを取り込んだ時点で、
 * 請求額と登録額を突合し、相違の一覧を作る。このファイルは画面・DBに依存しない純粋な処理のみ
 * (テストしやすくするため、supabaseを使う取得・更新は api/shippingReconcile.ts に分離)。
 */

export type ReconcileSource = "cpass" | "elogi";

/** 請求側の1件(CPaSSは荷物=追跡番号、eLogiはeBayオーダー番号が単位) */
export interface BilledRecord {
  key: string;
  /** 請求額(円)。CPaSSは同じ荷物の全行(運送料金・燃料割増・混雑時割増・調整・マイナス調整)の合計 */
  billed: number;
  /** eLogiのみ: CSVの追跡番号(オーダー番号で見つからない場合の突合に使う) */
  trackingNo?: string;
}

export interface InvoiceParseResult {
  records: BilledRecord[];
  periodFrom: string | null;
  periodTo: string | null;
  lineCount: number;
}

export interface SaleRef {
  id: string;
  saleDate: string;
  managementNo: string;
  title: string | null;
  trackingInfo: string;
  orderNumbers: string[];
  /** 現在登録されている送料支払額(円)。未設定(null)は0として扱う */
  registered: number;
  /** DB上の値そのもの(更新時の「他で変更されていないか」の確認用。nullなら未設定) */
  registeredRaw: number | null;
}

export type ReconcileCategory = "under" | "over" | "shared";

export interface ReconcileRow {
  id: string;
  /** under: 請求額が登録額より多い(追加請求・調整の取りこぼし) / over: 登録額のほうが多い(関税・VAT等を含む可能性) /
   *  shared: 1つの請求に複数の売上が紐付く(按分できないため自動更新の対象外) */
  category: ReconcileCategory;
  record: BilledRecord;
  sales: SaleRef[];
  registered: number;
  billed: number;
  /** 請求額 − 登録額 */
  diff: number;
}

export interface ReconcileReport {
  source: ReconcileSource;
  rows: ReconcileRow[];
  equalCount: number;
  recordCount: number;
  /** 請求にあるが、アプリの売上に対応が見つからないもの */
  unmatched: BilledRecord[];
}

export function normKey(s: string | null | undefined): string {
  return (s ?? "").trim().toUpperCase();
}

/** "2,060" / "-67" / 数値 / ExcelJSの数式結果などを円の数値にする。解釈できなければnull */
export function parseAmount(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function cellToPrimitive(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") {
    const o = v as { result?: unknown; text?: unknown; richText?: { text: string }[] };
    if (o.result !== undefined) return o.result;
    if (o.richText) return o.richText.map((t) => t.text).join("");
    if (o.text !== undefined) return o.text;
    if (v instanceof Date) return v.toISOString();
    return String(v);
  }
  return v;
}

/**
 * CPaSS請求明細の表(ヘッダー行含む)を、order no(=追跡番号)ごとに合計する。
 * 1つの荷物に「運送料金」「燃料割増金」「混雑時割増金」などの複数行と、マイナスを含む「調整後の請求」「料金調整」
 * の行があるため、amount列を全行合算する(2026-01-08_InvoiceDetails.xlsxの全32請求期間で、全行合計=
 * invoice amount(請求総額)に一致することを確認済み)。複数の請求期間にまたがる荷物も合算する。
 */
export function aggregateInvoiceRows(table: unknown[][]): InvoiceParseResult {
  const lower = (v: unknown) => String(v ?? "").trim().toLowerCase();
  const headerIdx = table.findIndex((r) => {
    const cells = r.map(lower);
    return cells.includes("order no") && cells.includes("amount");
  });
  if (headerIdx === -1) {
    throw new Error("CPaSS請求明細のヘッダー(「order no」「amount」列)が見つかりません。ファイルをご確認ください");
  }
  const header = table[headerIdx].map(lower);
  const orderIdx = header.indexOf("order no");
  const amountIdx = header.indexOf("amount");
  const periodIdx = header.indexOf("invoice period");

  const sums = new Map<string, number>();
  let lineCount = 0;
  let periodFrom: string | null = null;
  let periodTo: string | null = null;
  for (const row of table.slice(headerIdx + 1)) {
    const key = normKey(String(row[orderIdx] ?? ""));
    const amount = parseAmount(row[amountIdx]);
    if (!key || amount === null) continue;
    sums.set(key, (sums.get(key) ?? 0) + amount);
    lineCount++;
    if (periodIdx !== -1) {
      const m = String(row[periodIdx] ?? "").match(/(\d{8})\s*-\s*(\d{8})/);
      if (m) {
        if (periodFrom === null || m[1] < periodFrom) periodFrom = m[1];
        if (periodTo === null || m[2] > periodTo) periodTo = m[2];
      }
    }
  }
  const fmt = (d: string | null) => (d ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null);
  return {
    records: Array.from(sums.entries()).map(([key, total]) => ({ key, billed: Math.round(total) })),
    periodFrom: fmt(periodFrom),
    periodTo: fmt(periodTo),
    lineCount,
  };
}

export async function parseCpassInvoiceXlsx(buffer: ArrayBuffer): Promise<InvoiceParseResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const ws = workbook.worksheets[0];
  if (!ws) throw new Error("エクセルにシートがありません");
  const table: unknown[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const vals = (row.values as unknown[]).slice(1);
    table.push(vals.map(cellToPrimitive));
  });
  return aggregateInvoiceRows(table);
}

/** CSVのバイト列を文字列にする。UTF-8で文字化け(U+FFFD)する場合はShift_JISとして読み直す(BOMは除去) */
export function decodeCsvBytes(buffer: ArrayBuffer): string {
  let text = new TextDecoder("utf-8").decode(buffer);
  if (text.includes("�")) {
    try {
      text = new TextDecoder("shift_jis").decode(buffer);
    } catch {
      // shift_jis非対応環境ではUTF-8の結果のまま返す
    }
  }
  return text.replace(/^﻿/, "");
}

export function parseCpassInvoiceCsvText(text: string): InvoiceParseResult {
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true });
  return aggregateInvoiceRows(parsed.data as unknown[][]);
}

export async function parseCpassInvoiceFile(file: File): Promise<InvoiceParseResult> {
  const buffer = await file.arrayBuffer();
  if (/\.xlsx$/i.test(file.name)) return parseCpassInvoiceXlsx(buffer);
  return parseCpassInvoiceCsvText(decodeCsvBytes(buffer));
}

function pushTo<T>(map: Map<string, T[]>, key: string, value: T) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * 請求(CPaSS=追跡番号 / eLogi=eBayオーダー番号、見つからなければ追跡番号)と売上を突合し、
 * 登録額と請求額の相違一覧を作る。差額は「請求額 − 登録額」。
 */
export function reconcile(source: ReconcileSource, records: BilledRecord[], sales: SaleRef[]): ReconcileReport {
  const byTracking = new Map<string, SaleRef[]>();
  const byOrder = new Map<string, SaleRef[]>();
  for (const s of sales) {
    const t = normKey(s.trackingInfo);
    if (t) pushTo(byTracking, t, s);
    for (const o of new Set(s.orderNumbers.map(normKey).filter(Boolean))) pushTo(byOrder, o, s);
  }

  const rows: ReconcileRow[] = [];
  const unmatched: BilledRecord[] = [];
  let equalCount = 0;
  records.forEach((rec, i) => {
    let matched: SaleRef[] | undefined;
    if (source === "cpass") {
      matched = byTracking.get(normKey(rec.key));
    } else {
      matched = byOrder.get(normKey(rec.key));
      if (!matched?.length && rec.trackingNo) matched = byTracking.get(normKey(rec.trackingNo));
    }
    if (!matched?.length) {
      unmatched.push(rec);
      return;
    }
    const registered = matched.reduce((sum, s) => sum + s.registered, 0);
    const billed = Math.round(rec.billed);
    const diff = billed - registered;
    if (Math.abs(diff) < 0.5) {
      equalCount++;
      return;
    }
    const category: ReconcileCategory = matched.length > 1 ? "shared" : diff > 0 ? "under" : "over";
    rows.push({ id: `${rec.key}#${i}`, category, record: rec, sales: matched, registered, billed, diff });
  });

  const order: Record<ReconcileCategory, number> = { under: 0, over: 1, shared: 2 };
  rows.sort((a, b) => order[a.category] - order[b.category] || Math.abs(b.diff) - Math.abs(a.diff));
  return { source, rows, equalCount, recordCount: records.length, unmatched };
}
