import { useEffect, useRef, useState } from "react";
import type { ItemDetail, ListingPhoto } from "../../../lib/types";
import {
  LISTING_CONDITION_DEFAULT,
  LISTING_CONDITION_OPTIONS,
  LISTING_EBAY_CATEGORY_DEFAULT,
  LISTING_EBAY_CATEGORY_OPTIONS,
  LISTING_PAYMENT_POLICY_DEFAULT,
  LISTING_PAYMENT_POLICY_OPTIONS,
  LISTING_SHIPPING_POLICY_DEFAULT,
  LISTING_SHIPPING_POLICY_OPTIONS,
  LISTING_STORE_CATEGORY_DEFAULT,
  LISTING_STORE_CATEGORY_OPTIONS,
} from "../../../lib/types";
import {
  LISTING_PHOTOS_MAX_COUNT,
  deleteListingPhoto,
  fetchItemSpecificsSample,
  fetchListingDraft,
  publishListing,
  uploadListingPhoto,
  upsertListingDraft,
} from "../../../lib/api/listingDraft";

interface Props {
  item: ItemDetail;
  onChanged: () => void;
}

/** 2026-09-27追加(ユーザー指示): Item Specificsを1つの大きなテキストボックスではなく、
 *  項目ごとに個別のテキストボックスで表示・編集する。DB側(item_specifics_text列)は従来通り
 *  「Name: Value」1行1項目のテキストのまま保存するため、読み込み/保存時にパース・組み立てを行う。 */
interface SpecificPair {
  name: string;
  value: string;
}

function parseSpecificsText(text: string): SpecificPair[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf(":");
      if (idx === -1) return { name: line, value: "" };
      return { name: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };
    });
}

function serializeSpecificsPairs(pairs: SpecificPair[]): string {
  return pairs.map((p) => `${p.name}: ${p.value}`).join("\n");
}

/** 2026-09-27追加: 「出品」タブ(検品と販売の間)。出品用データを作成し、Supabase Storageへ写真を
 *  保存、最終的に「出品する」ボタンからeBay Trading API AddFixedPriceItemで実際にライブ出品する。
 *  写真アップロード先はユーザー指示によりSupabase Storage(listing-photosバケット、公開)。
 *  eBayのPictureURLには、そのバケットの公開URLをそのまま渡す。 */
