import { ITEM_STATUS_LABELS, EBAY_ACCOUNT_LABELS, EBAY_ACCOUNT_OPTIONS } from "../../../lib/types";
import type { ItemDetail, ItemStatus, EbayAccount } from "../../../lib/types";
import { markItemArrived, updateItemBasicInfo, fetchDistinctBrandsAndModels } from "../../../lib/api/items";
import { updatePurchase } from "../../../lib/api/purchases";
import { updateSale } from "../../../lib/api/sales";
import { upsertItemDriveFolder, fetchDriveFolderInfo } from "../../../lib/api/driveFolders";
import {
  SOURCE_TYPE_OPTIONS,
  USED_GOODS_OPTIONS,
  DRIVE_BASE_PATH,
  PLATFORM_CATEGORY_OPTIONS,
  GRADE_OPTIONS,
  computeDriveLocalPath,
} from "../../../lib/constants";
import { COUNTERPARTY_TYPE_OPTIONS, type CounterpartyType } from "../../../lib/taxDeduction";
import DeductionBadge from "../../shared/DeductionBadge";
import { pickFolderNameViaDirectoryPicker } from "../../../lib/folderPicker";
import { triggerDriveFolderMove } from "../../../lib/api/driveFolderMove";
import { useEffect, useRef, useState } from "react";

interface Props {
  item: ItemDetail;
  onChanged: () => void;
  /** 2026-09-10追加: 「編集」ボタンをItemDetailPane上部(「複写して新規作成」の左)へ移設した
   *  ことに伴う連携用props。親側がこの値をインクリメントするたびstartEditing()を実行する。 */
  editTrigger?: number;
  /** 編集モードのon/offを親(ItemDetailPane)へ通知する。親側で上部「編集」ボタンの表示/非表示に使う。 */
  onEditingChange?: (editing: boolean) => void;
}

const ROW_STYLE: React.CSSProperties = { display: "flex", gap: 12, marginBottom: 8, fontSize: 13 };
const LABEL_STYLE: React.CSSProperties = { color: "var(--text-secondary)", width: 140, flexShrink: 0 };
/** 2026-09-22追加(ユーザー指示): 特定項目のラベルを赤太字で強調表示する。 */
const HIGHLIGHT_LABEL_STYLE: React.CSSProperties = { ...LABEL_STYLE, color: "var(--danger-text)", fontWeight: 700 };

/** ITEM TITLE(items.item_title)の文字数上限(半角換算)。eBay出品タイトルの実仕様(80文字)に合わせる。 */
const HALF_WIDTH_TITLE_MAX_LENGTH = 80;

/** 半角換算の文字数を数える(コードポイントが256以上の全角文字は2、それ以外の半角文字は1としてカウントする一般的な方式)。 */
function halfWidthLength(value: string): number {
  let length = 0;
  for (const ch of value) {
    length += (ch.codePointAt(0) ?? 0) > 255 ? 2 : 1;
  }
  return length;
}

/** 半角換算でHALF_WIDTH_TITLE_MAX_LENGTHを超える入力は、超えない範囲まで切り詰める。 */
function truncateToHalfWidthLimit(value: string, maxLength: number): string {
  if (halfWidthLength(value) <= maxLength) return value;
  let result = "";
  let length = 0;
  for (const ch of value) {
    const chLength = (ch.codePointAt(0) ?? 0) > 255 ? 2 : 1;
    if (length + chLength > maxLength) break;
    result += ch;
    length += chLength;
  }
  return result;
}

/** 2026-09-08変更: ステータス進行ボタンを「検品」タブに一本化し、このタブの汎用ボタンは
 *  「入荷待ち→着荷・検品待ち」の1段階のみに絞った(検品完了・出品待ち以降の各遷移は検品タブの
 *  専用ボタン群を参照)。定義の無いステータスではボタン自体を表示しない(handleAdvanceStatus参照)。 */
const ADVANCE_STEPS: Partial<Record<ItemStatus, { next: ItemStatus; actionLabel: string; run: (itemId: string) => Promise<void> }>> = {
  awaiting_arrival: { next: "awaiting_inspection", actionLabel: "着荷・検品待ちにする", run: markItemArrived },
};

interface EditForm {
  // 基本情報
  management_no: string;
  /** 「仕入・販売帳」エクセルのSales #列。sales.sales_record_referenceに保存される(management_noとは別物)。
   *  該当する売上(sales)が1件のときのみ編集可能(0件・複数件の場合は編集対象を一意に決められないため読み取り専用)。 */
  sales_record_reference: string;
  /** 2026-09-10追加(ユーザー指示): 「ITEM TITLE」(sales.sale_item_title)。sales_record_referenceと
   *  同様、該当する売上が1件のときのみ編集可能。 */
  sale_item_title: string;
  /** 2026-09-10追加(ユーザー指示): 「販売プラットフォーム」(sales.sales_platform、メルカリ・
   *  ヤフーフリマ等)。sales_record_referenceと同様、該当する売上が1件のときのみ編集可能。 */
  sales_platform: string;
  title: string;
  /** 2026-09-21追加(ユーザー指示): eBay等の出品タイトル(ITEM TITLE)。items.item_titleに保存する
   *  商品単位のフィールドで、sale_item_title(売上単位・売上1件時のみ編集可)とは異なり、
   *  未販売の商品でも常に編集・登録できる。半角換算80文字まで(HALF_WIDTH_TITLE_MAX_LENGTH参照)。 */
  item_title: string;
  category: string;
  brand: string;
  model: string;
  type: string;
  serial_number: string;
  lens_serial_number: string;
  status: ItemStatus;
  /** eBayアカウント区分(soulcamera/soulmenjapan/other)。空文字列は未設定を表す。2026-09-03追加。 */
  account: string;
  // 直販プラットフォーム出品用(2026-09-01追加)
  platform_category: string;
  grade: string;
  accessories_included: string;
  // 仕入情報
  purchase_date: string;
  source_type: string;
  source_name: string;
  source_url: string;
  purchase_price: string;
  quantity: string;
  is_used_goods: string; // "true" | "false"
  counterparty_type: CounterpartyType;
  // 画像保管フォルダ
  model_folder_name: string;
  item_folder_name: string;
  drive_folder_url: string;
}

