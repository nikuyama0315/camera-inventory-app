import { useEffect, useRef, useState } from "react";
import { createItemWithPurchase, suggestManagementNo } from "../../../lib/api/purchases";
import { createItemDriveFolder, fetchDriveFolderInfo } from "../../../lib/api/driveFolders";
import { fetchItemDetail, fetchItemList } from "../../../lib/api/items";
import type { Item, ItemDetail } from "../../../lib/types";
import { COUNTERPARTY_TYPE_OPTIONS, type CounterpartyType } from "../../../lib/taxDeduction";
import DeductionBadge from "../../shared/DeductionBadge";
import { pickFolderNameViaDirectoryPicker } from "../../../lib/folderPicker";

interface Props {
  isCreatingNew: boolean;
  detail: ItemDetail | null;
  onCreated: (newItemId: string) => void;
  onChanged: () => void;
  /** 「複写して新規作成」から遷移した場合の、コピー元として自動選択する商品ID(2026-09-04追加)。
   *  isCreatingNewがtrueになったタイミングでこのIDが渡されていれば、ユーザーが手動でコピー元を
   *  選び直さなくても自動的にapplyCopiedFieldsが適用される。 */
  initialCopySourceId?: string | null;
}

const SOURCE_TYPE_OPTIONS = [
  { value: "yahoo_auction", label: "ヤフオク" },
  { value: "mercari", label: "メルカリ" },
  { value: "yahoo_furima", label: "ヤフーフリマ" },
  { value: "rakuma", label: "ラクマ" },
  { value: "store", label: "実店舗" },
  { value: "other", label: "その他" },
];

const USED_GOODS_OPTIONS = [
  { value: "true", label: "古物" },
  { value: "false", label: "新品" },
];

interface FormState {
  purchase_date: string;
  source_type: string;
  source_name: string;
  source_url: string;
  purchase_price: string;
  quantity: string;
  category: string;
  brand: string;
  model: string;
  serial_number: string;
  management_no: string;
  title: string;
  is_used_goods: string; // "true" | "false"
  counterparty_type: CounterpartyType;
  model_folder_name: string;
  item_folder_name: string;
  drive_folder_url: string;
}

const EMPTY_FORM: FormState = {
  purchase_date: new Date().toISOString().slice(0, 10),
  source_type: SOURCE_TYPE_OPTIONS[0].value,
  source_name: "",
  source_url: "",
  purchase_price: "",
  quantity: "1",
  category: "カメラ関連品",
  brand: "",
  model: "",
  serial_number: "",
  management_no: "",
  title: "",
  is_used_goods: "true",
  counterparty_type: "consumer",
  model_folder_name: "",
  item_folder_name: "",
  drive_folder_url: "",
};

const DRIVE_BASE_PATH =
  "G:\\マイドライブ\\@個人事業\\@カメラ出品データ\\@撮影済み・出品待ち\\";

// コピー元選択時に引き継ぐ項目(仕入日・仕入高・数量・シリアル番号・管理番号・仕入品名は商品ごとに異なるためコピーしない)
function applyCopiedFields(prev: FormState, source: ItemDetail): FormState {
  const purchase = source.purchases?.[0];
  return {
    ...prev,
    category: source.category ?? prev.category,
    brand: source.brand ?? "",
    model: source.model ?? "",
    source_type: purchase?.source_type ?? prev.source_type,
    source_name: purchase?.source_name ?? "",
    source_url: purchase?.source_url ?? "",
    is_used_goods: purchase?.is_used_goods !== undefined ? String(purchase.is_used_goods) : prev.is_used_goods,
    counterparty_type: purchase?.counterparty_type ?? prev.counterparty_type,
    // 意図的に維持する項目(コピーしない): purchase_date, purchase_price, quantity, serial_number, management_no, title
  };
}