export default function ListingTab({ item, onChanged }: Props) {
  const shopId = item.account === "soulcamera" || item.account === "soulmenjapan" ? item.account : null;

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [photos, setPhotos] = useState<ListingPhoto[]>([]);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const dragPhotoIndexRef = useRef<number | null>(null);

  const [itemTitle, setItemTitle] = useState("");
  const [customLabel, setCustomLabel] = useState("");
  const [ebayCategory, setEbayCategory] = useState<string>(LISTING_EBAY_CATEGORY_DEFAULT);
  const [storeCategory, setStoreCategory] = useState<string>(LISTING_STORE_CATEGORY_DEFAULT);
  const [itemSpecificsPairs, setItemSpecificsPairs] = useState<SpecificPair[]>([]);
  const [specificsSearchQuery, setSpecificsSearchQuery] = useState("");
  const [itemCondition, setItemCondition] = useState<string>(LISTING_CONDITION_DEFAULT);
  const [conditionDescription, setConditionDescription] = useState("");
  const [descriptionHtml, setDescriptionHtml] = useState("");
  const [itemPrice, setItemPrice] = useState("");
  const [paymentPolicy, setPaymentPolicy] = useState<string>(LISTING_PAYMENT_POLICY_DEFAULT);
  const [shippingPolicy, setShippingPolicy] = useState<string>(LISTING_SHIPPING_POLICY_DEFAULT);

  const [sampleBusy, setSampleBusy] = useState(false);
  const [sampleMessage, setSampleMessage] = useState<string | null>(null);

  const [saveBusy, setSaveBusy] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const [publishBusy, setPublishBusy] = useState(false);
  const [publishResult, setPublishResult] = useState<{ success: boolean; ebayItemId?: string; error?: string } | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    fetchListingDraft(item.id)
      .then((draft) => {
        if (cancelled) return;
        setItemTitle(draft?.item_title || item.item_title || "");
        setCustomLabel(draft?.custom_label || draft?.soulcamera_item_info || "");
        setEbayCategory(draft?.ebay_category || LISTING_EBAY_CATEGORY_DEFAULT);
        setStoreCategory(draft?.store_category || LISTING_STORE_CATEGORY_DEFAULT);
        setItemSpecificsPairs(parseSpecificsText(draft?.item_specifics_text || ""));
        setItemCondition(draft?.item_condition || LISTING_CONDITION_DEFAULT);
        setConditionDescription(draft?.condition_description || draft?.seller_note_text || "");
        setDescriptionHtml(draft?.description_html || "");
        setItemPrice(draft?.item_price || "");
        setPaymentPolicy(draft?.payment_policy || LISTING_PAYMENT_POLICY_DEFAULT);
        setShippingPolicy(draft?.shipping_policy || LISTING_SHIPPING_POLICY_DEFAULT);
        setPhotos(draft?.photos || []);
        setPublishResult(
          draft?.published_item_id ? { success: true, ebayItemId: draft.published_item_id } : null,
        );
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "出品データの取得に失敗しました");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [item.id, item.item_title, item.management_no]);

  async function persistPhotos(next: ListingPhoto[]) {
    setPhotos(next);
    try {
      await upsertListingDraft(item.id, { photos: next });
    } catch (err) {
      setPhotoError(err instanceof Error ? err.message : "写真の並び順保存に失敗しました");
    }
  }

  async function handleDropFiles(fileList: FileList) {
    const files = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return;
    const remaining = LISTING_PHOTOS_MAX_COUNT - photos.length;
    if (remaining <= 0) {
      setPhotoError(`写真は最大${LISTING_PHOTOS_MAX_COUNT}枚までです`);
      return;
    }
    const toUpload = files.slice(0, remaining);
    if (files.length > toUpload.length) {
      setPhotoError(`最大${LISTING_PHOTOS_MAX_COUNT}枚までのため、${toUpload.length}枚のみ登録しました`);
    } else {
      setPhotoError(null);
    }
    setPhotoBusy(true);
    try {
      const uploaded: ListingPhoto[] = [];
      for (const file of toUpload) {
        uploaded.push(await uploadListingPhoto(item.id, file));
      }
      await persistPhotos([...photos, ...uploaded]);
    } catch (err) {
      setPhotoError(err instanceof Error ? err.message : "写真のアップロードに失敗しました");
    } finally {
      setPhotoBusy(false);
    }
  }

  async function handleDeletePhoto(index: number) {
    const target = photos[index];
    const next = photos.filter((_, i) => i !== index);
    await persistPhotos(next);
    try {
      await deleteListingPhoto(target.path);
    } catch {
      // Storage側の削除に失敗しても、一覧からは既に外れているため致命的ではない(孤立ファイルが残るのみ)
    }
  }

  function handlePhotoDrop(targetIndex: number) {
    const from = dragPhotoIndexRef.current;
    dragPhotoIndexRef.current = null;
    if (from == null || from === targetIndex) return;
    const next = [...photos];
    const [moved] = next.splice(from, 1);
    next.splice(targetIndex, 0, moved);
    void persistPhotos(next);
  }

  async function handleFetchSample() {
    if (!shopId) {
      setSampleMessage("この商品にはeBayアカウント(soulcamera/soulmenjapan)が設定されていません");
      return;
    }
    const query = specificsSearchQuery.trim();
    if (!query) {
      setSampleMessage("検索したい機種名などを検索キーワード欄に入力してから押してください");
      return;
    }
    setSampleBusy(true);
    setSampleMessage(null);
    try {
      const result = await fetchItemSpecificsSample(query, shopId);
      setItemSpecificsPairs(parseSpecificsText(result.itemSpecificsText));
      if (result.itemPrice) setItemPrice(result.itemPrice);
      setSampleMessage(
        `取得しました(参照元: ${result.sourceItemTitle ?? result.sourceItemId}${
          result.sourceOrderNumber ? " / Order No. " + result.sourceOrderNumber : ""
        })`,
      );
    } catch (err) {
      setSampleMessage(err instanceof Error ? err.message : "サンプルデータの取得に失敗しました");
    } finally {
      setSampleBusy(false);
    }
  }

  function handleViewDescriptionInBrowser() {
    const blob = new Blob([descriptionHtml], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function handleSave() {
    setSaveBusy(true);
    setSaveMessage(null);
    try {
      await upsertListingDraft(item.id, {
        item_title: itemTitle,
        custom_label: customLabel,
        ebay_category: ebayCategory,
        store_category: storeCategory,
        item_specifics_text: serializeSpecificsPairs(itemSpecificsPairs),
        item_condition: itemCondition,
        condition_description: conditionDescription,
        description_html: descriptionHtml,
        item_price: itemPrice,
        payment_policy: paymentPolicy,
        shipping_policy: shippingPolicy,
        photos,
      });
      setSaveMessage("保存しました");
      onChanged();
    } catch (err) {
      setSaveMessage(err instanceof Error ? `保存に失敗しました: ${err.message}` : "保存に失敗しました");
    } finally {
      setSaveBusy(false);
    }
  }

  async function handlePublish() {
    if (!shopId) {
      setPublishResult({ success: false, error: "この商品にはeBayアカウント(soulcamera/soulmenjapan)が設定されていません" });
      return;
    }
    if (!window.confirm("実際にeBayへ出品します。よろしいですか?(この操作は取り消せません)")) return;
    setPublishBusy(true);
    setPublishResult(null);
    try {
      await handleSave();
      const result = await publishListing(item.id, shopId);
      setPublishResult(result);
      if (result.success) onChanged();
    } catch (err) {
      setPublishResult({ success: false, error: err instanceof Error ? err.message : "出品に失敗しました" });
    } finally {
      setPublishBusy(false);
    }
  }

  if (loading) {
    return <p style={{ fontSize: 13, color: "var(--text-muted)" }}>読み込み中...</p>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {loadError && <p style={{ fontSize: 13, color: "var(--danger-text)" }}>{loadError}</p>}
      {!shopId && (
        <p style={{ fontSize: 12, color: "var(--danger-text)" }}>
          この商品の「アカウント」がsoulcamera/soulmenjapanのいずれでもないため、サンプルデータ取得・出品は行えません(基本情報タブで設定してください)。
        </p>
      )}

      {/* 1. 写真ドロップエリア */}
      <section>
        <p style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
          写真({photos.length}/{LISTING_PHOTOS_MAX_COUNT})
        </p>
        <div
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("Files")) e.preventDefault();
          }}
          onDrop={(e) => {
            if (!e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
            e.preventDefault();
            void handleDropFiles(e.dataTransfer.files);
          }}
          style={{
            border: "1.5px dashed var(--border-strong)",
            borderRadius: 8,
            padding: 12,
            minHeight: 110,
            display: "flex",
            flexWrap: "wrap",
            gap: 10,
            alignItems: "flex-start",
          }}
        >
          {photos.length === 0 && (
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "auto" }}>
              ここへ写真ファイルをドラッグ&ドロップ(最大{LISTING_PHOTOS_MAX_COUNT}枚)。サムネイルをドラッグすると並び替えできます。
            </p>
          )}
          {photos.map((photo, index) => (
            <div
              key={photo.path}
              draggable
              onDragStart={() => {
                dragPhotoIndexRef.current = index;
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                handlePhotoDrop(index);
              }}
              style={{ position: "relative", width: 100, height: 100, cursor: "grab" }}
              title={`${index + 1}枚目`}
            >
              <img
                src={photo.url}
                alt=""
                style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 6, border: "0.5px solid var(--border)" }}
              />
              <button
                type="button"
                onClick={() => void handleDeletePhoto(index)}
                title="削除"
                style={{
                  position: "absolute",
                  top: -6,
                  right: -6,
                  width: 20,
                  height: 20,
                  borderRadius: "50%",
                  padding: 0,
                  lineHeight: "18px",
                  fontSize: 12,
                  background: "var(--danger-text)",
                  color: "#fff",
                  border: "none",
                }}
              >
                ×
              </button>
              <span
                style={{
                  position: "absolute",
                  bottom: 2,
                  left: 2,
                  fontSize: 10,
                  color: "#fff",
                  background: "rgba(0,0,0,0.5)",
                  borderRadius: 3,
                  padding: "0 4px",
                }}
              >
                {index + 1}
              </span>
            </div>
          ))}
        </div>
        {photoBusy && <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>アップロード中...</p>}
        {photoError && <p style={{ fontSize: 11, color: "var(--danger-text)", marginTop: 4 }}>{photoError}</p>}
      </section>

      {/* 2. TITLE エリア */}
      <section>
        <p style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>TITLE</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            Item Title({itemTitle.length}/80)
            <input
              type="text"
              value={itemTitle}
              maxLength={80}
              onChange={(e) => setItemTitle(e.target.value)}
              style={{ display: "block", width: "100%", marginTop: 4, boxSizing: "border-box" }}
            />
          </label>
          <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            Custom label (SKU)({customLabel.length}/50)
            <input
              type="text"
              value={customLabel}
              maxLength={50}
              onChange={(e) => setCustomLabel(e.target.value)}
              style={{ display: "block", width: "100%", marginTop: 4, boxSizing: "border-box" }}
            />
          </label>
        </div>
      </section>

      {/* 3. ITEM CATEGORY エリア */}
      <section>
        <p style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>ITEM CATEGORY</p>
        <div style={{ display: "flex", gap: 16 }}>
          <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            ebay category
            <select value={ebayCategory} onChange={(e) => setEbayCategory(e.target.value)} style={{ display: "block", marginTop: 4 }}>
              {LISTING_EBAY_CATEGORY_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            Store category
            <select value={storeCategory} onChange={(e) => setStoreCategory(e.target.value)} style={{ display: "block", marginTop: 4 }}>
              {LISTING_STORE_CATEGORY_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {/* 4. Item specifics エリア */}
      <section>
        <p style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Item specifics</p>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
          <input
            type="text"
            value={specificsSearchQuery}
            onChange={(e) => setSpecificsSearchQuery(e.target.value)}
            placeholder="機種名などを入力(例: Canon AE-1)"
            style={{ width: "30ch" }}
          />
          <button type="button" onClick={() => void handleFetchSample()} disabled={sampleBusy} style={{ width: "fit-content", flexShrink: 0 }}>
            {sampleBusy ? "取得中..." : "サンプルデータ取得"}
          </button>
        </div>
        {sampleMessage && <p style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 10 }}>{sampleMessage}</p>}
        {itemSpecificsPairs.length === 0 ? (
          <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
            「サンプルデータ取得」を押すと、直近の販売済みデータからItem Specificsを項目ごとに取得して表示します。
          </p>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            {itemSpecificsPairs.map((pair, index) => (
              <label key={`${pair.name}-${index}`} style={{ fontSize: 11, color: "var(--text-secondary)", width: 200 }}>
                {pair.name}
                <input
                  type="text"
                  value={pair.value}
                  onChange={(e) => {
                    const value = e.target.value;
                    setItemSpecificsPairs((prev) => prev.map((p, i) => (i === index ? { ...p, value } : p)));
                  }}
                  style={{ display: "block", width: "100%", marginTop: 2, boxSizing: "border-box", fontSize: 12 }}
                />
              </label>
            ))}
          </div>
        )}
      </section>

      {/* 5. CONDITION エリア */}
      <section>
        <p style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>CONDITION</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            Item condition
            <select
              value={itemCondition}
              onChange={(e) => setItemCondition(e.target.value)}
              style={{ display: "block", marginTop: 4 }}
            >
              {LISTING_CONDITION_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            Condition description
            <textarea
              value={conditionDescription}
              onChange={(e) => setConditionDescription(e.target.value)}
              rows={6}
              style={{ display: "block", width: "100%", marginTop: 4, boxSizing: "border-box", fontFamily: "monospace", fontSize: 12 }}
            />
          </label>
        </div>
      </section>

      {/* 6. DESCRIPTION エリア */}
      <section>
        <p style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>DESCRIPTION</p>
        <textarea
          value={descriptionHtml}
          onChange={(e) => setDescriptionHtml(e.target.value)}
          rows={14}
          style={{ width: "100%", boxSizing: "border-box", fontFamily: "monospace", fontSize: 11 }}
        />
        <button
          type="button"
          onClick={handleViewDescriptionInBrowser}
          disabled={!descriptionHtml.trim()}
          style={{ marginTop: 6, width: "fit-content" }}
        >
          ブラウザで見る
        </button>
      </section>

      {/* PRICING エリア */}
      <section>
        <p style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>PRICING</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            Format
            <input type="text" value="Buy It Now" disabled style={{ display: "block", width: 200, marginTop: 4 }} />
          </label>
          <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            Item price (USD)
            <input
              type="text"
              value={itemPrice}
              onChange={(e) => setItemPrice(e.target.value)}
              style={{ display: "block", width: 200, marginTop: 4 }}
            />
          </label>
          <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            Payment policy
            <select
              value={paymentPolicy}
              onChange={(e) => setPaymentPolicy(e.target.value)}
              style={{ display: "block", marginTop: 4 }}
            >
              {LISTING_PAYMENT_POLICY_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            Shipping policy
            <select
              value={shippingPolicy}
              onChange={(e) => setShippingPolicy(e.target.value)}
              style={{ display: "block", marginTop: 4 }}
            >
              {LISTING_SHIPPING_POLICY_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section style={{ display: "flex", alignItems: "center", gap: 12, borderTop: "0.5px solid var(--border)", paddingTop: 16 }}>
        <button type="button" onClick={() => void handleSave()} disabled={saveBusy}>
          {saveBusy ? "保存中..." : "保存"}
        </button>
        <button type="button" onClick={() => void handlePublish()} disabled={publishBusy || !shopId}>
          {publishBusy ? "出品処理中..." : "出品する"}
        </button>
        {saveMessage && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{saveMessage}</span>}
      </section>

      {publishResult && (
        <p
          style={{
            fontSize: 13,
            color: publishResult.success ? "var(--text-primary)" : "var(--danger-text)",
            fontWeight: 700,
          }}
        >
          {publishResult.success
            ? `出品に成功しました。ItemID: ${publishResult.ebayItemId}`
            : `出品に失敗しました: ${publishResult.error}`}
        </p>
      )}
    </div>
  );
}
