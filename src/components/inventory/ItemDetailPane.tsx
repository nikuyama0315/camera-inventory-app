import { useEffect, useState } from "react";
import BasicInfoTab from "./tabs/BasicInfoTab";
import PurchaseTab from "./tabs/PurchaseTab";
import InspectionTab from "./tabs/InspectionTab";
import SalesTab from "./tabs/SalesTab";
import { fetchItemDetail, deleteItem } from "../../lib/api/items";
import type { ItemDetail } from "../../lib/types";

interface Props {
  itemId: string | null;
  isCreatingNew: boolean;
  onItemCreated: (newItemId: string) => void;
  onItemChanged: () => void;
  /** 「複写して新規作成」から遷移した場合の、コピー元として自動選択する商品ID(2026-09-04追加) */
  copySourceItemId?: string | null;
  /** 既存アイテムの詳細表示から「複写して新規作成」を実行するハンドラ(2026-09-04追加) */
  onCopyAsNew?: (itemId: string) => void;
  /** 商品を削除した後に呼び出すハンドラ(2026-09-06追加)。呼び出し元で選択解除・モーダルを閉じる等を行う。 */
  onItemDeleted?: () => void;
}

type TabKey = "basic" | "purchase" | "inspection" | "sales";

const TABS: { key: TabKey; label: string }[] = [
  { key: "basic", label: "基本情報" },
  { key: "purchase", label: "仕入" },
  { key: "inspection", label: "検品" },
  { key: "sales", label: "販売" },
  // Phase3/4で「写真・出品/履歴」タブを追加する
];