export default function BasicInfoTab({ item, onChanged, editTrigger, onEditingChange }: Props) {
  // ブランド・機種名の入力候補(datalist、2026-09-15追加)。登録済み商品から一覧を1回だけ取得し、
  // 既存候補から選択しつつ自由入力(新規登録)も可能にする(input list=属性によるネイティブcombobox)。
  const [brandOptions, setBrandOptions] = useState<string[]>([]);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [typeOptions, setTypeOptions] = useState<string[]>([]);
  /** ITEM TITLEの入力候補(datalist、2026-09-23追加)。 */
  const [itemTitleOptions, setItemTitleOptions] = useState<string[]>([]);
  useEffect(() => {
    fetchDistinctBrandsAndModels()
      .then((opts) => {
        setBrandOptions(opts.brands);
        setModelOptions(opts.models);
        setTypeOptions(opts.types);
        setItemTitleOptions(opts.itemTitles);
      })
      .catch(() => {
        /* 候補取得の失敗は致命的でないため無視(自由入力は引き続き可能) */
      });
  }, []);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  /** 2026-09-05追加: 「Driveから取得」ボタン(機種名フォルダ・商品フォルダをGoogle Drive APIから自動取得)用。 */
  const [fetchingDriveInfo, setFetchingDriveInfo] = useState(false);
  /** 2026-09-05追加: 親フォルダがステージ管理用ルートフォルダ自体で、機種名フォルダを検出できなかった
   *  場合の案内メッセージ(エラーではないため`editError`とは別に保持し、注意書きとして表示する)。 */
  const [driveInfoNote, setDriveInfoNote] = useState<string | null>(null);

  const modelFolderPickerInputRef = useRef<HTMLInputElement>(null);
  const itemFolderPickerInputRef = useRef<HTMLInputElement>(null);

  const purchase = item.purchases?.[0];
  const driveFolder = item.item_drive_folders?.[0];

  /** eBayのOrder番号(ebay_transaction_lines.order_number、sales経由の読み取り専用表示。2026-09-03追加)。
   *  紐づく売上が複数あり異なるOrder番号を持つ場合は「、」区切りで並べて表示する。 */
  const orderNumbers = Array.from(
    new Set((item.sales ?? []).map((s) => s.ebay_transaction_lines?.order_number).filter((v): v is string => Boolean(v))),
  );
  const orderNumberDisplay = orderNumbers.length > 0 ? orderNumbers.join("、") : "-";

  const computedDrivePath =
    editForm && editForm.model_folder_name.trim() && editForm.item_folder_name.trim()
      ? `${DRIVE_BASE_PATH}${editForm.model_folder_name.trim()}\\${editForm.item_folder_name.trim()}\\`
      : "";

  /** 2026-09-05バグ修正(ユーザー報告「260727-04 画像保管フォルダが表示されていない」):
   *  出品中(listed)・販売済み(sold)ステージの商品は機種名フォルダを介さないフラット配置のため、
   *  model_folder_nameが意図的にnullのまま(2026-09-05の「Driveから取得」バグ修正参照)になる。
   *  しかしこの理由の説明(driveInfoNote)は「Driveから取得」ボタンを押した直後にしか表示されず、
   *  編集モーダルを開いただけの状態では機種名フォルダが何の説明も無く空欄に見え、
   *  「データが消えた/保存されていない」ように誤解されてしまっていた。編集フォームを開いた時点の
   *  driveFolder.current_stageから常時判定し、該当する場合は理由を常に表示するようにする。 */
  const noModelFolderExpected =
    !!driveFolder &&
    !driveFolder.model_folder_name &&
    !!driveFolder.item_folder_name &&
    (driveFolder.current_stage === "listed" || driveFolder.current_stage === "sold");
  const stageLabelForNote =
    driveFolder?.current_stage === "sold" ? "販売済み(＠SOLD配下)" : "出品中(@カメラ出品データ直下)";

  /** 2026-09-05バグ修正(ユーザー指摘): 旧「到着済みにする」ボタンは、ステータスが「入荷待ち」以外
   *  のときも(ラベル表示だけ現在のステータス名に切り替えつつ)常にmark_item_arrivedを実行しており、
   *  検品済・出品待ち以降の商品で押すと「着荷・検品待ち」まで巻き戻ってしまう不具合があった。
   *  「現在のステータスの次の段階へ進める」汎用ボタンに変更し、常に前進(または操作不可)のみを
   *  行うようにした。sold・返品系ステータス等、次の段階が定義されていない場合はボタンを無効化する。 */
  const advanceStep = ADVANCE_STEPS[item.status];

  async function handleAdvanceStatus() {
    if (!advanceStep) return;
    setBusy(true);
    setErrorMessage(null);
    try {
      await advanceStep.run(item.id);
      await triggerDriveFolderMove(item.id);
      onChanged();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "更新に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  // 親(ItemDetailPane)上部の「編集」ボタンから、editTriggerの増加をトリガーに編集モードへ入る。
  useEffect(() => {
    if (editTrigger) startEditing();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editTrigger]);

  // 編集モードのon/offを親へ通知(上部「編集」ボタンの表示/非表示に使う)。
  useEffect(() => {
    onEditingChange?.(editing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  function startEditing() {
    setEditForm({
      management_no: item.management_no,
      sales_record_reference: item.sales?.length === 1 ? item.sales[0].sales_record_reference ?? "" : "",
      sale_item_title: item.sales?.length === 1 ? item.sales[0].sale_item_title ?? "" : "",
      sales_platform: item.sales?.length === 1 ? item.sales[0].sales_platform ?? "" : "",
      title: item.title ?? "",
      item_title: item.item_title ?? "",
      category: item.category,
      brand: item.brand ?? "",
      model: item.model ?? "",
      type: item.type ?? "",
      serial_number: item.serial_number ?? "",
      lens_serial_number: item.lens_serial_number ?? "",
      status: item.status,
      account: item.account ?? "",
      platform_category: item.platform_category ?? "",
      grade: item.grade ?? "",
      accessories_included: item.accessories_included ?? "",
      purchase_date: purchase?.purchase_date ?? new Date().toISOString().slice(0, 10),
      source_type: purchase?.source_type ?? SOURCE_TYPE_OPTIONS[0].value,
      source_name: purchase?.source_name ?? "",
      source_url: purchase?.source_url ?? "",
      purchase_price: purchase ? String(purchase.purchase_price) : "",
      quantity: purchase ? String(purchase.quantity) : "1",
      is_used_goods: purchase ? String(purchase.is_used_goods) : "true",
      counterparty_type: purchase?.counterparty_type ?? "consumer",
      model_folder_name: driveFolder?.model_folder_name ?? "",
      item_folder_name: driveFolder?.item_folder_name ?? "",
      drive_folder_url: driveFolder?.drive_folder_id
        ? `https://drive.google.com/drive/folders/${driveFolder.drive_folder_id}`
        : "",
    });
    setEditError(null);
    setEditing(true);
  }

  function updateEdit<K extends keyof EditForm>(key: K, value: EditForm[K]) {
    setEditForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function pickedFolderName(e: React.ChangeEvent<HTMLInputElement>): string | null {
    const files = e.target.files;
    if (!files || files.length === 0) return null;
    const relPath = (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath;
    const folderName = relPath ? relPath.split("/")[0] : files[0].name;
    e.target.value = "";
    return folderName;
  }

  function handleModelFolderPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const folderName = pickedFolderName(e);
    if (folderName) updateEdit("model_folder_name", folderName);
  }

  function handleItemFolderPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const folderName = pickedFolderName(e);
    if (folderName) updateEdit("item_folder_name", folderName);
  }

  async function handlePickModelFolder() {
    const name = await pickFolderNameViaDirectoryPicker();
    if (name) {
      updateEdit("model_folder_name", name);
    } else if (!("showDirectoryPicker" in window)) {
      modelFolderPickerInputRef.current?.click();
    }
  }

  async function handlePickItemFolder() {
    const name = await pickFolderNameViaDirectoryPicker();
    if (name) {
      updateEdit("item_folder_name", name);
    } else if (!("showDirectoryPicker" in window)) {
      itemFolderPickerInputRef.current?.click();
    }
  }

  /** 2026-09-05追加: ユーザー要望「登録されたGoogle DriveフォルダのURLを使って機種名フォルダと
   *  商品フォルダを取得し保存することはできますか」に対応。入力済みのGoogle DriveフォルダURLから、
   *  Drive API(Edge Function `drive-folder-info`、既存のmove-drive-folderと同じサービスアカウントを
   *  再利用)経由で実際のフォルダ名(=商品フォルダ)と親フォルダ名(=機種名フォルダ)を取得し、
   *  フォームに反映する。ユーザー指示によりステータスを問わず全商品で使用可能、かつ既存の入力値が
   *  あっても常にDriveの値で上書きする(保存自体は別途「保存」ボタンを押すまで確定しない)。 */
  async function handleFetchDriveInfo() {
    if (!editForm) return;
    const url = editForm.drive_folder_url.trim();
    if (!url) {
      setEditError("Google DriveフォルダのURLを入力してください");
      return;
    }
    setFetchingDriveInfo(true);
    setEditError(null);
    setDriveInfoNote(null);
    try {
      const info = await fetchDriveFolderInfo(url);
      updateEdit("model_folder_name", info.model_folder_name ?? "");
      updateEdit("item_folder_name", info.item_folder_name ?? "");
      // 2026-09-05バグ修正: 出品中(フラット配置)等、機種名フォルダが存在しないケースでは
      // model_folder_nameが意図的にnullで返る(Edge Function側で判定済み)。この場合エラーではなく
      // 案内メッセージとして理由を表示する(ユーザー指摘「@カメラ出品データは不要」への対応)。
      if (info.model_folder_skipped_reason) {
        setDriveInfoNote(info.model_folder_skipped_reason);
      }
    } catch (err) {
      setEditError(
        err instanceof Error ? `Google Driveフォルダ情報の取得に失敗しました: ${err.message}` : "Google Driveフォルダ情報の取得に失敗しました",
      );
    } finally {
      setFetchingDriveInfo(false);
    }
  }

  async function handleSaveEdit() {
    if (!editForm) return;
    if (!editForm.management_no.trim() || !editForm.category.trim()) {
      setEditError("管理番号・カテゴリは必須です");
      return;
    }
    setEditBusy(true);
    setEditError(null);
    try {
      await updateItemBasicInfo(item.id, {
        management_no: editForm.management_no.trim(),
        title: editForm.title || null,
        item_title: editForm.item_title.trim() || null,
        category: editForm.category,
        brand: editForm.brand || null,
        model: editForm.model || null,
        type: editForm.type || null,
        serial_number: editForm.serial_number || null,
        lens_serial_number: editForm.lens_serial_number || null,
        status: editForm.status,
        account: editForm.account || null,
        platform_category: editForm.platform_category || null,
        grade: editForm.grade || null,
        accessories_included: editForm.accessories_included || null,
      });

      if (item.sales && item.sales.length === 1) {
        await updateSale(item.sales[0].id, {
          sales_record_reference: editForm.sales_record_reference.trim() || null,
          sale_item_title: editForm.sale_item_title.trim() || null,
          sales_platform: editForm.sales_platform.trim() || null,
          // 2026-09-15追加(ユーザー報告「仕入高を修正したが粗利に反映されない」): 販売済み商品の
          // 仕入高(purchases.purchase_price)を基本情報タブから修正した場合、既存売上の
          // purchase_price_snapshot(粗利=gross_profit_jpyの元になる生成列の入力値)も
          // 合わせて更新し、粗利が再計算されるようにする。
          ...(purchase ? { purchase_price_snapshot: Number(editForm.purchase_price) || 0 } : {}),
        });
      }

      if (purchase) {
        await updatePurchase(purchase.id, {
          purchase_date: editForm.purchase_date,
          source_type: editForm.source_type,
          source_name: editForm.source_name || null,
          source_url: editForm.source_url || null,
          purchase_price: Number(editForm.purchase_price) || 0,
          quantity: Number(editForm.quantity) || 1,
          is_used_goods: editForm.is_used_goods === "true",
          counterparty_type: editForm.counterparty_type,
        });
      }

      // 2026-09-04バグ修正: 従来は「機種名フォルダ」「商品フォルダ」の両方が入力されている場合のみ
      // upsertItemDriveFolderを呼んでおり、Google DriveフォルダのURLだけを入力して保存しても
      // (フォルダ名2項目が空のままだと)この呼び出し自体がスキップされ、URLが一切保存されない不具合が
      // あった(ユーザー報告「詳細編集でGoogle DriveフォルダのURLを入力保存しても...表示されません」)。
      // 3項目(機種名フォルダ・商品フォルダ・Google DriveフォルダのURL)のいずれか1つでも入力されていれば
      // upsertを実行するよう変更。空文字列は`|| undefined`でundefinedに正規化し、DB側でnullとして
      // 保存されるようにした(以前は空文字列がそのまま保存されるケースがあった)。
      const hasAnyDriveFolderInput =
        editForm.model_folder_name.trim() !== "" ||
        editForm.item_folder_name.trim() !== "" ||
        editForm.drive_folder_url.trim() !== "";

      if (hasAnyDriveFolderInput) {
        await upsertItemDriveFolder({
          item_id: item.id,
          drive_folder_path: computedDrivePath,
          model_folder_name: editForm.model_folder_name.trim() || undefined,
          item_folder_name: editForm.item_folder_name.trim() || undefined,
          drive_folder_url: editForm.drive_folder_url.trim() || undefined,
        });
      }

      await triggerDriveFolderMove(item.id);
      setEditing(false);
      onChanged();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "更新に失敗しました(管理番号が重複していないか確認してください)");
    } finally {
      setEditBusy(false);
    }
  }

  if (editing && editForm) {
    return (
      <div>
        <EditField label="アカウント">
          <select
            value={editForm.account}
            onChange={(e) => updateEdit("account", e.target.value)}
            style={{ width: "100%" }}
          >
            <option value="">未設定</option>
            {EBAY_ACCOUNT_OPTIONS.map((a) => (
              <option key={a} value={a}>
                {EBAY_ACCOUNT_LABELS[a]}
              </option>
            ))}
          </select>
        </EditField>
        <EditField label="カテゴリ">
          <input
            type="text"
            value={editForm.category}
            onChange={(e) => updateEdit("category", e.target.value)}
            style={{ width: "100%" }}
          />
        </EditField>
        <EditField label="管理番号" highlight>
          <input
            type="text"
            value={editForm.management_no}
            onChange={(e) => updateEdit("management_no", e.target.value)}
            style={{ width: "100%" }}
          />
        </EditField>
        <EditField label="Sales #">
          {item.sales && item.sales.length === 1 ? (
            <input
              type="text"
              value={editForm.sales_record_reference}
              onChange={(e) => updateEdit("sales_record_reference", e.target.value)}
              style={{ width: "100%" }}
            />
          ) : (
            <>
              <input
                type="text"
                value={
                  item.sales && item.sales.length > 1
                    ? item.sales.map((s) => s.sales_record_reference).filter(Boolean).join("、")
                    : ""
                }
                disabled
                style={{ width: "100%" }}
              />
              <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "2px 0 0" }}>
                {item.sales && item.sales.length > 1
                  ? "この商品には売上が複数件あるため、ここでは編集できません(売上・粗利タブの売上一覧から個別に編集してください)"
                  : "売上データが未登録のため編集できません(売上登録後に編集できます)"}
              </p>
            </>
          )}
        </EditField>
        <EditField label="販売プラットフォーム">
          {item.sales && item.sales.length === 1 ? (
            <input
              type="text"
              value={editForm.sales_platform}
              onChange={(e) => updateEdit("sales_platform", e.target.value)}
              style={{ width: "100%" }}
            />
          ) : (
            <>
              <input
                type="text"
                value={
                  item.sales && item.sales.length > 1
                    ? item.sales.map((s) => s.sales_platform).filter(Boolean).join("、")
                    : ""
                }
                disabled
                style={{ width: "100%" }}
              />
              <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "2px 0 0" }}>
                {item.sales && item.sales.length > 1
                  ? "この商品には売上が複数件あるため、ここでは編集できません(売上・粗利タブの売上一覧から個別に編集してください)"
                  : "売上データが未登録のため編集できません(売上登録後に編集できます)"}
              </p>
            </>
          )}
        </EditField>
        <EditField label="Order番号">
          <span>{orderNumberDisplay}</span>
          <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "2px 0 0" }}>
            eBayの実注文番号(レポート取込・eBay受注同期で取り込まれた値)を自動表示します。ここでは編集できません。
          </p>
        </EditField>
        <EditField label="仕入品名">
          <input
            type="text"
            value={editForm.title}
            onChange={(e) => updateEdit("title", e.target.value)}
            style={{ width: "100%" }}
          />
        </EditField>
        <EditField label="ITEM TITLE" highlight>
          <input
            type="text"
            list="item-title-options"
            value={editForm.item_title}
            onChange={(e) => updateEdit("item_title", truncateToHalfWidthLimit(e.target.value, HALF_WIDTH_TITLE_MAX_LENGTH))}
            style={{ width: "100%" }}
          />
          <datalist id="item-title-options">
            {itemTitleOptions.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
          <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "2px 0 0" }}>
            {halfWidthLength(editForm.item_title)} / {HALF_WIDTH_TITLE_MAX_LENGTH}(半角換算。全角文字は2文字分としてカウントします)
          </p>
        </EditField>
        <EditField label="仕入日">
          <input
            type="date"
            value={editForm.purchase_date}
            onChange={(e) => updateEdit("purchase_date", e.target.value)}
            style={{ width: "100%" }}
          />
        </EditField>
        <EditField label="仕入先種別">
          <select
            value={editForm.source_type}
            onChange={(e) => updateEdit("source_type", e.target.value)}
            style={{ width: "100%" }}
          >
            {SOURCE_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </EditField>
        <EditField label="仕入先・出品者名">
          <input
            type="text"
            value={editForm.source_name}
            onChange={(e) => updateEdit("source_name", e.target.value)}
            style={{ width: "100%" }}
          />
        </EditField>
        <EditField label="購入元URL">
          <input
            type="text"
            value={editForm.source_url}
            onChange={(e) => updateEdit("source_url", e.target.value)}
            style={{ width: "100%" }}
          />
        </EditField>
        <EditField label="仕入高(円)">
          <input
            type="number"
            value={editForm.purchase_price}
            onChange={(e) => updateEdit("purchase_price", e.target.value)}
            style={{ width: "100%" }}
          />
        </EditField>
        <EditField label="数量">
          <input
            type="number"
            value={editForm.quantity}
            onChange={(e) => updateEdit("quantity", e.target.value)}
            style={{ width: "100%" }}
          />
        </EditField>

        <EditField label="新古判定" highlight>
          <select
            value={editForm.is_used_goods}
            onChange={(e) => updateEdit("is_used_goods", e.target.value)}
            style={{ width: "100%" }}
          >
            {USED_GOODS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </EditField>
        <EditField label="取引先区分">
          <select
            value={editForm.counterparty_type}
            onChange={(e) => updateEdit("counterparty_type", e.target.value as CounterpartyType)}
            style={{ width: "100%" }}
          >
            {COUNTERPARTY_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </EditField>
        <DeductionBadge counterpartyType={editForm.counterparty_type} />
        <EditField label="ブランド" highlight>
          <input
            type="text"
            list="brand-options"
            value={editForm.brand}
            onChange={(e) => updateEdit("brand", e.target.value)}
            style={{ width: "100%" }}
          />
          <datalist id="brand-options">
            {brandOptions.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
        </EditField>
        <EditField label="機種名" highlight>
          <input
            type="text"
            list="model-options"
            value={editForm.model}
            onChange={(e) => updateEdit("model", e.target.value)}
            style={{ width: "100%" }}
          />
          <datalist id="model-options">
            {modelOptions.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </EditField>
        <EditField label="タイプ" highlight>
          <input
            type="text"
            list="type-options"
            value={editForm.type}
            onChange={(e) => updateEdit("type", e.target.value)}
            style={{ width: "100%" }}
          />
          <datalist id="type-options">
            {typeOptions.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </EditField>
        <EditField label="シリアル番号(ボディー)" highlight>
          <input
            type="text"
            value={editForm.serial_number}
            onChange={(e) => updateEdit("serial_number", e.target.value)}
            style={{ width: "100%" }}
          />
        </EditField>
        <EditField label="シリアル番号(レンズ)" highlight>
          <input
            type="text"
            value={editForm.lens_serial_number}
            onChange={(e) => updateEdit("lens_serial_number", e.target.value)}
            style={{ width: "100%" }}
          />
        </EditField>
        <EditField label="出品カテゴリ(category)">
          <select
            value={editForm.platform_category}
            onChange={(e) => updateEdit("platform_category", e.target.value)}
            style={{ width: "100%" }}
          >
            <option value="">選択してください</option>
            {PLATFORM_CATEGORY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </EditField>
        <EditField label="グレード(grade)">
          <select
            value={editForm.grade}
            onChange={(e) => updateEdit("grade", e.target.value)}
            style={{ width: "100%" }}
          >
            <option value="">選択してください</option>
            {GRADE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </EditField>
        <EditField label="付属品" highlight>
          <input
            type="text"
            value={editForm.accessories_included}
            onChange={(e) => updateEdit("accessories_included", e.target.value)}
            placeholder="自由記述で入力"
            style={{ width: "100%" }}
          />
        </EditField>

        <div
          style={{
            marginBottom: 16,
            padding: "10px 12px",
            border: "0.5px dashed var(--border-strong)",
            borderRadius: 8,
            background: "var(--surface-1)",
          }}
        >
          <label style={{ fontSize: 12, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
            画像保管フォルダ
          </label>

          <div style={{ marginBottom: 8 }}>
            <label style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 2 }}>
              Google DriveフォルダのURL(任意・ステータス連動の自動移動に必要)
            </label>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type="text"
                placeholder="https://drive.google.com/drive/folders/..."
                value={editForm.drive_folder_url}
                onChange={(e) => updateEdit("drive_folder_url", e.target.value)}
                style={{ flex: 1 }}
              />
              <button type="button" onClick={handleFetchDriveInfo} disabled={fetchingDriveInfo}>
                {fetchingDriveInfo ? "取得中..." : "Driveから取得"}
              </button>
            </div>
            {/* 2026-09-05追加: 上のボタンで実際のGoogle Driveフォルダ名(商品フォルダ)と親フォルダ名
                (機種名フォルダ)を取得し、下記2項目に反映する(常に上書き、保存は別途「保存」ボタンで確定)。 */}
            <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4, marginBottom: 0 }}>
              URLを入力して「Driveから取得」を押すと、実際のフォルダ名を下の「機種名フォルダ」「商品フォルダ」欄に自動入力します(入力済みの内容も上書きされます)。
            </p>
            {/* 2026-09-05バグ修正: 出品中(フラット配置)等、機種名フォルダが存在しないケースでは
                機種名フォルダ欄を意図的に空欄のままにする。エラーではないため、注意書きとして案内する
                (ユーザー指摘「@カメラ出品データ(ステージ管理用フォルダ)が機種名フォルダとして
                入ってしまう」への対応)。 */}
            {driveInfoNote && (
              <p style={{ fontSize: 11, color: "var(--danger-text)", marginTop: 4, marginBottom: 0 }}>
                ⚠ {driveInfoNote}
              </p>
            )}
          </div>

          <div style={{ marginBottom: 8 }}>
            <label style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 2 }}>
              機種名フォルダ(@撮影済み・出品待ち 配下)
            </label>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type="text"
                placeholder="例: Nikon FM2"
                value={editForm.model_folder_name}
                onChange={(e) => updateEdit("model_folder_name", e.target.value)}
                style={{ flex: 1 }}
              />
              <button type="button" onClick={handlePickModelFolder}>
                フォルダを選択
              </button>
              <input
                ref={modelFolderPickerInputRef}
                type="file"
                // @ts-expect-error webkitdirectory は標準の型定義に存在しないが主要ブラウザでサポートされている
                webkitdirectory=""
                directory=""
                multiple
                style={{ display: "none" }}
                onChange={handleModelFolderPicked}
              />
            </div>
            {noModelFolderExpected && (
              <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4, marginBottom: 0 }}>
                ℹ️ この商品は現在「{stageLabelForNote}」ステージのため機種名フォルダを介さずGoogle Drive上に直接配置されています。空欄のままで問題ありません。
              </p>
            )}
          </div>

          <div style={{ marginBottom: 8 }}>
            <label style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 2 }}>
              商品フォルダ
            </label>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type="text"
                placeholder="例: 20260822-01"
                value={editForm.item_folder_name}
                onChange={(e) => updateEdit("item_folder_name", e.target.value)}
                style={{ flex: 1 }}
              />
              <button type="button" onClick={handlePickItemFolder}>
                フォルダを選択
              </button>
              <input
                ref={itemFolderPickerInputRef}
                type="file"
                // @ts-expect-error webkitdirectory は標準の型定義に存在しないが主要ブラウザでサポートされている
                webkitdirectory=""
                directory=""
                multiple
                style={{ display: "none" }}
                onChange={handleItemFolderPicked}
              />
            </div>
          </div>

          {computedDrivePath && (
            <div style={{ marginBottom: 4 }}>
              <label style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 2 }}>
                フルパス(確認・編集可能)
              </label>
              <input
                type="text"
                value={computedDrivePath}
                readOnly
                style={{ width: "100%", color: "var(--text-secondary)" }}
              />
            </div>
          )}
        </div>

        <div
          style={{
            marginBottom: 12,
            padding: "10px 12px",
            border: "0.5px solid var(--danger-text)",
            borderRadius: 8,
            background: "var(--danger-bg)",
          }}
        >
          <label style={{ fontSize: 12, color: "var(--danger-text)", display: "block", marginBottom: 4, fontWeight: 500 }}>
            ステータス(修正用)
          </label>
          <select
            value={editForm.status}
            onChange={(e) => updateEdit("status", e.target.value as ItemStatus)}
            style={{ width: "100%" }}
          >
            {Object.entries(ITEM_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <p style={{ fontSize: 11, color: "var(--danger-text)", margin: "6px 0 0" }}>
            ⚠️ ここでの変更は入力ミスの訂正や、専用ボタンの無い遷移(例: 販売済み→出品中に戻す)専用です。
            通常のステータス遷移は各タブの専用ボタン(「着荷・検品待ちにする」「検品済・出品待ちにする」等)
            から行うことを推奨します。保存するとGoogle Driveフォルダの自動移動は実行されますが、
            返品依頼時の記録作成(purchase_returns)などステータス専用ボタンに付随する副作用は実行されません。
          </p>
        </div>

        {editError && <p style={{ color: "var(--danger-text)", fontSize: 13, marginBottom: 8 }}>{editError}</p>}
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={handleSaveEdit} disabled={editBusy}>
            保存
          </button>
          <button onClick={() => setEditing(false)} disabled={editBusy}>
            キャンセル
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={ROW_STYLE}>
        <span style={LABEL_STYLE}>アカウント</span>
        <span>{item.account ? (EBAY_ACCOUNT_LABELS[item.account as EbayAccount] ?? item.account) : "未設定"}</span>
      </div>
      <div style={ROW_STYLE}>
        <span style={LABEL_STYLE}>カテゴリ</span>
        <span>{item.category}</span>
      </div>
      <div style={ROW_STYLE}>
        <span style={HIGHLIGHT_LABEL_STYLE}>管理番号</span>
        <span>{item.management_no}</span>
      </div>
      <div style={ROW_STYLE}>
        <span style={LABEL_STYLE}>Sales #</span>
        <span>
          {item.sales && item.sales.length > 0
            ? item.sales
                .map((s) => s.sales_record_reference)
                .filter((v): v is string => Boolean(v))
                .join("、") || "-"
            : "-"}
        </span>
      </div>
      <div style={ROW_STYLE}>
        <span style={LABEL_STYLE}>ITEM TITLE</span>
        <span>
          {item.sales && item.sales.length > 0
            ? item.sales
                .map((s) => s.sale_item_title)
                .filter((v): v is string => Boolean(v))
                .join("、") || "-"
            : "-"}
        </span>
      </div>
      <div style={ROW_STYLE}>
        <span style={LABEL_STYLE}>販売プラットフォーム</span>
        <span>
          {item.sales && item.sales.length > 0
            ? item.sales
                .map((s) => s.sales_platform)
                .filter((v): v is string => Boolean(v))
                .join("、") || "-"
            : "-"}
        </span>
      </div>
      <div style={ROW_STYLE}>
        <span style={LABEL_STYLE}>Order番号</span>
        <span>{orderNumberDisplay}</span>
      </div>
      <div style={ROW_STYLE}>
        <span style={LABEL_STYLE}>仕入品名</span>
        <span>{item.title ?? "-"}</span>
      </div>
      <div style={ROW_STYLE}>
        <span style={HIGHLIGHT_LABEL_STYLE}>ITEM TITLE</span>
        <span>{item.item_title ?? "-"}</span>
      </div>
      {purchase && (
        <>
          <div style={ROW_STYLE}>
            <span style={LABEL_STYLE}>仕入日</span>
            <span>{purchase.purchase_date}</span>
          </div>
          <div style={ROW_STYLE}>
            <span style={LABEL_STYLE}>仕入先種別</span>
            <span>
              {SOURCE_TYPE_OPTIONS.find((o) => o.value === purchase.source_type)?.label ?? purchase.source_type}
            </span>
          </div>
          <div style={ROW_STYLE}>
            <span style={LABEL_STYLE}>仕入先・出品者名</span>
            <span>{purchase.source_name ?? "-"}</span>
          </div>
          <div style={ROW_STYLE}>
            <span style={LABEL_STYLE}>購入元URL</span>
            <span>{purchase.source_url ?? "-"}</span>
          </div>
          <div style={ROW_STYLE}>
            <span style={LABEL_STYLE}>仕入高(円)</span>
            <span>{purchase.purchase_price.toLocaleString()}</span>
          </div>
          <div style={ROW_STYLE}>
            <span style={LABEL_STYLE}>数量</span>
            <span>{purchase.quantity}</span>
          </div>
        </>
      )}

      <div style={ROW_STYLE}>
        <span style={HIGHLIGHT_LABEL_STYLE}>新古判定</span>
        <span>{purchase ? (purchase.is_used_goods ? "古物" : "新品") : "-"}</span>
      </div>
      <div style={ROW_STYLE}>
        <span style={LABEL_STYLE}>取引先区分</span>
        <span>
          {purchase
            ? COUNTERPARTY_TYPE_OPTIONS.find((o) => o.value === purchase.counterparty_type)?.label ??
              purchase.counterparty_type
            : "-"}
        </span>
      </div>
      <div style={ROW_STYLE}>
        <span style={HIGHLIGHT_LABEL_STYLE}>ブランド / 機種</span>
        <span>{[item.brand, item.model].filter(Boolean).join(" ") || "-"}</span>
      </div>
      <div style={ROW_STYLE}>
        <span style={HIGHLIGHT_LABEL_STYLE}>タイプ</span>
        <span>{item.type ?? "-"}</span>
      </div>
      <div style={ROW_STYLE}>
        <span style={HIGHLIGHT_LABEL_STYLE}>シリアル番号(ボディー)</span>
        <span>{item.serial_number ?? "-"}</span>
      </div>
      <div style={ROW_STYLE}>
        <span style={HIGHLIGHT_LABEL_STYLE}>シリアル番号(レンズ)</span>
        <span>{item.lens_serial_number ?? "-"}</span>
      </div>
      <div style={ROW_STYLE}>
        <span style={LABEL_STYLE}>ステータス</span>
        <span>{ITEM_STATUS_LABELS[item.status]}</span>
      </div>
      {/* 2026-09-06 added: gross profit (JPY), per user request. Sum across all sales when multiple. */}
      {item.sales && item.sales.length > 0 && (
        <div style={ROW_STYLE}>
          <span style={LABEL_STYLE}>粗利(円)</span>
          <span>
            ¥{item.sales.reduce((sum, s) => sum + (s.gross_profit_jpy ?? 0), 0).toLocaleString()}
          </span>
        </div>
      )}
      <div style={ROW_STYLE}>
        <span style={LABEL_STYLE}>出品カテゴリ(category)</span>
        <span>{PLATFORM_CATEGORY_OPTIONS.find((o) => o.value === item.platform_category)?.label ?? item.platform_category ?? "-"}</span>
      </div>
      <div style={ROW_STYLE}>
        <span style={LABEL_STYLE}>グレード(grade)</span>
        <span>{item.grade ?? "-"}</span>
      </div>
      <div style={ROW_STYLE}>
        <span style={HIGHLIGHT_LABEL_STYLE}>付属品</span>
        <span>{item.accessories_included ?? "-"}</span>
      </div>

      {driveFolder && (
        <div style={ROW_STYLE}>
          <span style={LABEL_STYLE}>画像保管フォルダ</span>
          {/* 2026-09-05バグ修正: driveFolder.drive_folder_pathは登録・最終編集時点のパスを保存した
              ままの値で、その後ステータス進行によりmove-drive-folderがGoogle Drive上のフォルダを
              別ステージへ移動しても更新されない(「フォルダを開く」ボタンの不具合と同一原因)。
              表示だけでも実態と食い違って誤解を招くため、current_stageから毎回ライブに計算する。
              計算できない場合(情報不足)のみ、保存済みの値を参考情報としてフォールバック表示する。
              2026-09-05バグ修正(2): 「機種名フォルダ」「商品フォルダ」を未入力のままGoogle DriveのURLだけを
              登録した場合(「Driveから取得」を使わず直接URLだけ貼り付けたケース)、computeDriveLocalPath()も
              drive_folder_pathも両方空になり、この行が完全に空欄で表示されていた。実際にはdrive_folder_id
              (URL)自体はDBに正しく保存されているにも関わらず、画面上「何も保存されていないように見える」
              ため、ユーザーから「GoogleドライブのURLを入力していても保存されない」という誤解を招く不具合
              報告があった(実際にはURLはSQLで確認した通り正しく保存されており、表示だけの問題だった)。
              ローカルパスが計算できない場合、drive_folder_pathも空ならdrive_folder_id自体から組み立てた
              Google DriveのURLを表示するようフォールバックを追加。 */}
          <span>
            {computeDriveLocalPath(driveFolder.current_stage, driveFolder.model_folder_name, driveFolder.item_folder_name) ??
              (driveFolder.drive_folder_path ||
                (driveFolder.drive_folder_id
                  ? `(ローカルパス未確定) https://drive.google.com/drive/folders/${driveFolder.drive_folder_id}`
                  : "-"))}
          </span>
        </div>
      )}

      {/* 2026-09-08変更: ステータス進行ボタンは「検品」タブに一本化したため、このタブでは
          「入荷待ち→着荷・検品待ち」の専用ボタンのみを表示する。それ以外のステータスでは
          advanceStepが未定義になり、ボタン自体を表示しない(以前は無効化してステータス名を
          表示していたが、検品タブ側のボタン群と役割が重複するため非表示に変更)。 */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16, alignItems: "flex-start" }}>
        {advanceStep && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button onClick={handleAdvanceStatus} disabled={busy}>
              {advanceStep.actionLabel}
            </button>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
              (現在のステータス:「{ITEM_STATUS_LABELS[item.status]}」。押すと「{ITEM_STATUS_LABELS[advanceStep.next]}」に変更されます)
            </span>
          </div>
        )}
      </div>
      {errorMessage && <p style={{ color: "var(--danger-text)", fontSize: 13, marginTop: 8 }}>{errorMessage}</p>}
    </div>
  );
}

function EditField({
  label,
  children,
  highlight,
}: {
  label: string;
  children: React.ReactNode;
  /** 2026-09-22追加(ユーザー指示): trueのときラベルを赤太字で強調表示する。 */
  highlight?: boolean;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label
        style={{
          fontSize: 12,
          color: highlight ? "var(--danger-text)" : "var(--text-secondary)",
          fontWeight: highlight ? 700 : undefined,
          display: "block",
          marginBottom: 4,
        }}
      >
        {label}
      </label>
      <div style={{ fontSize: 13 }}>{children}</div>
    </div>
  );
}
