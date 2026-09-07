import { useCallback, useEffect, useState } from "react";
import ItemListPane from "../components/inventory/ItemListPane";
import ItemDetailPane from "../components/inventory/ItemDetailPane";
import ItemTableView from "../components/inventory/ItemTableView";
import InventoryBackupPanel from "../components/inventory/InventoryBackupPanel";
import {
  fetchItemListWithPurchase,
  fetchInventoryValuationSummary,
  type InventoryValuationSummary,
  type ItemSortOption,
  type ItemWithPurchase,
} from "../lib/api/items";
import type { ItemListFilters } from "../lib/types";

type ViewMode = "split" | "table" | "backup";

// 在庫マスター・ディテール画面(要件定義書v4 §6 / ワイヤーフレーム案A)
// 左ペイン: 一覧+検索。右ペイン: 選択した商品の詳細(基本情報/仕入/検品タブ)。
// 「一覧表示」モードでは、売上・粗利タブと同様の全幅テーブルで絞り込み結果を確認できる。
export default function InventoryPage() {
  const [items, setItems] = useState<ItemWithPurchase[]>([]);
  const [filters, setFilters] = useState<ItemListFilters>({});
  const [sort, setSort] = useState<ItemSortOption>("created_desc");
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("split");
  const [valuationSummary, setValuationSummary] = useState<InventoryValuationSummary | null>(null);
  /** 一覧表示モードで行をクリックした際に、画面遷移せずその場で編集するためのモーダル対象商品ID(2026-09-03追加)。 */
  const [modalItemId, setModalItemId] = useState<string | null>(null);
  /** 「複写して新規作成」で選択した、コピー元とする既存商品ID(2026-09-04追加)。詳細編集(split)モードの
   *  ItemDetailPaneにのみ渡し、一覧表示モードのモーダル編集には渡さない(仕様上、複写元は詳細編集画面から
   *  しか選べないため)。 */
  const [copySourceItemId, setCopySourceItemId] = useState<string | null>(null);

  /** 2026-09-05バグ修正(ユーザー指摘「在庫・販売済タブ 一覧表示 アカウントすべて を指定しても
   *  soulmenjapan のものしか表示されない」): 「詳細編集」モードの左ペイン(ItemListPane)が持つ
   *  アカウント・ステータスの絞り込み(このfilters state、サーバー側クエリに使われる)と、
   *  「一覧表示」モード(ItemTableView)が持つ、より高機能な絞り込み(管理番号・カテゴリ・アカウント・
   *  ステータス・日付範囲等、クライアント側でitems配列に対して適用)は、見た目上は別々の独立した
   *  絞り込みUIだが、どちらも同じfilters stateから取得したitemsを対象にしていたため、詳細編集モードで
   *  一度アカウント等を絞り込んだ状態のまま一覧表示モードに切り替えると、一覧表示側の「アカウント
   *  (すべて)」を選んでも、そもそもサーバーから取得済みのitems自体が詳細編集側の絞り込み条件で
   *  限定されたままになり、他アカウントの商品が一切含まれていない、という不具合があった。
   *  一覧表示モードは絞り込みUIをそれ自体で完結させる設計のため、一覧表示モードのときはfilters
   *  (詳細編集モード用)を適用せず常に全件取得し、絞り込みはItemTableView側のクライアント側フィルタ
   *  のみに委ねるよう修正した(詳細編集モード側の挙動・filters stateの持ち方自体は変更していない)。 */
  const reloadList = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const effectiveFilters = viewMode === "table" ? {} : filters;
      const [data, summary] = await Promise.all([
        fetchItemListWithPurchase(effectiveFilters, undefined, sort),
        fetchInventoryValuationSummary(),
      ]);
      setItems(data);
      setValuationSummary(summary);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "一覧の取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [filters, sort, viewMode]);

  useEffect(() => {
    void reloadList();
  }, [reloadList]);

  function handleSelectItem(itemId: string) {
    setIsCreatingNew(false);
    setSelectedItemId(itemId);
    setCopySourceItemId(null);
    setViewMode("split");
  }

  function handleStartNewItem() {
    setSelectedItemId(null);
    setIsCreatingNew(true);
    setCopySourceItemId(null);
    setViewMode("split");
  }

  /** 既存商品の詳細表示から「複写して新規作成」を実行した際のハンドラ(2026-09-04追加)。
   *  新規登録モードに切り替えつつ、その商品をコピー元として自動選択する。 */
  function handleCopyAsNew(sourceItemId: string) {
    setSelectedItemId(null);
    setIsCreatingNew(true);
    setCopySourceItemId(sourceItemId);
    setViewMode("split");
  }

  async function handleItemCreated(newItemId: string) {
    setIsCreatingNew(false);
    setSelectedItemId(newItemId);
    setCopySourceItemId(null);
    await reloadList();
  }

  /** 「詳細編集」モードで商品を削除した後のハンドラ(2026-09-06追加)。選択解除して一覧を再取得する。 */
  async function handleItemDeleted() {
    setSelectedItemId(null);
    await reloadList();
  }

  /** 「一覧表示」モードのモーダル詳細編集で商品を削除した後のハンドラ(2026-09-06追加)。モーダルを閉じて一覧を再取得する。 */
  async function handleModalItemDeleted() {
    setModalItemId(null);
    await reloadList();
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          display: "flex",
          gap: 4,
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px",
          borderBottom: "0.5px solid var(--border)",
        }}
      >
        <div style={{ display: "flex", gap: 4 }}>
        <button
          onClick={() => setViewMode("split")}
          style={{
            fontSize: 12,
            padding: "4px 10px",
            border: "none",
            borderBottom: viewMode === "split" ? "2px solid var(--accent)" : "2px solid transparent",
            borderRadius: 0,
            background: "transparent",
            color: viewMode === "split" ? "var(--accent)" : "var(--text-secondary)",
          }}
        >
          詳細編集
        </button>
        <button
          onClick={() => setViewMode("table")}
          style={{
            fontSize: 12,
            padding: "4px 10px",
            border: "none",
            borderBottom: viewMode === "table" ? "2px solid var(--accent)" : "2px solid transparent",
            borderRadius: 0,
            background: "transparent",
            color: viewMode === "table" ? "var(--accent)" : "var(--text-secondary)",
          }}
        >
          一覧表示
        </button>
        <button
          onClick={() => setViewMode("backup")}
          style={{
            fontSize: 12,
            padding: "4px 10px",
            border: "none",
            borderBottom: viewMode === "backup" ? "2px solid var(--accent)" : "2px solid transparent",
            borderRadius: 0,
            background: "transparent",
            color: viewMode === "backup" ? "var(--accent)" : "var(--text-secondary)",
          }}
        >
          バックアップ・復元
        </button>
        </div>

        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          棚卸資産(検品済・出品待ち + 出品中):{" "}
          {valuationSummary ? (
            <strong style={{ color: "var(--text-primary, inherit)" }}>
              {valuationSummary.count.toLocaleString()}個 / {valuationSummary.totalPurchasePrice.toLocaleString()}円
            </strong>
          ) : (
            "-"
          )}
        </div>
      </div>

      {viewMode === "backup" ? (
        <InventoryBackupPanel onDataChanged={reloadList} />
      ) : viewMode === "split" ? (
        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          <div style={{ width: "38%", borderRight: "0.5px solid var(--border)", overflowY: "auto" }}>
            <ItemListPane
              items={items}
              loading={loading}
              errorMessage={errorMessage}
              filters={filters}
              onFiltersChange={setFilters}
              sort={sort}
              onSortChange={setSort}
              selectedItemId={selectedItemId}
              onSelectItem={handleSelectItem}
              onStartNewItem={handleStartNewItem}
            />
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "1rem 1.5rem" }}>
            <ItemDetailPane
              itemId={selectedItemId}
              isCreatingNew={isCreatingNew}
              onItemCreated={handleItemCreated}
              onItemChanged={reloadList}
              copySourceItemId={copySourceItemId}
              onCopyAsNew={handleCopyAsNew}
              onItemDeleted={handleItemDeleted}
            />
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0 }}>
          <ItemTableView
            items={items}
            loading={loading}
            errorMessage={errorMessage}
            onSelectItem={setModalItemId}
            onItemChanged={reloadList}
          />
        </div>
      )}

      {modalItemId && (
        <>
          <div
            onClick={() => setModalItemId(null)}
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 1000 }}
          />
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: "fixed",
              top: "5vh",
              left: "50%",
              transform: "translateX(-50%)",
              width: "min(900px, calc(100% - 32px))",
              maxHeight: "90vh",
              overflowY: "auto",
              background: "var(--surface-2)",
              border: "1px solid var(--accent)",
              borderRadius: 12,
              zIndex: 1001,
              boxShadow: "0 8px 24px rgba(0,0,0,0.2)",
              padding: "1rem 1.5rem",
            }}
          >
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
              <button
                onClick={() => setModalItemId(null)}
                style={{ fontSize: 12, padding: "4px 10px" }}
              >
                閉じる
              </button>
            </div>
            <ItemDetailPane
              itemId={modalItemId}
              isCreatingNew={false}
              onItemCreated={() => {}}
              onItemChanged={reloadList}
              onItemDeleted={handleModalItemDeleted}
            />
          </div>
        </>
      )}
    </div>
  );
}