export default function ItemDetailPane({
  itemId,
  isCreatingNew,
  onItemCreated,
  onItemChanged,
  copySourceItemId,
  onCopyAsNew,
  onItemDeleted,
}: Props) {
  const [activeTab, setActiveTab] = useState<TabKey>("purchase");
  /** 2026-09-23追加(ユーザー指示): タブ行右端の「Description生成へ」ボタン用。押すたびインクリメントし、
   *  検品タブ側でDescription生成セクションへスクロールするトリガーとして渡す。 */
  const [descriptionScrollTrigger, setDescriptionScrollTrigger] = useState(0);

  function handleGoToDescriptionGenerator() {
    setActiveTab("inspection");
    setDescriptionScrollTrigger((v) => v + 1);
  }
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // 2026-09-10追加: 「基本情報」タブの「編集」ボタンをこの上部ヘッダーへ移設(元は
  // BasicInfoTab内部にあった)。editTriggerをインクリメントしてBasicInfoTab側のstartEditing()を
  // 呼び出し、basicInfoEditingで現在編集中かどうかを受け取ってボタンの表示/非表示を切り替える。
  const [basicInfoEditTrigger, setBasicInfoEditTrigger] = useState(0);
  const [basicInfoEditing, setBasicInfoEditing] = useState(false);

  useEffect(() => {
    if (isCreatingNew) {
      setDetail(null);
      setActiveTab("purchase"); // 新規登録は仕入タブから入力する(§6)
      return;
    }
    if (!itemId) {
      setDetail(null);
      return;
    }
    setActiveTab("basic");
    void loadDetail(itemId);
  }, [itemId, isCreatingNew]);

  async function loadDetail(id: string) {
    setLoading(true);
    setErrorMessage(null);
    try {
      const data = await fetchItemDetail(id);
      setDetail(data);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "詳細の取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }

  function handleAfterChange() {
    onItemChanged();
    if (itemId) void loadDetail(itemId);
  }

  /** 「削除」ボタン(2026-09-06追加)。確認のうえdeleteItem()を呼び、成功したら呼び出し元へ通知する。 */
  async function handleDeleteItem() {
    if (!detail) return;
    const label = `${detail.management_no}${detail.title ? ` / ${detail.title}` : ""}`;
    if (
      !window.confirm(
        `商品「${label}」を削除します。この商品に紐づく仕入・検品・売上・Google Driveフォルダ連携情報もあわせて削除されます(eBay取引データ自体は削除されず、未登録の状態に戻ります)。この操作は取り消せません。よろしいですか?`,
      )
    ) {
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteItem(detail.id);
      if (onItemDeleted) {
        onItemDeleted();
      } else {
        onItemChanged();
      }
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "削除に失敗しました");
    } finally {
      setDeleting(false);
    }
  }

  if (!isCreatingNew && !itemId) {
    return (
      <div style={{ color: "var(--text-muted)", fontSize: 14, padding: "2rem 0" }}>
        左の一覧から商品を選択するか、「+ 新規登録」で仕入情報を入力してください.
      </div>
    );
  }

  if (loading) {
    return <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>読み込み中...</div>;
  }

  if (errorMessage) {
    return <div style={{ fontSize: 13, color: "var(--danger-text)" }}>{errorMessage}</div>;
  }

  return (
    <div>
      {detail && !isCreatingNew && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <p style={{ fontSize: 16, fontWeight: 500, margin: 0 }}>
              {detail.management_no} / {[detail.brand, detail.model].filter(Boolean).join(" ")}
            </p>
            <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
              {activeTab === "basic" && !basicInfoEditing && (
                <button
                  type="button"
                  onClick={() => setBasicInfoEditTrigger((n) => n + 1)}
                  style={{
                    fontSize: 12,
                    padding: "4px 10px",
                    border: "0.5px solid var(--border)",
                    borderRadius: 4,
                    background: "var(--surface)",
                    color: "var(--text-secondary)",
                    whiteSpace: "nowrap",
                  }}
                  title="基本情報を編集します"
                >
                  編集
                </button>
              )}
              {onCopyAsNew && (
                <button
                  type="button"
                  onClick={() => onCopyAsNew(detail.id)}
                  style={{
                    fontSize: 12,
                    padding: "4px 10px",
                    border: "0.5px solid var(--border)",
                    borderRadius: 4,
                    background: "var(--surface)",
                    color: "var(--text-secondary)",
                    whiteSpace: "nowrap",
                  }}
                  title="この商品の情報をコピー元にして新規登録画面を開きます"
                >
                  複写して新規作成
                </button>
              )}
              <button
                type="button"
                onClick={() => void handleDeleteItem()}
                disabled={deleting}
                style={{
                  fontSize: 12,
                  padding: "4px 10px",
                  border: "0.5px solid var(--danger-text)",
                  borderRadius: 4,
                  background: "var(--surface)",
                  color: "var(--danger-text)",
                  whiteSpace: "nowrap",
                }}
                title="この商品を削除します(関連データもあわせて削除、取り消せません)"
              >
                {deleting ? "削除中..." : "削除"}
              </button>
            </div>
          </div>
          {deleteError && (
            <p style={{ color: "var(--danger-text)", fontSize: 12, marginTop: 6, marginBottom: 0 }}>{deleteError}</p>
          )}
        </div>
      )}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          borderBottom: "0.5px solid var(--border)",
          marginBottom: 16,
        }}
      >
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            disabled={isCreatingNew && tab.key !== "purchase"}
            style={{
              border: "none",
              borderBottom: activeTab === tab.key ? "2px solid var(--accent)" : "2px solid transparent",
              borderRadius: 0,
              background: "transparent",
              color: activeTab === tab.key ? "var(--accent)" : "var(--text-secondary)",
              opacity: isCreatingNew && tab.key !== "purchase" ? 0.4 : 1,
            }}
          >
            {tab.label}
          </button>
        ))}
        {detail && !isCreatingNew && (
          <button
            onClick={handleGoToDescriptionGenerator}
            style={{ marginLeft: "auto", fontSize: 12, padding: "4px 10px" }}
          >
            Description生成へ
          </button>
        )}
      </div>

      {activeTab === "basic" && detail && (
        <BasicInfoTab
          key={detail.id}
          item={detail}
          onChanged={handleAfterChange}
          editTrigger={basicInfoEditTrigger}
          onEditingChange={setBasicInfoEditing}
        />
      )}

      {activeTab === "purchase" && (
        <PurchaseTab
          isCreatingNew={isCreatingNew}
          detail={detail}
          onCreated={onItemCreated}
          onChanged={handleAfterChange}
          initialCopySourceId={copySourceItemId}
        />
      )}

      {activeTab === "inspection" && detail && (
        <InspectionTab
          detail={detail}
          onChanged={handleAfterChange}
          scrollToDescriptionTrigger={descriptionScrollTrigger}
        />
      )}

      {activeTab === "sales" && detail && <SalesTab item={detail} onChanged={handleAfterChange} />}
    </div>
  );
}
