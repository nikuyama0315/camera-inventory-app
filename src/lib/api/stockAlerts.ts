import { supabase } from "../supabaseClient";

export interface ModelDriveStockCount {
  model_folder_name: string;
  in_stock_count: number;
  checked_at: string;
  /** Google Drive上の機種名フォルダ自体のフォルダID(sync-drive-stock-countsが在庫数取得時に記録) */
  drive_folder_id: string | null;
}

export interface ModelStockAlertSetting {
  id: string;
  model_folder_name: string;
  threshold: number;
  notify_email: string;
  last_alert_sent_at: string | null;
  last_known_count: number | null;
  purchasing_count: number;
}

export interface ModelStockRow {
  model_folder_name: string;
  in_stock_count: number;
  threshold: number;
  belowThreshold: boolean;
  /** Google Driveから在庫数を最後に取得した日時。まだ一度も取得していない機種はnull(2026-08-31追加) */
  checked_at: string | null;
  /** 仕入中(発注済み・未入荷)の数量。機種名フォルダに紐づけて手動入力する(2026-09-13追加) */
  purchasing_count: number;
  /**
   * 機種名フォルダに対応するGoogle DriveフォルダのURL。
   * model_stock_alert_settingsに手動登録されたURLがあればそれを優先し、無ければ
   * model_drive_stock_counts.drive_folder_id(Google Drive実フォルダのスキャンで自動取得した
   * フォルダID)から組み立てたURLを使う。どちらも無ければnull(2026-09-15追加)。
   */
  drive_folder_url: string | null;
}

/** 機種名の表記ゆれ(大文字小文字・前後の空白)を吸収するための正規化キー */
function normalizeModelName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * 在庫数・しきい値の一覧を取得する。
 *
 * 在庫数(2026-08-31変更): Google Drive上の実フォルダ構造(@撮影済み・出品待ちフォルダ配下の
 * 機種名フォルダの中にあるサブフォルダ=商品フォルダの数)をキャッシュしたテーブル
 * model_drive_stock_counts から取得する。このキャッシュは sync-drive-stock-counts
 * Edge Function(syncDriveStockCounts関数)を実行するたびに更新される。
 * しきい値は従来通り model_stock_alert_settings 由来。
 */
export async function fetchModelStockOverview(): Promise<ModelStockRow[]> {
  const { data: counts, error: countsError } = await supabase
    .from("model_drive_stock_counts")
    .select("*")
    .order("model_folder_name");
  if (countsError) throw countsError;

  const { data: settings, error: settingsError } = await supabase
    .from("model_stock_alert_settings")
    .select("model_folder_name, threshold, purchasing_count, drive_folder_url")
    .order("model_folder_name");
  if (settingsError) throw settingsError;

  // 双方の機種名の表記が完全一致するとは限らない(大文字小文字・前後空白の違いなど)ため、
  // 正規化したキーで突合する。表示名はしきい値設定側(ユーザーが登録した名称)を優先して使う。
  const countMap = new Map<string, ModelDriveStockCount>();
  for (const c of counts as ModelDriveStockCount[]) {
    countMap.set(normalizeModelName(c.model_folder_name), c);
  }
  const thresholdMap = new Map<string, number>();
  const purchasingMap = new Map<string, number>();
  const driveUrlMap = new Map<string, string | null>();
  const displayNameMap = new Map<string, string>();
  for (const s of settings as {
    model_folder_name: string;
    threshold: number;
    purchasing_count: number;
    drive_folder_url: string | null;
  }[]) {
    const key = normalizeModelName(s.model_folder_name);
    thresholdMap.set(key, s.threshold);
    purchasingMap.set(key, s.purchasing_count);
    driveUrlMap.set(key, s.drive_folder_url);
    displayNameMap.set(key, s.model_folder_name);
  }
  // しきい値設定がまだ無い機種(Drive上のフォルダのみ存在)は、Drive側の表記をそのまま表示名に使う。
  for (const c of counts as ModelDriveStockCount[]) {
    const key = normalizeModelName(c.model_folder_name);
    if (!displayNameMap.has(key)) displayNameMap.set(key, c.model_folder_name);
  }

  // 在庫数(Drive由来)としきい値設定(手動登録分含む)の両方の機種名を統合する。
  // Driveにまだフォルダが無い機種名でも、しきい値だけ先に設定できるようにするため。
  const allKeys = new Set<string>([...countMap.keys(), ...thresholdMap.keys()]);

  return Array.from(allKeys)
    .map((key) => {
      const count = countMap.get(key);
      const threshold = thresholdMap.get(key) ?? 1;
      const inStockCount = count?.in_stock_count ?? 0;
      const manualDriveUrl = driveUrlMap.get(key);
      const autoDriveUrl = count?.drive_folder_id
        ? `https://drive.google.com/drive/folders/${count.drive_folder_id}`
        : null;
      return {
        model_folder_name: displayNameMap.get(key) ?? key,
        in_stock_count: inStockCount,
        threshold,
        belowThreshold: inStockCount < threshold,
        checked_at: count?.checked_at ?? null,
        purchasing_count: purchasingMap.get(key) ?? 0,
        drive_folder_url: (manualDriveUrl && manualDriveUrl.trim()) ? manualDriveUrl : autoDriveUrl,
      };
    })
    .sort((a, b) => a.model_folder_name.localeCompare(b.model_folder_name));
}

