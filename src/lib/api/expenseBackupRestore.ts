import { type ExpenseInput, type TaxCategory } from "./expenses";
import { type MappedExpenseRow } from "./expenseExcelImport";

/**
 * ExpensesPage の「登録データバックアップ」が出力するCSV
 * (領収日,カテゴリ,事業者名,内容,金額,課税区分,適格請求書発行事業者番号,領収書保管フォルダ,データ由来,登録日時)
 * から経費データを復元するためのロジック。
 */

export const BACKUP_CSV_HEADERS = [
  "領収日",
  "カテゴリ",
  "事業者名",
  "内容",
  "金額",
  "課税区分",
  "適格請求書発行事業者番号",
  "領収書保管フォルダ",
  "データ由来",
  "登録日時",
];

/** RFC4180に準じたシンプルなCSVパーサ(ダブルクォート囲み・""エスケープ・セル内改行に対応)。 */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r") {
      // 続く \n はそのまま読み飛ばされて次のループでフィールド確定される
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

export interface BackupRawRow {
  rowNumber: number; // CSV実物の行番号(ヘッダーが1行目、データは2行目〜)
  expenseDateRaw: string;
  category: string;
  vendor: string;
  description: string;
  amountRaw: string;
  taxCategoryRaw: string;
  invoiceRegistrationNo: string;
  receiptFolderPath: string;
  source: string;
}

export function buildBackupRawRows(rows: string[][]): { raw: BackupRawRow[]; headerError: string | null } {
  if (rows.length === 0) {
    return { raw: [], headerError: "CSVにデータがありません" };
  }
  const header = rows[0];
  const headerMatches = BACKUP_CSV_HEADERS.every((h, i) => (header[i] ?? "").trim() === h);
  if (!headerMatches) {
    return {
      raw: [],
      headerError:
        "CSVのヘッダー列が想定と異なります。「登録データバックアップ」で出力したCSVファイルを指定してください" +
        `(想定ヘッダー: ${BACKUP_CSV_HEADERS.join(",")})`,
    };
  }

  const raw: BackupRawRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length === 1 && (r[0] ?? "").trim() === "") continue;
    raw.push({
      rowNumber: i + 1,
      expenseDateRaw: r[0] ?? "",
      category: r[1] ?? "",
      vendor: r[2] ?? "",
      description: r[3] ?? "",
      amountRaw: r[4] ?? "",
      taxCategoryRaw: r[5] ?? "",
      invoiceRegistrationNo: r[6] ?? "",
      receiptFolderPath: r[7] ?? "",
      source: r[8] ?? "",
    });
  }
  return { raw, headerError: null };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** バックアップCSVの1行を検証し、DB投入用の形式に変換する(同期処理のみ、DBアクセスなし)。 */
export function mapBackupRow(raw: BackupRawRow): MappedExpenseRow {
  const errors: string[] = [];
  const warnings: string[] = [];
  const rowId = `backup#${raw.rowNumber}`;

  const expenseDate = raw.expenseDateRaw.trim();
  if (!DATE_RE.test(expenseDate)) {
    errors.push(`領収日の形式が不正です(値: "${raw.expenseDateRaw}")。YYYY-MM-DD形式である必要があります`);
  }

  const category = raw.category.trim();
  if (!category) {
    errors.push("カテゴリが空欄です");
  }

  const amount = Number(raw.amountRaw);
  if (raw.amountRaw.trim() === "" || !Number.isFinite(amount)) {
    errors.push(`金額が数値として読み取れません(値: "${raw.amountRaw}")`);
  }

  const taxCategoryRaw = raw.taxCategoryRaw.trim();
  let taxCategory: TaxCategory = "課税";
  if (taxCategoryRaw === "課税" || taxCategoryRaw === "不課税") {
    taxCategory = taxCategoryRaw;
  } else if (taxCategoryRaw !== "") {
    warnings.push(`課税区分が不明な値のため「課税」として扱います(値: "${raw.taxCategoryRaw}")`);
  }

  const vendor = raw.vendor.trim();
  const description = raw.description.trim();
  if (!vendor) warnings.push("事業者名が空欄です");
  if (!description) warnings.push("内容が空欄です");
  warnings.push("復元後の登録日時は復元実行時刻になります(元の登録日時は保持されません)");

  const hasErrors = errors.length > 0;
  const input: ExpenseInput | null = hasErrors
    ? null
    : {
        expense_date: expenseDate,
        category,
        vendor: vendor || undefined,
        description: description || undefined,
        amount,
        tax_category: taxCategory,
        invoice_registration_no: raw.invoiceRegistrationNo.trim() || undefined,
        receipt_folder_path: raw.receiptFolderPath.trim() || undefined,
        // データ由来(手動登録/エクセル取込など)は元の値をそのまま引き継ぐ。空欄なら createExpense 側で "manual" 扱い。
        source: raw.source.trim() || undefined,
      };

  return {
    raw: {
      sheetName: "バックアップCSV",
      rowNumber: raw.rowNumber,
      category,
      dateRaw: raw.expenseDateRaw,
      vendor: vendor || null,
      amountRaw: raw.amountRaw,
      description: description || null,
      taxCategory,
      invoiceRegistrationNo: raw.invoiceRegistrationNo.trim() || null,
    },
    rowId,
    outcome: hasErrors ? "error" : "new",
    errors,
    warnings,
    input,
  };
}
