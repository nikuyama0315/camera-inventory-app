// 月次売掛金Excel(仕入・販売帳)の更新ロジック。
// eBay Financial Statement・Payoneer Transaction Report取込済みデータ(monthly_payoneer_summary)、
// 三菱UFJ公表レートから取得した値を、ユーザーがアップロードした既存の月次売掛金Excelファイルの
// 該当セルに書き込み、更新後のファイルをダウンロードさせるための機能(2026-09-09追加、ユーザー指示)。
//
// シート構成(ユーザー提供の実ファイルで確認済み): シート名「仕入・販売帳」。
// ヘッダー行(1行目)の下、月ごとに3行1組(Soulmen行・Soulcamera行・SUM行)が並ぶ。
// A列に「2026年1月 (Soulmen)」のような「年月 (アカウント表示名)」形式の文字列が入っており、
// この文字列で対象行を特定する(既存のSUM行の数式構造を壊さないよう、新規行の追加は行わず、
// 一致する行が見つからない場合はエラーとして何も書き込まない)。
//
// 【2026-09-09修正】当初は対象アカウント・対象年月をユーザーに選択させていたが、ユーザー指摘
// 「ファイルは2アカウント統合なのでアカウント選択は不要、年月もExcelで未入力の月に自動で
// 入力してほしい」を受け、月次売掛金Excel自体を走査して「まだ入力されていない最初の月」を
// 自動検出し、その月についてSoulmen・Soulcamera両方の行を一度に更新する方式に変更した。
//
// 列の対応:
//   B列: eBay Financial StatementのPayout(USD) — Soulmen行・Soulcamera行それぞれ、対応する
//        アカウントの値
//   G列: eBay Financial StatementのClosing Funds(USD) — 同上
//   D列: monthly_payoneer_summary.credit_amount_total(対象月) — 常にSoulmen行(ユーザー指示、
//        Payoneerは2アカウント統合のため月に1回のみ記載する既存の慣例に合わせる)
//   I列: monthly_payoneer_summary.running_balance_start(対象月) — 常にSoulmen行(同上)
//   K列: 三菱UFJ公表の対象月末営業日TTM — 同じ月のSoulmen行・Soulcamera行の両方(ユーザー指示、
//        既存データが両行とも同じ値になっているため)
//   C・E・F・H・J・M列は既存の数式(=B*K 等)のままにする(値を上書きしない)。

import ExcelJS from "exceljs";

const LEDGER_SHEET_NAME = "仕入・販売帳";

const ROW_LABEL_RE = /^(\d{4})年(\d{1,2})月 \((Soulmen|Soulcamera)\)$/;

interface MonthRows {
  yearMonth: string; // "YYYY-MM"
  monthLabel: string; // 例: "2026年1月"
  soulmenRow: ExcelJS.Row;
  soulcameraRow: ExcelJS.Row;
  rowOrder: number; // シート上での最初の出現順(検出順の判定用)
}

async function loadWorksheet(ledgerBuffer: ArrayBuffer): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(ledgerBuffer);
  const worksheet = workbook.getWorksheet(LEDGER_SHEET_NAME) ?? workbook.worksheets[0];
  if (!worksheet) {
    throw new Error("Excelファイルにシートが見つかりませんでした");
  }
  return worksheet;
}

/** シートを走査し、A列のラベルから月ごとのSoulmen行・Soulcamera行の組を、出現順に集める。 */
function collectMonthRows(worksheet: ExcelJS.Worksheet): MonthRows[] {
  const byMonth = new Map<string, Partial<MonthRows> & { rowOrder: number }>();
  let order = 0;
  worksheet.eachRow((row) => {
    const value = row.getCell(1).value;
    const text = typeof value === "string" ? value.trim() : null;
    if (!text) return;
    const m = text.match(ROW_LABEL_RE);
    if (!m) return;
    const [, yearStr, monthStr, accountLabel] = m;
    const yearMonth = `${yearStr}-${monthStr.padStart(2, "0")}`;
    const entry = byMonth.get(yearMonth) ?? { yearMonth, monthLabel: `${yearStr}年${monthStr}月`, rowOrder: order++ };
    if (accountLabel === "Soulmen") entry.soulmenRow = row;
    else entry.soulcameraRow = row;
    byMonth.set(yearMonth, entry);
  });
  return Array.from(byMonth.values())
    .filter((e): e is MonthRows => !!e.soulmenRow && !!e.soulcameraRow)
    .sort((a, b) => a.rowOrder - b.rowOrder);
}