/**
 * しきい値を保存する。
 *
 * 【重要・2026-08-31不具合修正】保存時に last_known_count を必ず null にリセットする。
 * check-stock-alerts のヒステリシス判定(`wasBelow = last_known_count < threshold`)は、
 * "前回チェック時点の在庫数" を "現在の(新しい)しきい値" と比較する実装になっている。
 * そのため、しきい値を引き上げた場合(例: 1→4、在庫数は3のまま変化なし)、
 * 「前回チェック時の在庫数3」が「新しいしきい値4」に対してすでに below と判定されてしまい、
 * 「新たに下回った」扱いにならず、実際にはしきい値越えが発生しているのにメール通知が
 * 送られない不具合があった(ユーザー報告: 「しきい値を1から4に変更して今すぐチェックしたが
 * メールが来ない」)。しきい値を変更した直後は必ず「まだ一度もチェックしていない」状態
 * (last_known_count = null)に戻すことで、次回チェック時に新しいしきい値に対して
 * 正しく再評価されるようにする。
 */
export async function upsertStockThreshold(modelFolderName: string, threshold: number): Promise<void> {
  const { error } = await supabase
    .from("model_stock_alert_settings")
    .upsert(
      { model_folder_name: modelFolderName, threshold, last_known_count: null },
      { onConflict: "model_folder_name" },
    );
  if (error) throw error;
}

/**
 * 仕入中(発注済み・未入荷)の数量を機種名フォルダに紐づけて保存する(2026-09-13追加)。
 * しきい値設定が未登録の機種名でも保存できるよう、model_stock_alert_settingsにupsertする
 * (threshold等の他の列は指定しないため、既存行があれば変更されない。新規行の場合はDBの
 * デフォルト値(threshold=1等)が使われる)。
 */
export async function upsertPurchasingCount(modelFolderName: string, purchasingCount: number): Promise<void> {
  const { error } = await supabase
    .from("model_stock_alert_settings")
    .upsert(
      { model_folder_name: modelFolderName, purchasing_count: purchasingCount },
      { onConflict: "model_folder_name" },
    );
  if (error) throw error;
}

/**
 * 機種名フォルダに対応するGoogle DriveフォルダのURLを保存する(在庫アラート画面、2026-09-15追加)。
 * しきい値設定が未登録の機種名でも保存できるよう、model_stock_alert_settingsにupsertする。
 */
export async function upsertDriveFolderUrl(modelFolderName: string, driveFolderUrl: string): Promise<void> {
  const { error } = await supabase
    .from("model_stock_alert_settings")
    .upsert(
      { model_folder_name: modelFolderName, drive_folder_url: driveFolderUrl || null },
      { onConflict: "model_folder_name" },
    );
  if (error) throw error;
}

/**
 * 機種名フォルダ名自体を変更する(在庫アラート画面、2026-09-15追加)。
 * model_stock_alert_settingsの主キー(model_folder_name)を直接UPDATEするのではなく、
 * 現在表示されているしきい値・仕入中・Driveフォルダ URLを新しい名前でupsertしたうえで
 * 旧い名前の行を削除する(旧名の設定行がまだ無い場合=Drive在庫側にしか存在しない機種の削除は
 * 0件ヒットで無害に終わる)。
 *
 * 【注意】ここで変更されるのはアプリ内の管理名(しきい値・仕入中設定のキー)のみであり、
 * Google Drive上の実フォルダ名は変更しない。在庫数はGoogle Drive側の実フォルダ名と
 * 完全一致した場合のみ連動するため、実フォルダ名も合わせて変更しないと、次回の
 * 「Google Driveから最新の在庫数を取得」時に在庫数が0件表示に戻る可能性がある
 * (新規機種を在庫0件で先に登録できる仕様と同じ挙動)。
 */
export async function renameModelFolder(
  oldName: string,
  newName: string,
  currentThreshold: number,
  currentPurchasingCount: number,
  currentDriveFolderUrl: string | null,
): Promise<void> {
  const { error: upsertError } = await supabase
    .from("model_stock_alert_settings")
    .upsert(
      {
        model_folder_name: newName,
        threshold: currentThreshold,
        purchasing_count: currentPurchasingCount,
        drive_folder_url: currentDriveFolderUrl,
        last_known_count: null,
      },
      { onConflict: "model_folder_name" },
    );
  if (upsertError) throw upsertError;

  if (oldName !== newName) {
    const { error: deleteError } = await supabase
      .from("model_stock_alert_settings")
      .delete()
      .eq("model_folder_name", oldName);
    if (deleteError) throw deleteError;
  }
}

/**
 * 機種名フォルダのしきい値・仕入中設定を削除する(在庫アラート一覧の「削除」ボタン、2026-09-13追加)。
 * model_drive_stock_countsのキャッシュ行はGoogle Drive側の実フォルダ構造から次回同期時に
 * 再生成されるため削除しない(在庫が実在する限り一覧には再度表示される。しきい値・仕入中設定だけを消す)。
 */
export async function deleteStockThreshold(modelFolderName: string): Promise<void> {
  const { error } = await supabase
    .from("model_stock_alert_settings")
    .delete()
    .eq("model_folder_name", modelFolderName);
  if (error) throw error;
}

/**
 * Google Drive上の実フォルダ構造をスキャンし、機種名フォルダごとの在庫数を
 * model_drive_stock_counts に再取得・保存する(sync-drive-stock-counts Edge Functionを呼び出す)。
 * 在庫アラート画面の「Google Driveから最新の在庫数を取得」ボタンから呼ばれる想定(2026-08-31追加)。
 */
export async function syncDriveStockCounts(): Promise<{ synced: number; checked_at: string }> {
  const { data, error } = await supabase.functions.invoke("sync-drive-stock-counts");
  if (error) throw error;
  return data as { synced: number; checked_at: string };
}

/** Edge Functionを呼び出し、しきい値を下回っているモデルがあればGmail経由でメール通知する */
export async function checkStockAlertsAndNotify(): Promise<{ notified: string[] } | null> {
  const { data, error } = await supabase.functions.invoke("check-stock-alerts");
  if (error) throw error;
  return data as { notified: string[] };
}