export default function PurchaseTab({ isCreatingNew, detail, onCreated, initialCopySourceId }: Props) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  /** 2026-09-05追加(ユーザー要望「新規登録パネルのGoogle DriveフォルダのURL欄にも、フォルダ名を
   *  取得するボタンをつけて」): BasicInfoTab.tsx(既存アイテム編集)の「Driveから取得」と同じ機能を
   *  新規登録パネルにも追加。 */
  const [fetchingDriveInfo, setFetchingDriveInfo] = useState(false);
  const [driveInfoNote, setDriveInfoNote] = useState<string | null>(null);

  const [copyCandidates, setCopyCandidates] = useState<Item[]>([]);
  const [copySourceId, setCopySourceId] = useState("");
  const [copyLoading, setCopyLoading] = useState(false);
  const [copySearch, setCopySearch] = useState("");

  const COPY_LIST_LIMIT = 50;
  const lastSuggestedRef = useRef<string>("");
  const modelFolderPickerInputRef = useRef<HTMLInputElement>(null);
  const itemFolderPickerInputRef = useRef<HTMLInputElement>(null);

  const computedDrivePath =
    form.model_folder_name.trim() && form.item_folder_name.trim()
      ? `${DRIVE_BASE_PATH}${form.model_folder_name.trim()}\\${form.item_folder_name.trim()}\\`
      : "";

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
    if (folderName) update("model_folder_name", folderName);
  }

  function handleItemFolderPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const folderName = pickedFolderName(e);
    if (folderName) update("item_folder_name", folderName);
  }

  async function handlePickModelFolder() {
    const name = await pickFolderNameViaDirectoryPicker();
    if (name) {
      update("model_folder_name", name);
    } else if (!("showDirectoryPicker" in window)) {
      modelFolderPickerInputRef.current?.click();
    }
  }

  async function handlePickItemFolder() {
    const name = await pickFolderNameViaDirectoryPicker();
    if (name) {
      update("item_folder_name", name);
    } else if (!("showDirectoryPicker" in window)) {
      itemFolderPickerInputRef.current?.click();
    }
  }

  useEffect(() => {
    if (!isCreatingNew) return;
    setForm(EMPTY_FORM);
    setCopySearch("");
    lastSuggestedRef.current = "";
    fetchItemList({}, COPY_LIST_LIMIT)
      .then((items) => setCopyCandidates(items))
      .catch(() => setCopyCandidates([]));
    // 「複写して新規作成」経由の場合は、コピー元検索リストを待たずに自動でコピー元を適用する
    // (2026-09-04追加)。それ以外(通常の「+新規登録」)は従来通りコピー元を選択していない状態にする。
    if (initialCopySourceId) {
      void handleCopySourceChange(initialCopySourceId);
    } else {
      setCopySourceId("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCreatingNew, initialCopySourceId]);

  // 仕入日(=登録日として扱う)が変わるたびに管理番号の候補を再取得する。
  // ただしユーザーが候補から手動で書き換えていた場合は上書きしない。
  useEffect(() => {
    if (!isCreatingNew) return;
    suggestManagementNo(form.purchase_date)
      .then((suggested) => {
        setForm((prev) => {
          if (prev.management_no === "" || prev.management_no === lastSuggestedRef.current) {
            lastSuggestedRef.current = suggested;
            return { ...prev, management_no: suggested };
          }
          return prev;
        });
      })
      .catch(() => {
        /* 候補取得に失敗しても手入力で続行できるため無視する */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCreatingNew, form.purchase_date]);

  useEffect(() => {
    if (!isCreatingNew) return;
    const handle = setTimeout(() => {
      fetchItemList(copySearch ? { keyword: copySearch } : {}, COPY_LIST_LIMIT)
        .then((items) => setCopyCandidates(items))
        .catch(() => setCopyCandidates([]));
    }, 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [copySearch]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  /** 2026-09-05追加: BasicInfoTab.tsx の handleFetchDriveInfo と同じ機能。入力済みのGoogle Drive
   *  フォルダURLから、Drive API(Edge Function `drive-folder-info`)経由で実際のフォルダ名(=商品フォルダ)
   *  と親フォルダ名(=機種名フォルダ)を取得し、フォームへ常に上書き反映する(保存自体は別途
   *  「登録する」ボタンを押すまで確定しない)。 */
  async function handleFetchDriveInfo() {
    const url = form.drive_folder_url.trim();
    if (!url) {
      setErrorMessage("Google DriveフォルダのURLを入力してください");
      return;
    }
    setFetchingDriveInfo(true);
    setErrorMessage(null);
    setDriveInfoNote(null);
    try {
      const info = await fetchDriveFolderInfo(url);
      update("model_folder_name", info.model_folder_name ?? "");
      update("item_folder_name", info.item_folder_name ?? "");
      if (info.model_folder_skipped_reason) {
        setDriveInfoNote(info.model_folder_skipped_reason);
      }
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? `Google Driveフォルダ情報の取得に失敗しました: ${err.message}` : "Google Driveフォルダ情報の取得に失敗しました",
      );
    } finally {
      setFetchingDriveInfo(false);
    }
  }

  async function handleCopySourceChange(itemId: string) {
    setCopySourceId(itemId);
    if (!itemId) return;
    setCopyLoading(true);
    setErrorMessage(null);
    try {
      const source = await fetchItemDetail(itemId);
      setForm((prev) => applyCopiedFields(prev, source));
      // 「複写して新規作成」で自動選択した商品が、直近50件の一覧(copyCandidates)に含まれていない
      // 場合でもプルダウンに正しく表示されるよう、先頭に追加しておく(2026-09-04追加)。
      setCopyCandidates((prev) => (prev.some((c) => c.id === source.id) ? prev : [source, ...prev]));
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "コピー元の取得に失敗しました");
    } finally {
      setCopyLoading(false);
    }
  }

  async function handleSubmit() {
    setErrorMessage(null);

    if (!form.purchase_date || !form.purchase_price || !form.category || !form.management_no.trim()) {
      setErrorMessage("仕入日・仕入高・カテゴリ・管理番号は必須です");
      return;
    }

    setBusy(true);
    try {
      const result = await createItemWithPurchase({
        purchase_date: form.purchase_date,
        source_type: form.source_type,
        source_name: form.source_name || undefined,
        source_url: form.source_url || undefined,
        purchase_price: Number(form.purchase_price),
        quantity: Number(form.quantity) || 1,
        category: form.category,
        brand: form.brand || undefined,
        model: form.model || undefined,
        serial_number: form.serial_number || undefined,
        management_no: form.management_no.trim(),
        title: form.title || undefined,
        is_used_goods: form.is_used_goods === "true",
        counterparty_type: form.counterparty_type,
      });

      if (form.item_folder_name.trim()) {
        try {
          await createItemDriveFolder({
            item_id: result.item_id,
            drive_folder_path: computedDrivePath,
            model_folder_name: form.model_folder_name || undefined,
            item_folder_name: form.item_folder_name || undefined,
            drive_folder_url: form.drive_folder_url || undefined,
          });
        } catch (driveErr) {
          setErrorMessage(
            "商品は登録されましたが、フォルダ情報の登録に失敗しました: " +
              (driveErr instanceof Error ? driveErr.message : "不明なエラー"),
          );
        }
      }

      onCreated(result.item_id);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "登録に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  if (isCreatingNew) {
    return (
      <div>
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
            既存の商品をコピー元にする(任意)
          </label>
          <input
            type="text"
            placeholder="管理番号・機種名・シリアル番号で絞り込み"
            value={copySearch}
            onChange={(e) => setCopySearch(e.target.value)}
            style={{ width: "100%", marginBottom: 6 }}
          />
          <select
            value={copySourceId}
            onChange={(e) => handleCopySourceChange(e.target.value)}
            disabled={copyLoading}
            style={{ width: "100%" }}
          >
            <option value="">コピーしない</option>
            {copyCandidates.map((item) => (
              <option key={item.id} value={item.id}>
                {item.management_no} ({[item.brand, item.model].filter(Boolean).join(" ") || item.category})
              </option>
            ))}
          </select>
          <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "6px 0 0" }}>
            直近{COPY_LIST_LIMIT}件のみ表示されます。見つからない場合は上の検索欄で絞り込んでください。カテゴリ・ブランド・機種名・仕入先情報・新古判定のみコピーされます(仕入日・仕入高・数量・シリアル番号・管理番号・仕入品名は都度入力)。
          </p>
        </div>

        <Field label="管理番号">
          <input
            type="text"
            value={form.management_no}
            onChange={(e) => update("management_no", e.target.value)}
            style={{ width: "100%" }}
          />
          <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "4px 0 0" }}>
            登録日ベースで自動採番されます(YYMMDD-XX)。必要に応じて自由に書き換えてください。
          </p>
        </Field>
        <Field label="仕入品名">
          <input
            type="text"
            placeholder="例: Nikon FM2 ボディ シルバー"
            value={form.title}
            onChange={(e) => update("title", e.target.value)}
            style={{ width: "100%" }}
          />
        </Field>
        <Field label="仕入日">
          <input
            type="date"
            value={form.purchase_date}
            onChange={(e) => update("purchase_date", e.target.value)}
            style={{ width: "100%" }}
          />
        </Field>
        <Field label="仕入先種別">
          <select
            value={form.source_type}
            onChange={(e) => update("source_type", e.target.value)}
            style={{ width: "100%" }}
          >
            {SOURCE_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="仕入先・出品者名">
          <input
            type="text"
            value={form.source_name}
            onChange={(e) => update("source_name", e.target.value)}
            style={{ width: "100%" }}
          />
        </Field>
        <Field label="購入元URL">
          <input
            type="text"
            value={form.source_url}
            onChange={(e) => update("source_url", e.target.value)}
            style={{ width: "100%" }}
          />
        </Field>
        <Field label="仕入高(円)">
          <input
            type="number"
            value={form.purchase_price}
            onChange={(e) => update("purchase_price", e.target.value)}
            style={{ width: "100%" }}
          />
        </Field>
        <Field label="数量">
          <input
            type="number"
            value={form.quantity}
            onChange={(e) => update("quantity", e.target.value)}
            style={{ width: "100%" }}
          />
        </Field>
        <Field label="新古判定">
          <select
            value={form.is_used_goods}
            onChange={(e) => update("is_used_goods", e.target.value)}
            style={{ width: "100%" }}
          >
            {USED_GOODS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="取引先区分">
          <select
            value={form.counterparty_type}
            onChange={(e) => update("counterparty_type", e.target.value as CounterpartyType)}
            style={{ width: "100%" }}
          >
            {COUNTERPARTY_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <DeductionBadge counterpartyType={form.counterparty_type} />
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
            画像保管フォルダ(任意)
          </label>

          <div style={{ marginBottom: 8 }}>
            <label style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 2 }}>
              機種名フォルダ(@撮影済み・出品待ち 配下)
            </label>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type="text"
                placeholder="例: Nikon FM2"
                value={form.model_folder_name}
                onChange={(e) => update("model_folder_name", e.target.value)}
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
          </div>

          <div style={{ marginBottom: 8 }}>
            <label style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 2 }}>
              商品フォルダ
            </label>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type="text"
                placeholder="例: 20260822-01"
                value={form.item_folder_name}
                onChange={(e) => update("item_folder_name", e.target.value)}
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

          <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "6px 0 0 0" }}>
            ブラウザの仕様上、フォルダの絶対パス(ドライブレター等)は自動取得できません。「フォルダを選択」でフォルダ名だけを自動入力し、フルパスは組み立てたものを確認のうえ、必要であれば直接修正してください。
          </p>

          <div style={{ marginTop: 10 }}>
            <label style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 2 }}>
              Google DriveフォルダのURL(任意・ステータス連動の自動移動に必要)
            </label>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type="text"
                placeholder="https://drive.google.com/drive/folders/..."
                value={form.drive_folder_url}
                onChange={(e) => update("drive_folder_url", e.target.value)}
                style={{ flex: 1 }}
              />
              <button type="button" onClick={handleFetchDriveInfo} disabled={fetchingDriveInfo}>
                {fetchingDriveInfo ? "取得中..." : "Driveから取得"}
              </button>
            </div>
            <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "4px 0 0" }}>
              Google DriveのWeb画面で当該商品フォルダを開き、アドレスバーのURLをそのまま貼り付けてください。これを登録すると、出品・販売等のステータス変化時にシステムが自動でフォルダを移動できるようになります(未入力の場合は自動移動されません)。「Driveから取得」を押すと、実際のフォルダ名を上の「機種名フォルダ」「商品フォルダ」欄に自動入力します(入力済みの内容も上書きされます)。
            </p>
            {driveInfoNote && (
              <p style={{ fontSize: 11, color: "var(--danger-text)", marginTop: 4, marginBottom: 0 }}>
                ⚠ {driveInfoNote}
              </p>
            )}
          </div>
        </div>

        <Field label="カテゴリ">
          <input
            type="text"
            value={form.category}
            onChange={(e) => update("category", e.target.value)}
            style={{ width: "100%" }}
          />
        </Field>
        <Field label="ブランド">
          <input
            type="text"
            value={form.brand}
            onChange={(e) => update("brand", e.target.value)}
            style={{ width: "100%" }}
          />
        </Field>
        <Field label="機種名">
          <input
            type="text"
         value={form.model}
            onChange={(e) => update("model", e.target.value)}
            style={{ width: "100%" }}
          />
        </Field>
        <Field label="シリアル番号">
          <input
            type="text"
            value={form.serial_number}
            onChange={(e) => update("serial_number", e.target.value)}
            style={{ width: "100%" }}
          />
        </Field>

        {errorMessage && (
          <p style={{ color: "var(--danger-text)", fontSize: 13, marginBottom: 8 }}>{errorMessage}</p>
        )}
        <button onClick={handleSubmit} disabled={busy}>
          登録して検品へ進む
        </button>
      </div>
    );
  }

  const purchase = detail?.purchases?.[0];
  if (!purchase) {
    return <p style={{ fontSize: 13, color: "var(--text-muted)" }}>仕入情報がありません</p>;
  }

  return (
    <div>
      <Field label="仕入日">{purchase.purchase_date}</Field>
      <Field label="仕入先種別">{purchase.source_type}</Field>
      <Field label="仕入先・出品者名">{purchase.source_name ?? "-"}</Field>
      <Field label="購入元URL">{purchase.source_url ?? "-"}</Field>
      <Field label="仕入高(円)">{purchase.purchase_price.toLocaleString()}</Field>
      <Field label="数量">{purchase.quantity}</Field>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ fontSize: 12, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
        {label}
      </label>
      <div style={{ fontSize: 13 }}>{children}</div>
    </div>
  );
}
