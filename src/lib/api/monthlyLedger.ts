// 月次売掛金Excel(仕入・販売帳)の更新ロジック。
// eBay Financial Statement(PDFをExcelに変換したファイル)、Payoneer Transaction Report取込済み
// データ(monthly_payoneer_summary、CSVの再アップロードは不要)、三菱UFJ公表レートから取得した
// 値を、ユーザーがアップロードした既存の月次売掛金Excelファイルの該当セルに書き込み、更新後の
// ファイルをダウンロードさせるための機能(2026-09-09追加、ユーザー指示)。
//
// シート構成(ユーザー提供の実ファイルで確認済み): シート名「仕入・販売帳」。
// ヘッダー行(1行目)の下、月ごとに3行1組(Soulmen行・Soulcamera行・SUM行)が並ぶ。
// A列に「2026年1月 (Soulmen)」のような「年月 (アカウント表示名)」形式の文字列が入っており、
// この文字列で対象行を特定する(既存のSUM行の数式構造を壊さないよう、新規行の追加は行わず、
// 一致する行が見つからない場合はエラーとして何も書き込まない)。
//
// 列の対応:
//   B列: eBay Financial Statementの Payout(USD) — 処理対象アカウントの行
//   G列: eBay Financial Statementの Closing Funds(USD) — 処理対象アカウントの行
//   D列: monthly_payoneer_summary.credit_amount_total(対象月) — 常にSoulmen行(ユーザー指示、
//        Payoneerは2アカウント統合のため月に1回のみ記載する既存の慣例に合わせる)
//   I列: monthly_payoneer_summary.running_balance_start(対象月) — 常にSoulmen行(同上)
//   K列: 三菱UFJ公表の対象月末営業日TTM — 同じ月のSoulmen行・Soulcamera行の両方(ユーザー指示、
//        既存データが両行とも同じ値になっているため)
//   C・E・F・H・J・M列は既存の数式(=B*K 等)のままにする(値を上書きしない)。

import ExcelJS from "exceljs";

const LEDGER_SHEET_NAME = "仕入・販売帳";

const ACCOUNT_LABELS: Record<string, string> = {
  soulcamera: "Soulcamera",
  soulmenjapan: "Soulmen",
};

export interface LedgerUpdateInput {
  ledgerBuffer: ArrayBuffer;
  ebayAccount: string; // "soulcamera" | "soulmenjapan"
  yearMonth: string; // "YYYY-MM"
  payoutUsd: number;
  closingFundsUsd: number;
  payoneerCreditAmountSum: number;
  payoneerLatestRunningBalance: number | null;
  mufgRate: number;
}

export interface LedgerUpdateResult {
  buffer: ArrayBuffer;
  updatedRowLabels: string[]; // デバッグ・確認メッセージ用に、実際に書き込んだ行のA列テキスト一覧
}

function findRow(worksheet: ExcelJS.Worksheet, label: string): ExcelJS.Row | null {
  let found: ExcelJS.Row | null = null;
  worksheet.eachRow((row) => {
    if (found) return;
    const value = row.getCell(1).value;
    const text = typeof value === "string" ? value.trim() : null;
    if (text === label) found = row;
  });
  return found;
}

/**
 * 月次売掛金Excel(仕入・販売帳)を更新する。対象月・アカウントの行(Soulmen行・Soulcamera行の
 * いずれも)が見つからない場合はエラーを投げ、ファイルには一切書き込まない(ユーザー指示)。
 */
export async function updateMonthlyLedgerWorkbook(input: LedgerUpdateInput): Promise<LedgerUpdateResult> {
  const accountLabel = ACCOUNT_LABELS[input.ebayAccount];
  if (!accountLabel) {
    throw new Error(`未対応のeBayアカウントです: ${input.ebayAccount}`);
  }
  const [yearStr, monthStr] = input.yearMonth.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  if (!year || !month) {
    throw new Error(`対象年月の形式が不正です: ${input.yearMonth}`);
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(input.ledgerBuffer);
  const worksheet = workbook.getWorksheet(LEDGER_SHEET_NAME) ?? workbook.worksheets[0];
  if (!worksheet) {
    throw new Error("Excelファイルにシートが見つかりませんでした");
  }

  const monthPrefix = `${year}年${month}月`;
  const accountRowLabel = `${monthPrefix} (${accountLabel})`;
  const soulmenRowLabel = `${monthPrefix} (${ACCOUNT_LABELS.soulmenjapan})`;
  const soulcameraRowLabel = `${monthPrefix} (${ACCOUNT_LABELS.soulcamera})`;

  const accountRow = findRow(worksheet, accountRowLabel);
  if (!accountRow) {
    throw new Error(
      `アップロードされた月次売掛金Excelに「${accountRowLabel}」の行が見つかりませんでした。対象月・アカウントの行があらかじめ用意されているファイルを使用してください。`,
    );
  }
  const soulmenRow = findRow(worksheet, soulmenRowLabel);
  if (!soulmenRow) {
    throw new Error(`アップロードされた月次売掛金Excelに「${soulmenRowLabel}」の行が見つかりませんでした。`);
  }
  const soulcameraRow = findRow(worksheet, soulcameraRowLabel);
  if (!soulcameraRow) {
    throw new Error(`アップロードされた月次売掛金Excelに「${soulcameraRowLabel}」の行が見つかりませんでした。`);
  }

  // B・G列(Payout・Closing Funds): 処理対象アカウントの行
  accountRow.getCell(2).value = input.payoutUsd; // B
  accountRow.getCell(7).value = input.closingFundsUsd; // G

  // D・I列(Payoneer): 常にSoulmen行(ユーザー指示)
  soulmenRow.getCell(4).value = input.payoneerCreditAmountSum; // D
  if (input.payoneerLatestRunningBalance != null) {
    soulmenRow.getCell(9).value = input.payoneerLatestRunningBalance; // I
  }

  // K列(月末レート): 同じ月のSoulmen行・Soulcamera行の両方(ユーザー指示)
  soulmenRow.getCell(11).value = input.mufgRate; // K
  soulcameraRow.getCell(11).value = input.mufgRate; // K

  const buffer = await workbook.xlsx.writeBuffer();
  return {
    buffer: buffer as ArrayBuffer,
    updatedRowLabels: Array.from(new Set([accountRowLabel, soulmenRowLabel, soulcameraRowLabel])),
  };
}
