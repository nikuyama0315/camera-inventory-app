import { supabase } from "../supabaseClient";

export interface ItemDriveFolder {
  id: string;
  item_id: string;
  drive_folder_path: string;
  model_folder_name: string | null;
  item_folder_name: string | null;
  drive_folder_id: string | null;
  current_stage: string | null;
  registered_at: string;
}

export interface CreateItemDriveFolderInput {
  item_id: string;
  drive_folder_path: string;
  model_folder_name?: string;
  item_folder_name?: string;
  drive_folder_url?: string; // Google Driveの実際のフォルダURL(自動移動に必要)
}

/**
 * Google DriveのフォルダURLからフォルダIDを抽出する。
 * 対応例:
 *   https://drive.google.com/drive/folders/XXXXXXXXXXXXXXXXXXXX
 *   https://drive.google.com/drive/u/0/folders/XXXXXXXXXXXXXXXXXXXX?usp=sharing
 */
export function extractDriveFolderId(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/folders\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  // URLでなくID自体が貼られた場合(英数字・ハイフン・アンダースコアのみ)もそのまま受け付ける
  if (/^[a-zA-Z0-9_-]{10,}$/.test(trimmed)) return trimmed;
  return null;
}

/** 新規登録時に、画像保管フォルダの情報を登録する */
export async function createItemDriveFolder(input: CreateItemDriveFolderInput): Promise<ItemDriveFolder> {
  const driveFolderId = input.drive_folder_url ? extractDriveFolderId(input.drive_folder_url) : null;

  const { data, error } = await supabase
    .from("item_drive_folders")
    .insert({
      item_id: input.item_id,
      drive_folder_path: input.drive_folder_path,
      model_folder_name: input.model_folder_name ?? null,
      item_folder_name: input.item_folder_name ?? null,
      drive_folder_id: driveFolderId,
      current_stage: driveFolderId ? "awaiting_listing" : null,
    })
    .select()
    .single();

  if (error) throw error;
  return data as ItemDriveFolder;
}

export async function updateItemDriveFolder(
  itemId: string,
  patch: Partial<Pick<ItemDriveFolder, "drive_folder_path" | "model_folder_name" | "item_folder_name" | "drive_folder_id">>,
): Promise<ItemDriveFolder> {
  const { data, error } = await supabase
    .from("item_drive_folders")
    .update(patch)
    .eq("item_id", itemId)
    .select()
    .single();

  if (error) throw error;
  return data as ItemDriveFolder;
}

export interface DriveFolderInfo {
  item_folder_name: string;
  model_folder_name: string | null;
  /** 2026-09-05追加: 親フォルダがdrive_folder_config(検品済・出品待ち/出品中/売却済みのステージ管理用
   *  ルートフォルダ)自体と一致していたため、機種名フォルダとしては採用しなかった場合の理由文言。
   *  この場合model_folder_nameは常にnull(例: 出品中でフラット配置のためそもそも機種名フォルダが無い)。 */
  model_folder_skipped_reason: string | null;
}

/**
 * 2026-09-05追加: Google DriveフォルダのURL(または直接ID)から、実際のDrive API上のフォルダ名
 * (=商品フォルダ名)と、その親フォルダ名(=機種名フォルダ名)を取得する(Edge Function `drive-folder-info`
 * 経由。既存の`move-drive-folder`と同じサービスアカウント認証を再利用している)。DBへの保存は行わず、
 * 取得結果を返すのみ(呼び出し側でフォームへの反映・保存を行う想定)。
 * 2026-09-05バグ修正: 親フォルダがステージ管理用ルートフォルダ自体(出品中のフラット配置フォルダ等)と
 * 一致する場合は、機種名フォルダとして扱わずnullを返すようEdge Function側で修正済み(詳細は
 * `model_folder_skipped_reason`、または`claude/system-info.md`のlast_updated参照)。
 */
export async function fetchDriveFolderInfo(driveFolderUrl: string): Promise<DriveFolderInfo> {
  const { data, error } = await supabase.functions.invoke("drive-folder-info", {
    body: { folder_url: driveFolderUrl },
  });
  if (error) throw error;
  if (!data || typeof data !== "object" || "error" in data) {
    throw new Error((data as { error?: string })?.error ?? "Google Driveフォルダ情報の取得に失敗しました");
  }
  return {
    item_folder_name: (data as { item_folder_name: string }).item_folder_name,
    model_folder_name: (data as { model_folder_name: string | null }).model_folder_name,
    model_folder_skipped_reason:
      (data as { model_folder_skipped_reason?: string | null }).model_folder_skipped_reason ?? null,
  };
}

/** 既存レコードがあれば更新、なければ新規作成する(基本情報タブでの編集用) */
export async function upsertItemDriveFolder(input: CreateItemDriveFolderInput): Promise<ItemDriveFolder> {
  const driveFolderId = input.drive_folder_url ? extractDriveFolderId(input.drive_folder_url) : undefined;

  const { data: existing, error: fetchError } = await supabase
    .from("item_drive_folders")
    .select("id")
    .eq("item_id", input.item_id)
    .maybeSingle();

  if (fetchError) throw fetchError;

  if (existing) {
    return updateItemDriveFolder(input.item_id, {
      drive_folder_path: input.drive_folder_path,
      model_folder_name: input.model_folder_name ?? null,
      item_folder_name: input.item_folder_name ?? null,
      ...(driveFolderId !== undefined ? { drive_folder_id: driveFolderId } : {}),
    });
  }
  return createItemDriveFolder(input);
}