/**
 * 月次売掛金Excelを走査し、Soulmen行・Soulcamera行のいずれかでB列(Payout)が未入力の、
 * 最初の月を対象月として返す(ユーザー指示: 年月・アカウントを選ばせず、Excel側の状態から
 * 自動判定する)。全ての月が入力済みの場合はnullを返す。
 */
export async function detectTargetMonth(
  ledgerBuffer: ArrayBuffer,
): Promise<{ yearMonth: string; monthLabel: string } | null> {
  const worksheet = await loadWorksheet(ledgerBuffer);
  const months = collectMonthRows(worksheet);
  for (const m of months) {
    const soulmenFilled = m.soulmenRow.getCell(2).value != null;
    const soulcameraFilled = m.soulcameraRow.getCell(2).value != null;
    if (!soulmenFilled || !soulcameraFilled) {
      return { yearMonth: m.yearMonth, monthLabel: m.monthLabel };
    }
  }
  return null;
}

export interface AccountFinancialFigures {
  payoutUsd: number;
  closingFundsUsd: number;
}

export interface LedgerUpdateInput {
  ledgerBuffer: ArrayBuffer;
  yearMonth: string; // "YYYY-MM"(あらかじめdetectTargetMonthで検出した値を渡す)
  soulcamera: AccountFinancialFigures;
  soulmenjapan: AccountFinancialFigures;
  payoneerCreditAmountSum: number;
  payoneerLatestRunningBalance: number | null;
  mufgRate: number;
}

export interface LedgerUpdateResult {
  buffer: ArrayBuffer;
  updatedRowLabels: string[]; // デバッグ・確認メッセージ用に、実際に書き込んだ行のA列テキスト一覧
}

/**
 * 月次売掛金Excel(仕入・販売帳)を更新する。対象月の行(Soulmen行・Soulcamera行のいずれも)が
 * 見つからない場合はエラーを投げ、ファイルには一切書き込まない。
 */
export async function updateMonthlyLedgerWorkbook(input: LedgerUpdateInput): Promise<LedgerUpdateResult> {
  const worksheet = await loadWorksheet(input.ledgerBuffer);
  const months = collectMonthRows(worksheet);
  const target = months.find((m) => m.yearMonth === input.yearMonth);
  if (!target) {
    throw new Error(
      `アップロードされた月次売掛金Excelに「${input.yearMonth}」の行が見つかりませんでした。`,
    );
  }
  const { soulmenRow, soulcameraRow } = target;

  // B・G列(Payout・Closing Funds): Soulmen行・Soulcamera行それぞれ対応するアカウントの値
  soulmenRow.getCell(2).value = input.soulmenjapan.payoutUsd; // B
  soulmenRow.getCell(7).value = input.soulmenjapan.closingFundsUsd; // G
  soulcameraRow.getCell(2).value = input.soulcamera.payoutUsd; // B
  soulcameraRow.getCell(7).value = input.soulcamera.closingFundsUsd; // G

  // D・I列(Payoneer): 常にSoulmen行(ユーザー指示)
  soulmenRow.getCell(4).value = input.payoneerCreditAmountSum; // D
  if (input.payoneerLatestRunningBalance != null) {
    soulmenRow.getCell(9).value = input.payoneerLatestRunningBalance; // I
  }

  // K列(月末レート): 同じ月のSoulmen行・Soulcamera行の両方(ユーザー指示)
  soulmenRow.getCell(11).value = input.mufgRate; // K
  soulcameraRow.getCell(11).value = input.mufgRate; // K

  const buffer = await worksheet.workbook.xlsx.writeBuffer();
  return {
    buffer: buffer as ArrayBuffer,
    updatedRowLabels: [
      `${target.monthLabel} (Soulmen)`,
      `${target.monthLabel} (Soulcamera)`,
    ],
  };
}
