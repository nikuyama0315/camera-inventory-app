export const SOURCE_TYPE_OPTIONS = [
  { value: "yahoo_auction", label: "ヤフオク" },
  { value: "mercari", label: "メルカリ" },
  { value: "yahoo_furima", label: "ヤフーフリマ" },
  { value: "rakuma", label: "ラクマ" },
  { value: "store", label: "実店舗" },
  { value: "other", label: "その他" },
];

export const USED_GOODS_OPTIONS = [
  { value: "true", label: "古物" },
  { value: "false", label: "新品" },
];

export const DRIVE_BASE_PATH =
  "G:\\マイドライブ\\@個人事業\\@カメラ出品データ\\@撮影済み・出品待ち\\";

// 2026-09-05追加(バグ修正): 上記DRIVE_BASE_PATHは「検品済・出品待ち」ステージ専用のローカルパスであり、
// 商品のステータスが進んで「出品中」「販売済み」ステージへ移動すると、move-drive-folder Edge Functionに
// よりGoogle Drive上の実フォルダは別の場所へ物理的に移動される(ユーザー報告「フォルダを開くを押すと
// ドキュメントフォルダが開かれてしまう」の原因調査で判明)。しかし従来のコードはステータスに関わらず
// 常にこのDRIVE_BASE_PATH(検品済・出品待ちステージ)を使ってローカルパスを組み立てていたため、
// 出品中・販売済みの商品では実在しないパスが生成され、Windowsのエクスプローラーがそれを解決できず
// 既定のフォルダ(ドキュメント)にフォールバックしていた。
// 実際のGoogle Driveフォルダ構成(Drive APIで実データを確認済み)は以下の通り:
//   @カメラ出品データ (=drive_folder_config の"listed"ルート。出品中の商品はこの直下にフラット配置)
//   ├─ @撮影済み・出品待ち (=DRIVE_BASE_PATH。検品済・出品待ちステージ、機種名フォルダを介して配置)
//   └─ ＠SOLD (=drive_folder_config の"sold"ルート。販売済みの商品はこの直下にフラット配置)
export const DRIVE_BASE_PATH_LISTED = "G:\\マイドライブ\\@個人事業\\@カメラ出品データ\\";
export const DRIVE_BASE_PATH_SOLD = "G:\\マイドライブ\\@個人事業\\@カメラ出品データ\\＠SOLD\\";

/**
 * 商品のGoogle Drive上のステージ(item_drive_folders.current_stage)・機種名フォルダ名・商品フォルダ名から、
 * 現在実際にファイルが存在するはずのローカルWindowsパスを組み立てる。
 * ステージごとにフォルダ構成が異なる(出品中・販売済みは機種名フォルダを介さないフラット配置)ため、
 * item_drive_folders.model_folder_name(過去にステージ移動した際に更新されず古い値のまま残ることがある)を
 * 無条件には使わず、現在のステージに応じて必要な場合のみ使用する。
 * 戻り値がnullの場合、フォルダの場所を特定できない(情報不足)ことを示す。
 */
export function computeDriveLocalPath(
  currentStage: string | null,
  modelFolderName: string | null,
  itemFolderName: string | null,
): string | null {
  if (!itemFolderName) return null;
  if (currentStage === "listed") {
    return `${DRIVE_BASE_PATH_LISTED}${itemFolderName}\\`;
  }
  if (currentStage === "sold") {
    return `${DRIVE_BASE_PATH_SOLD}${itemFolderName}\\`;
  }
  // "awaiting_listing"、またはcurrent_stage未設定(旧データ等)の場合は従来通り機種名フォルダ配下とみなす
  if (!modelFolderName) return null;
  return `${DRIVE_BASE_PATH}${modelFolderName}\\${itemFolderName}\\`;
}

// 直販プラットフォーム出品用のカテゴリ(items.platform_category)。既存のitems.category(業務分類、
// カメラ関連品/雑貨/衣類)とは別物。2026-09-01追加。
export const PLATFORM_CATEGORY_OPTIONS = [
  { value: "film_camera", label: "film_camera(フィルムカメラ)" },
  { value: "digital_camera", label: "digital_camera(デジタルカメラ)" },
  { value: "lens", label: "lens(レンズ)" },
  { value: "accessory", label: "accessory(アクセサリー)" },
];

// 直販プラットフォーム出品用のグレード(items.grade)。inspections.condition_gradeとは別物。2026-09-01追加。
export const GRADE_OPTIONS = [
  { value: "top_mint", label: "top_mint" },
  { value: "mint", label: "mint" },
  { value: "near_mint", label: "near_mint" },
  { value: "excellent", label: "excellent" },
  { value: "very_good", label: "very_good" },
  { value: "as-is", label: "as-is" },
  { value: "for_parts", label: "for_parts" },
  { value: "junk", label: "junk" },
];
