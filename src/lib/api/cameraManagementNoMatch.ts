import { supabase } from "../supabaseClient";
import { updateItemBasicInfo } from "./items";

/**
 * 「カメラ」エクセルシートの追加行(既定154〜716行、2026-09-01ユーザー指示により新規追加)を読み取り、
 * 既に取り込み済みのDB上の商品(items+purchases)と「仕入品名・仕入先・仕入先2・仕入高」の4項目で突合し、
 * 一致した商品の management_no をこの行のN列の値で上書き更新する機能。
 *
 * 背景: 「仕入・販売帳」シートのカメラ(C)行突合(purchaseLedgerImport.ts)でマッチしなかった行は
 * 仮の管理番号(C-R行番号)で新規登録されるようになった(2026-09-01(5))。その後ユーザーが「カメラ」シートの
 * 追加行(154行目以降)に正式な管理番号を記入したため、この仮番号の商品を実際の管理番号へ置き換える手段として
 * 本機能を追加した。既存商品の items/purchases の他フィールド(仕入高・仕入先等)は一切更新しない
 * (management_no のみを上書きする、ユーザー指示通り)。
 *
 * 2026-09-01(7): 突合方式をユーザー指示により変更。当初は「仕入日・仕入品名・仕入先・仕入先2・新品/古物判定・
 * 仕入高」の6項目一致だったが、「仕入品名・仕入先・仕入先2・仕入高」の4項目一致に変更した(「仕入・販売帳」
 * 側の突合方式(purchaseLedgerImport.ts)と統一)。仕入日・新品/古物判定は突合キーから除外したため、
 * 「カメラ」シートのB列(仕入日)・F列(新品・古物判定)はこの機能では読み取らない。
 */

// 「仕入先」列 → アプリの source_type 区分へのマッピング(purchaseLedgerImport.ts / cameraStockImport.ts と同じ対応表)。
const SOURCE_TYPE_MAP: Record<string, string> = {
  メルカリ: "mercari",
  ヤフオク: "yahoo_auction",
  ヤフーフリマ: "yahoo_furima",
  ラクマ: "rakuma",
};

const CATEGORY = "カメラ関連品";

export interface CameraMatchRawRow {
  rowNumber: number;
  itemName: string | null; // C 仕入品名
  sourceMain: string | null; // D 仕入先
  sourceSub: string | null; // E 仕入先2
  purchasePrice: number | null; // L 仕入高合計
  newManagementNoRaw: string | null; // N 管理番号(この値で既存商品を上書きする)
}

export type CameraMatchOutcome = "matched" | "unmatched" | "ambiguous" | "error";

export interface MappedCameraMatchRow {
  raw: CameraMatchRawRow;
  rowNumber: number;
  newManagementNo: string | null;
  /** 突合キー(内部用)。DBアクセス前、mapCameraMatchRawRow() の時点で算出済み。 */
  matchKey: string | null;
  outcome: CameraMatchOutcome;
  errors: string[];
  warnings: string[];
  existingItemId: string | null;
  existingManagementNo: string | null;
  /** 突合先の既存商品が既にこの新しい管理番号を持っている場合 true(更新不要)。 */
  noChangeNeeded: boolean;
}

function buildMatchKey(
  itemName: string,
  sourceType: string,
  sourceName: string | undefined,
  purchasePrice: number,
): string {
  return JSON.stringify([itemName, sourceType, sourceName ?? null, purchasePrice]);
}

/** 1行分の生データを検証し、突合キーまで組み立てる(同期処理のみ、DBアクセスなし)。 */
export function mapCameraMatchRawRow(raw: CameraMatchRawRow): MappedCameraMatchRow {
  const errors: string[] = [];
  const warnings: string[] = [];

  const newManagementNo = (raw.newManagementNoRaw ?? "").trim() || null;
  if (!newManagementNo) {
    errors.push("新しい管理番号(N列)が空欄です");
  }

  const itemName = (raw.itemName ?? "").trim();
  if (!itemName) {
    errors.push("仕入品名が空欄のため突合できません");
  }

  if (raw.purchasePrice == null) {
    errors.push("仕入高(L列)が空欄のため突合できません");
  }

  const sourceType = raw.sourceMain ? SOURCE_TYPE_MAP[raw.sourceMain.trim()] ?? "other" : "other";
  const sourceName = (raw.sourceSub && raw.sourceSub.trim()) || (raw.sourceMain && raw.sourceMain.trim()) || undefined;

  const hasErrors = errors.length > 0;
  const matchKey = hasErrors ? null : buildMatchKey(itemName, sourceType, sourceName, raw.purchasePrice ?? 0);

  return {
    raw,
    rowNumber: raw.rowNumber,
    newManagementNo,
    matchKey,
    // 突合前の初期値。applyCameraManagementNoMatches() で確定させる(エラー行はこの時点で確定)。
    outcome: hasErrors ? "error" : "unmatched",
    errors,
    warnings,
    existingItemId: null,
    existingManagementNo: null,
    noChangeNeeded: false,
  };
}

/**
 * 対象行を「カメラ関連品」カテゴリの既存商品(items+purchases+title)と突合する。
 * 絞り込みクエリは使わず全件取得する(「仕入・販売帳」側の突合と同じ設計。仕入品名を含む長い文字列を
 * .in() でチャンク検索するとURL長超過で失敗する不具合が過去にあったため、同じ轍を踏まないようにしている)。
 */
