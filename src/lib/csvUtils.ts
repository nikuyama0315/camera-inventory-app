import Papa from "papaparse";

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

/**
 * eBay/Payoneerの各種レポートCSVは、実際の列ヘッダー行の前に請求書番号・対象期間などの
 * メタデータ行が数行(Tax Invoiceは6行目、Transaction Reportは12行目など)含まれることがある。
 * headerSignatureに含まれる文字列を(大文字小文字を無視して)すべて含む最初の行をヘッダー行と
 * みなし、それより前の行を読み飛ばす。該当行が見つからない場合は元のテキストをそのまま返し、
 * 後続のバリデーション(0件エラー)に判断を委ねる。
 */
export function stripMetadataRows(text: string, headerSignature: string[]): string {
  if (headerSignature.length === 0) return text;
  const lines = text.split(/\r\n|\n|\r/);
  const lowerSignature = headerSignature.map((s) => s.toLowerCase());
  const headerIndex = lines.findIndex((line) => {
    const lowerLine = line.toLowerCase();
    return lowerSignature.every((sig) => lowerLine.includes(sig));
  });
  if (headerIndex === -1) return text;
  return lines.slice(headerIndex).join("\n");
}

/**
 * headerSignatureを指定すると、その列名群が揃っている行をヘッダー行として自動検出してから
 * パースする(先頭のメタデータ行を読み飛ばす)。省略時は従来どおり1行目をヘッダーとして扱う。
 */
export function parseCsvFile(file: File, headerSignature?: string[]): Promise<ParsedCsv> {
  return new Promise((resolve, reject) => {
    const runParse = (input: File | string) => {
      Papa.parse(input as File, {
        header: true,
        skipEmptyLines: true,
        complete: (result) => {
          resolve({
            headers: result.meta.fields ?? [],
            rows: result.data as Record<string, string>[],
          });
        },
        error: (err: Error) => reject(err),
      });
    };

    if (!headerSignature || headerSignature.length === 0) {
      runParse(file);
      return;
    }

    file
      .text()
      .then((text) => runParse(stripMetadataRows(text, headerSignature)))
      .catch(reject);
  });
}

/**
 * 候補となるヘッダー名(複数)の中から、実際のCSVヘッダーに含まれるものを探して値を取得する。
 * 完全一致優先、見つからなければ大文字小文字を無視した部分一致でフォールバックする。
 * eBay/Payoneerの正式なエクスポート列名は入手できていないため、想定される複数の表記ゆれに対応する。
 */
// eBayのCSVエクスポートは「該当データなし」を空文字ではなく "--" というプレースホルダーで
// 表現することが多い(Transaction Report CSV等で確認済み)。空文字と同様に「値なし」として扱う。
function isBlankValue(v: string | undefined): boolean {
  return v === undefined || v === "" || v === "--";
}

export function pickField(row: Record<string, string>, candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (!isBlankValue(row[candidate])) {
      return row[candidate];
    }
  }
  const keys = Object.keys(row);
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    const match = keys.find((k) => k.toLowerCase().includes(lower) || lower.includes(k.toLowerCase()));
    if (match && !isBlankValue(row[match])) {
      return row[match];
    }
  }
  return null;
}

export function toNumberOrNull(value: string | null): number | null {
  if (value == null || value.trim() === "") return null;
  const cleaned = value.replace(/[,\s]/g, "").replace(/^\$/, "");
  const n = Number(cleaned);
  return Number.isNaN(n) ? null : n;
}

export function toDateOrNull(value: string | null): string | null {
  if (value == null || value.trim() === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}
