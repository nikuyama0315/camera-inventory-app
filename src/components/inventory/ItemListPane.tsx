import type { ItemListFilters, ItemStatus } from "../../lib/types";
import { EBAY_ACCOUNT_LABELS, EBAY_ACCOUNT_OPTIONS, ITEM_STATUS_LABELS } from "../../lib/types";
import { SOURCE_TYPE_OPTIONS } from "../../lib/constants";
import type { ItemSortOption, ItemWithPurchase } from "../../lib/api/items";

interface Props {
  // 2026-09-24変更: 状態ランク・状態チェック表下の自由記述を一覧に表示するため、
  // 検品データも含むItemWithPurchase[]を受け取るようにした(呼び出し元のInventoryPage.tsxは
  // 元々fetchItemListWithPurchase()の結果をそのまま渡していたため、呼び出し側の変更は不要)。
  items: ItemWithPurchase[];
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

const STATUS_FILTER_OPTIONS: [string, string][] = [
  ["awaiting_arrival", ITEM_STATUS_LABELS.awaiting_arrival],
  ["awaiting_inspection", ITEM_STATUS_LABELS.awaiting_inspection],
  ["inspected_awaiting_listing", ITEM_STATUS_LABELS.inspected_awaiting_listing],
  ["listed", ITEM_STATUS_LABELS.listed],
  ["sold", ITEM_STATUS_LABELS.sold],
  ["inspected_return_requested", ITEM_STATUS_LABELS.inspected_return_requested],
  ["inspected_returned", ITEM_STATUS_LABELS.inspected_returned],
  ["sold_missing_shipping_tracking", "販売済・送料/追跡情報未入力"],
  ["not_sold", "販売済み以外"],
  ["returned_item_received", ITEM_STATUS_LABELS.returned_item_received],
  ["on_hold", ITEM_STATUS_LABELS.on_hold],
];

// items.categoryは自由入力の文字列列(DBにCHECK制約は無い)だが、実運用では以下3種類のみに
// 統一されている(2026-09-02にラベルを「カメラ関連品」「雑貨」「衣類」に統一済み)。一覧表示モード
// (ItemTableView.tsx)は読み込み済みitemsから動的に選択肢を組み立てるが、詳細編集モードのこの絞り込みは
// サーバー側クエリの結果(=絞り込み後のitems)を選択肢の元にすると、カテゴリ自体を絞り込んだ際に
// 他の選択肢が一覧から消えて選び直せなくなるため、固定リストにしている(2026-09-06追加)。
const CATEGORY_OPTIONS = ["カメラ関連品", "雑貨", "衣類"];

const ROW_STYLE: React.CSSProperties = { display: "flex", gap: 8, marginBottom: 8 };

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
        {/* 絞り込み条件(2026-09-23変更: ユーザー指定の行配置に変更。表示順プルダウンは削除、
            登録日時(created_at)範囲を追加)。 */}
        <div style={ROW_STYLE}>
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
          <select
            value={filters.status ?? ""}
            onChange={(e) =>
              onFiltersChange({
                ...filters,
                status: (e.target.value || undefined) as
                  | ItemStatus
                  | "not_sold"
                  | "sold_missing_shipping_tracking"
                  | undefined,
              })
            }
            style={{ flex: 1 }}
          >
            <option value="">ステータス(すべて)</option>
            {STATUS_FILTER_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
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

        {/* 2026-09-23変更: rows2〜6をCSS Gridの2列に変更。flexboxで行ごとに独立してサイズ計算する
            方式だと、行によって左側の要素の中身(inputとbuttonの既定box-sizing差、複数inputを内包する
            ラッパーの有無等)が異なるため、右側の項目(登録日時・仕入日・販売日・更新日・新規登録)の
            左端が行ごとに微妙にズレてしまっていた。CSS Gridは列幅を全行共通で1回だけ計算するため、
            この種のズレが原理的に起きない。 */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", columnGap: 8, rowGap: 8 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              placeholder="管理番号・シリアル番号"
              value={filters.keyword ?? ""}
              onChange={(e) => onFiltersChange({ ...filters, keyword: e.target.value || undefined })}
              style={{ flex: 1, minWidth: 0 }}
            />
            <input
              type="text"
              placeholder="追跡番号"
              value={filters.trackingNumber ?? ""}
              onChange={(e) => onFiltersChange({ ...filters, trackingNumber: e.target.value || undefined })}
              style={{ flex: 1, minWidth: 0 }}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <label style={{ fontSize: 11, color: "var(--text-secondary)" }}>登録日時</label>
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <input
                type="date"
                value={filters.createdAtFrom ?? ""}
                onChange={(e) => onFiltersChange({ ...filters, createdAtFrom: e.target.value || undefined })}
                style={{ flex: 1 }}
              />
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>〜</span>
              <input
                type="date"
                value={filters.createdAtTo ?? ""}
                onChange={(e) => onFiltersChange({ ...filters, createdAtTo: e.target.value || undefined })}
                style={{ flex: 1 }}
              />
            </div>
          </div>

          <input
            type="text"
            placeholder="ブランド/機種"
            value={filters.brand ?? ""}
            onChange={(e) => onFiltersChange({ ...filters, brand: e.target.value || undefined })}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <label style={{ fontSize: 11, color: "var(--text-secondary)" }}>仕入日</label>
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <input
                type="date"
                value={filters.purchaseDateFrom ?? ""}
                onChange={(e) => onFiltersChange({ ...filters, purchaseDateFrom: e.target.value || undefined })}
                style={{ flex: 1 }}
              />
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>〜</span>
              <input
                type="date"
                value={filters.purchaseDateTo ?? ""}
                onChange={(e) => onFiltersChange({ ...filters, purchaseDateTo: e.target.value || undefined })}
                style={{ flex: 1 }}
              />
            </div>
          </div>

          <input
            type="text"
            placeholder="仕入品名"
            value={filters.purchaseTitle ?? ""}
            onChange={(e) => onFiltersChange({ ...filters, purchaseTitle: e.target.value || undefined })}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
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

          <select
            value={filters.sourceType ?? ""}
            onChange={(e) => onFiltersChange({ ...filters, sourceType: e.target.value || undefined })}
          >
            <option value="">仕入先(すべて)</option>
            {SOURCE_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <label style={{ fontSize: 11, color: "var(--text-secondary)" }}>更新日</label>
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <input
                type="date"
                value={filters.updatedAtFrom ?? ""}
                onChange={(e) => onFiltersChange({ ...filters, updatedAtFrom: e.target.value || undefined })}
                style={{ flex: 1 }}
              />
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>〜</span>
              <input
                type="date"
                value={filters.updatedAtTo ?? ""}
                onChange={(e) => onFiltersChange({ ...filters, updatedAtTo: e.target.value || undefined })}
                style={{ flex: 1 }}
              />
            </div>
          </div>

          <input
            type="text"
            placeholder="出品者名"
            value={filters.sellerName ?? ""}
            onChange={(e) => onFiltersChange({ ...filters, sellerName: e.target.value || undefined })}
          />
          <button onClick={onStartNewItem}>+ 新規登録</button>
        </div>
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
              {/* 2026-09-24変更(ユーザー指示): 管理番号・ブランド/機種・ステータス・状態ランクを1行に統合。
                  管理番号のみ太字で強調表示。 */}
              <p style={{ fontSize: 13, fontWeight: 400, margin: 0 }}>
                <strong style={{ fontWeight: 700 }}>{item.management_no}</strong>
                {[item.brand, item.model].filter(Boolean).length > 0
                  ? ` ・ ${[item.brand, item.model].filter(Boolean).join(" ")}`
                  : ""}
                {` ・ ${ITEM_STATUS_LABELS[item.status]}`}
                {item.condition_grade ? ` ・ ${item.condition_grade}` : ""}
              </p>
              {/* 2026-09-24追加(ユーザー指示): 状態チェック表下の自由記述(functional_check_notes)を表示。 */}
              {item.functional_check_notes && (
                <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "2px 0 0" }}>
                  {item.functional_check_notes}
                </p>
              )}
            </div>
          );
        })}

      {!loading && items.length === 0 && (
        <div style={{ padding: 12, fontSize: 13, color: "var(--text-muted)" }}>該当する商品がありません</div>
      )}
    </div>
  );
}
