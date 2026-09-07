import type { Item, ItemListFilters, ItemStatus } from "../../lib/types";
import { EBAY_ACCOUNT_LABELS, EBAY_ACCOUNT_OPTIONS, ITEM_STATUS_LABELS } from "../../lib/types";
import type { ItemSortOption } from "../../lib/api/items";

interface Props {
  items: Item[];
  loading: boolean;
  errorMessage: string | null;
  filters: ItemListFilters;
  onFiltersChange: (filters: ItemListFilters) => void;
  sort: ItemSortOption;
  onSortChange: (sort: ItemSortOption) => void;
  selectedItemId: string | null;
  onSelectItem: (itemId: string) => void;
  onStartNewItem: () => void;
}

const SORT_OPTIONS: { value: ItemSortOption; label: string }[] = [
  { value: "created_desc", label: "登録日時(新しい順)" },
  { value: "created_asc", label: "登録日時(古い順)" },
  { value: "model_asc", label: "機種名(昇順 A→Z・あ→ん)" },
  { value: "model_desc", label: "機種名(降順 Z→A・ん→あ)" },
  { value: "sale_date_desc", label: "販売日(新しい順)" },
  { value: "sale_date_asc", label: "販売日(古い順)" },
];

const STATUS_OPTIONS = Object.entries(ITEM_STATUS_LABELS) as [ItemStatus, string][];

// items.categoryは自由入力の文字列列(DBにCHECK制約は無い)だが、実運用では以下3種類のみに
// 統一されている(2026-09-02にラベルを「カメラ関連品」「雑貨」「衣類」に統一済み)。一覧表示モード
// (ItemTableView.tsx)は読み込み済みitemsから動的に選択肢を組み立てるが、詳細編集モードのこの絞り込みは
// サーバー側クエリの結果(=絞り込み後のitems)を選択肢の元にすると、カテゴリ自体を絞り込んだ際に
// 他の選択肢が一覧から消えて選び直せなくなるため、固定リストにしている(2026-09-06追加)。
const CATEGORY_OPTIONS = ["カメラ関連品", "雑貨", "衣類"];

export default function ItemListPane({
  items,
  loading,
  errorMessage,
  filters,
  onFiltersChange,
  sort,
  onSortChange,
  selectedItemId,
  onSelectItem,
  onStartNewItem,
}: Props) {
  return (
    <div>
      <div style={{ padding: "12px", borderBottom: "0.5px solid var(--border)" }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <select
            value={filters.status ?? ""}
            onChange={(e) =>
              onFiltersChange({
                ...filters,
                status: (e.target.value || undefined) as ItemStatus | "not_sold" | undefined,
              })
            }
            style={{ flex: 1 }}
          >
            <option value="">ステータス(すべて)</option>
            <option value="not_sold">販売済み以外</option>
            {STATUS_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <select
            value={filters.account ?? ""}
            onChange={(e) => onFiltersChange({ ...filters, account: e.target.value || undefined })}
            style={{ flex: 1 }}
          >
            <option value="">アカウント(すべて)</option>
            {EBAY_ACCOUNT_OPTIONS.map((a) => (
              <option key={a} value={a}>
                {EBAY_ACCOUNT_LABELS[a]}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <select
            value={filters.category ?? ""}
            onChange={(e) => onFiltersChange({ ...filters, category: e.target.value || undefined })}
            style={{ flex: 1 }}
          >
            <option value="">カテゴリ(すべて)</option>
            {CATEGORY_OPTIONS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <select
            value={sort}
            onChange={(e) => onSortChange(e.target.value as ItemSortOption)}
            style={{ flex: 1 }}
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <input
            type="text"
            placeholder="ブランド/機種"
            value={filters.brand ?? ""}
            onChange={(e) => onFiltersChange({ ...filters, brand: e.target.value || undefined })}
            style={{ flex: 1 }}
          />
          <input
            type="text"
            placeholder="管理番号・シリアル番号"
            value={filters.keyword ?? ""}
            onChange={(e) => onFiltersChange({ ...filters, keyword: e.target.value || undefined })}
            style={{ flex: 1 }}
          />
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <input
            type="text"
            placeholder="追跡番号"
            value={filters.trackingNumber ?? ""}
            onChange={(e) => onFiltersChange({ ...filters, trackingNumber: e.target.value || undefined })}
            style={{ flex: 1 }}
          />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 8 }}>
          <label style={{ fontSize: 11, color: "var(--text-secondary)" }}>販売日</label>
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input
              type="date"
              value={filters.saleDateFrom ?? ""}
              onChange={(e) => onFiltersChange({ ...filters, saleDateFrom: e.target.value || undefined })}
              style={{ flex: 1 }}
            />
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>〜</span>
            <input
              type="date"
              value={filters.saleDateTo ?? ""}
              onChange={(e) => onFiltersChange({ ...filters, saleDateTo: e.target.value || undefined })}
              style={{ flex: 1 }}
            />
          </div>
        </div>
        <button onClick={onStartNewItem} style={{ width: "100%" }}>
          + 新規登録
        </button>
      </div>

      {errorMessage && (
        <div style={{ padding: 12, color: "var(--danger-text)", fontSize: 13 }}>{errorMessage}</div>
      )}
      {loading && <div style={{ padding: 12, fontSize: 13, color: "var(--text-secondary)" }}>読み込み中...</div>}
      {!loading && !errorMessage && (
        <div style={{ padding: "8px 12px", fontSize: 12, color: "var(--text-secondary)", borderBottom: "0.5px solid var(--border)" }}>
          該当件数: {items.length}件
        </div>
      )}

      {!loading &&
        items.map((item) => {
          const isSelected = item.id === selectedItemId;
          return (
            <div
              key={item.id}
              onClick={() => onSelectItem(item.id)}
              style={{
                padding: "10px 12px",
                borderBottom: "0.5px solid var(--border)",
                cursor: "pointer",
                background: isSelected ? "var(--surface-1)" : "transparent",
              }}
            >
              <p style={{ fontSize: 13, fontWeight: 500, margin: 0 }}>{item.management_no}</p>
              <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: "2px 0 0" }}>
                {[item.brand, item.model].filter(Boolean).join(" ")} ・ {ITEM_STATUS_LABELS[item.status]}
              </p>
            </div>
          );
        })}

      {!loading && items.length === 0 && (
        <div style={{ padding: 12, fontSize: 13, color: "var(--text-muted)" }}>該当する商品がありません</div>
      )}
    </div>
  );
}