export async function applyCameraManagementNoMatches(rows: MappedCameraMatchRow[]): Promise<void> {
  const targets = rows.filter((r) => r.outcome !== "error" && r.matchKey);
  if (targets.length === 0) return;

  const { data, error } = await supabase
    .from("items")
    .select("id, management_no, title, purchases(purchase_price, source_type, source_name)")
    .eq("category", CATEGORY);
  if (error) throw error;

  const byKey = new Map<string, { id: string; management_no: string }[]>();
  for (const row of data as unknown as Array<{
    id: string;
    management_no: string;
    title: string | null;
    purchases:
      | {
          purchase_price: number;
          source_type: string | null;
          source_name: string | null;
        }
      | {
          purchase_price: number;
          source_type: string | null;
          source_name: string | null;
        }[]
      | null;
  }>) {
    const purchase = Array.isArray(row.purchases) ? row.purchases[0] : row.purchases;
    if (!purchase) continue;
    const key = buildMatchKey(
      (row.title ?? "").trim(),
      purchase.source_type ?? "other",
      purchase.source_name ?? undefined,
      purchase.purchase_price,
    );
    const list = byKey.get(key) ?? [];
    list.push({ id: row.id, management_no: row.management_no });
    byKey.set(key, list);
  }

  for (const row of targets) {
    if (!row.matchKey) continue;
    const candidates = byKey.get(row.matchKey) ?? [];
    if (candidates.length > 1) {
      row.outcome = "ambiguous";
      row.errors.push(
        `同一の内容(仕入品名・仕入先・仕入先2・仕入高)に一致する既存商品が複数見つかったため、一意に特定できませんでした(候補の管理番号: ${candidates
          .map((c) => c.management_no)
          .join(", ")})`,
      );
    } else if (candidates.length === 1) {
      const match = candidates[0];
      row.outcome = "matched";
      row.existingItemId = match.id;
      row.existingManagementNo = match.management_no;
      row.noChangeNeeded = match.management_no === row.newManagementNo;
    } else {
      row.outcome = "unmatched";
      row.warnings.push("一致する既存商品が見つかりませんでした(この行では管理番号の更新は行われません)");
    }
  }
}

/** 「マッチ」した行のうち、新しい管理番号(N列)がこの取込データ内で他の行と重複していないか検出する。 */
export function markInBatchDuplicateTargets(rows: MappedCameraMatchRow[]): void {
  const seen = new Map<string, number>();
  for (const row of rows) {
    if (row.outcome !== "matched" || !row.newManagementNo) continue;
    const count = seen.get(row.newManagementNo) ?? 0;
    seen.set(row.newManagementNo, count + 1);
    if (count > 0) {
      row.outcome = "error";
      row.errors.push("この取込データ内で、新しい管理番号(N列)が他の行と重複しています");
    }
  }
}

/**
 * 短い文字列(管理番号)の200件チャンク検索は URL 長の問題が起きないことを確認済み
 * (findExistingManagementNos と同じ設計、purchaseLedgerImport.ts 参照)。
 */
export async function findManagementNoOwners(managementNos: string[]): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  const uniqueNos = Array.from(new Set(managementNos));
  if (uniqueNos.length === 0) return owners;
  const CHUNK = 200;
  for (let i = 0; i < uniqueNos.length; i += CHUNK) {
    const chunk = uniqueNos.slice(i, i + CHUNK);
    const { data, error } = await supabase.from("items").select("id, management_no").in("management_no", chunk);
    if (error) throw error;
    for (const row of (data ?? []) as { id: string; management_no: string }[]) {
      owners.set(row.management_no, row.id);
    }
  }
  return owners;
}

/**
 * 「マッチ」した行の新しい管理番号(N列)が、突合先とは別の既存商品に既に使われていないか確認し、
 * 該当する場合はエラー化して取込対象外にする(management_noのユニーク制約違反を未然に防ぐ)。
 */
export function markConflictingTargets(rows: MappedCameraMatchRow[], owners: Map<string, string>): void {
  for (const row of rows) {
    if (row.outcome !== "matched" || !row.newManagementNo) continue;
    if (row.noChangeNeeded) continue; // 突合先自身が既にこの番号を持っている場合は問題ない
    const ownerId = owners.get(row.newManagementNo);
    if (ownerId && ownerId !== row.existingItemId) {
      row.outcome = "error";
      row.errors.push(`新しい管理番号「${row.newManagementNo}」は既に別の商品で使用されているため更新できません`);
    }
  }
}

export interface ManagementNoUpdateResult {
  rowNumber: number;
  newManagementNo: string | null;
  success: boolean;
  /** true の場合、突合先が既に同じ管理番号を持っていたため、実際の更新は行わずスキップしたことを示す。 */
  skipped?: boolean;
  message: string;
}

/** 1行分、突合先の商品の management_no のみを上書き更新する(他のフィールドは一切変更しない)。 */
export async function executeCameraManagementNoUpdateRow(
  row: MappedCameraMatchRow,
): Promise<ManagementNoUpdateResult> {
  if (row.outcome !== "matched" || !row.existingItemId || !row.newManagementNo) {
    return {
      rowNumber: row.rowNumber,
      newManagementNo: row.newManagementNo,
      success: false,
      message: "更新対象外の行です",
    };
  }
  if (row.noChangeNeeded) {
    return {
      rowNumber: row.rowNumber,
      newManagementNo: row.newManagementNo,
      success: true,
      skipped: true,
      message: "変更なし(既に同じ管理番号のため更新していません)",
    };
  }
  try {
    await updateItemBasicInfo(row.existingItemId, { management_no: row.newManagementNo });
    return {
      rowNumber: row.rowNumber,
      newManagementNo: row.newManagementNo,
      success: true,
      message: `更新完了(旧: ${row.existingManagementNo} → 新: ${row.newManagementNo})`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "不明なエラー";
    return { rowNumber: row.rowNumber, newManagementNo: row.newManagementNo, success: false, message };
  }
}
