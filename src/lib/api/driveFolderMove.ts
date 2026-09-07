import { supabase } from "../supabaseClient";

/**
 * ステータス変更後に、Google Driveフォルダの自動移動をトリガーする。
 * 移動処理自体の失敗(Google Drive未連携・フォルダ未登録等)でメインの操作(ステータス変更等)を
 * 失敗させたくないため、エラーは呼び出し側に投げずコンソールへの記録のみ行う。
 */
export async function triggerDriveFolderMove(itemId: string): Promise<void> {
  try {
    const { data, error } = await supabase.functions.invoke("move-drive-folder", {
      body: { item_id: itemId },
    });
    if (error) {
      // eslint-disable-next-line no-console
      console.warn("Google Driveフォルダの自動移動に失敗しました:", error);
      return;
    }
    // eslint-disable-next-line no-console
    console.info("Google Driveフォルダ移動チェック結果:", data);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("Google Driveフォルダの自動移動でエラーが発生しました:", err);
  }
}
