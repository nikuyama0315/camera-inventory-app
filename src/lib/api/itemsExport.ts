import ExcelJS from "exceljs";
import { supabase } from "../supabaseClient";
import type { Item } from "../types";

/**
 * 「絞込条件でファイル作成」ボタン(詳細編集・一覧表示の両方、2026-09-29追加、ユーザー指示)用。
 * items テーブルの17項目を、アプリ画面で実際に表示している日本語名を列見出しにしてExcel出力する。
 * listing_status_code のみ画面上に表示名が無い内部項目のため、ユーザー指示によりカラム名のまま。
 */
const ITEM_EXPORT_COLUMNS: { key: keyof Item; label: string }[] = [
  { key: "management_no", label: "管理番号" },
  { key: "category", label: "カテゴリ" },
  { key: "brand", label: "ブランド" },
  { key: "model", label: "機種名" },
  { key: "serial_number", label: "シリアル番号(ボディー)" },
  { key: "title", label: "仕入品名" },
  { key: "status", label: "ステータス" },
  { key: "created_at", label: "登録日時" },
  { key: "updated_at", label: "更新日" },
  { key: "platform_category", label: "出品カテゴリ(category)" },
  { key: "grade", label: "グレード(grade)" },
  { key: "accessories_included", label: "付属品" },
  { key: "account", label: "アカウント" },
  { key: "item_title", label: "ITEM TITLE" },
  { key: "type", label: "タイプ" },
  { key: "lens_serial_number", label: "シリアル番号(レンズ)" },
];

/** items テーブルに画面表示用の型(Item)が持たないlisting_status_code列だけを、
 *  全件まとめて1回のクエリで取得する(2列だけの軽量クエリのため、絞り込み後のID一覧を
 *  URLに詰め込む必要が無い)。 */
async function fetchListingStatusCodeMap(): Promise<Map<string, string | null>> {
  const { data, error } = await supabase.from("items").select("id, listing_status_code");
  if (error) throw error;
  const map = new Map<string, string | null>();
  for (const row of data as { id: string; listing_status_code: string | null }[]) {
    map.set(row.id, row.listing_status_code);
  }
  return map;
}

/** 現在の絞り込み結果(items)をExcelファイルとしてダウンロードする。 */
export async function exportItemsToXlsx(items: Item[], fileLabel: string): Promise<void> {
  const listingStatusCodeMap = await fetchListingStatusCodeMap();

  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet("items");

  ws.addRow([...ITEM_EXPORT_COLUMNS.map((c) => c.label), "listing_status_code"]);
  ws.getRow(1).font = { bold: true };

  for (const item of items) {
    const row = ITEM_EXPORT_COLUMNS.map((c) => item[c.key] ?? "");
    row.push(listingStatusCodeMap.get(item.id) ?? "");
    ws.addRow(row);
  }

  ws.columns.forEach((col) => {
    col.width = 22;
  });

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer as BlobPart], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  a.href = url;
  a.download = `items_${fileLabel}_${today}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
