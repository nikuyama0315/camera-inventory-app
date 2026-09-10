import { useEffect, useMemo, useState } from "react";
import { ITEM_STATUS_LABELS, type ItemStatus } from "../../lib/types";
import {
  buildDirectSalesCsv,
  fetchPlatformExportItems,
  type PlatformExportItem,
} from "../../lib/api/platformExportCsv";

// 在庫タブの一覧表示(ItemTableView.tsx)の絞り込みパターンをそのまま踏襲。
interface Filters {
  managementNo: string;
  brandModel: string;
  category: string;
  /** "not_sold" はステータスが"sold"(販売済み)以外の全件を対象とする特殊な絞り込み条件。 */
  status: ItemStatus | "not_sold" | "";
  purchaseDateFrom: string;
  purchaseDateTo: string;
}

const EMPTY_FILTERS: Filters = {
  managementNo: "",
  brandModel: "",
  category: "",
  status: "",
  purchaseDateFrom: "",
  purchaseDateTo: "",
};

const STATUS_OPTIONS = Object.entries(ITEM_STATUS_LABELS) as [ItemStatus, string][];

export default function DirectSalesCsvPanel() {
  const [items, setItems] = useState<PlatformExportItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  /** 一覧テーブルの折りたたみ表示(2026-09-03追加、2026-09-10デフォルトを折りたたみ済みに変更)。 */
  const [isTableCollapsed, setIsTableCollapsed] = useState(true);

  async function reload() {
    setLoading(true);
    setErrorMessage(null);
    try {
      setItems(await fetchPlatformExportItems());
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "一覧の取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  function updateFilter<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  // カテゴリは固定enumではなく自由入力のため、一覧に実際に存在する値から選択肢を組み立てる
  // (ItemTableView.tsxと同じ方針)。
  const categoryOptions = useMemo(() => {
    const set = new Set<string>();
    for (const item of items) {
      if (item.category) set.add(item.category);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [items]);

  const filteredItems = useMemo(() => {
    const managementNoQuery = filters.managementNo.trim().toLowerCase();
    const brandModelQuery = filters.brandModel.trim().toLowerCase();
    return items.filter((item) => {
      if (managementNoQuery && !(item.management_no ?? "").toLowerCase().includes(managementNoQuery)) {
        return false;
      }
      if (brandModelQuery) {
        const brandModel = [item.brand, item.model].filter(Boolean).join(" ").toLowerCase();
        if (!brandModel.includes(brandModelQuery)) return false;
      }
      if (filters.category && item.category !== filters.category) return false;
      if (filters.status === "not_sold") {
        if (item.status === "sold") return false;
      } else if (filters.status && item.status !== filters.status) {
        return false;
      }
      if (filters.purchaseDateFrom && (!item.purchase_date || item.purchase_date < filters.purchaseDateFrom)) {
        return false;
      }
      if (filters.purchaseDateTo && (!item.purchase_date || item.purchase_date > filters.purchaseDateTo)) {
        return false;
      }
      return true;
    });
  }, [items, filters]);

  const hasActiveFilters = Object.values(filters).some((v) => v !== "");

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function selectAllFiltered() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const item of filteredItems) next.add(item.id);
      return next;
    });
  }

  function deselectAllFiltered() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const item of filteredItems) next.delete(item.id);
      return next;
    });
  }

  const selectedCount = selectedIds.size;
  const allFilteredSelected = filteredItems.length > 0 && filteredItems.every((item) => selectedIds.has(item.id));

  function handleExportCsv() {
    const selectedItems = items.filter((item) => selectedIds.has(item.id));
    if (selectedItems.length === 0) return;
    const csv = buildDirectSalesCsv(selectedItems);
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    a.download = `直販プラットフォーム登録用_${stamp}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div
      style={{
        background: "var(--surface-1)",
        borderRadius: 8,
        padding: "1rem",
        border: "0.5px solid var(--border)",
        marginBottom: 16,
      }}
    >
      <p style={{ fontSize: 14, fontWeight: 600, margin: "0 0 4px" }}>直販プラットフォーム登録用CSV作成</p>
      <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: "0 0 12px" }}>
        商品を絞り込み、チェックを付けた行だけをCSVに出力します。出力される列は external_id / title / category /
        condition_description / grade / serial_number / year_made / accessories_included / price_usd /
        stock_quantity / weight_grams / dimensions_cm の12列で、うち external_id(管理番号)・title(販売アイテム名)・
        category(出品カテゴリ)・grade(グレード)・accessories_included(付属品)・condition_description(検品の英訳を
        [Total][Body][Finder][Lens][Functional]の順に連結)のみ値を埋め、それ以外の列は空欄で出力されます。
      </p>

      {errorMessage && <p style={{ color: "var(--danger-text)", fontSize: 13 }}>{errorMessage}</p>}

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          alignItems: "flex-end",
          marginBottom: 12,
          padding: "10px 12px",
          border: "0.5px dashed var(--border-strong)",
          borderRadius: 8,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <label style={{ fontSize: 11, color: "var(--text-secondary)" }}>管理番号</label>
          <input
            type="text"
            placeholder="部分一致"
            value={filters.managementNo}
            onChange={(e) => updateFilter("managementNo", e.target.value)}
            style={{ width: 120 }}
          />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <label style={{ fontSize: 11, color: "var(--text-secondary)" }}>ブランド/機種</label>
          <input
            type="text"
            placeholder="部分一致"
            value={filters.brandModel}
            onChange={(e) => updateFilter("brandModel", e.target.value)}
            style={{ width: 160 }}
          />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <label style={{ fontSize: 11, color: "var(--text-secondary)" }}>カテゴリ</label>
          <select value={filters.category} onChange={(e) => updateFilter("category", e.target.value)}>
            <option value="">すべて</option>
            {categoryOptions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <label style={{ fontSize: 11, color: "var(--text-secondary)" }}>ステータス</label>
          <select
            value={filters.status}
            onChange={(e) => updateFilter("status", e.target.value as ItemStatus | "not_sold" | "")}
          >
            <option value="">すべて</option>
            <option value="not_sold">販売済み以外</option>
            {STATUS_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <label style={{ fontSize: 11, color: "var(--text-secondary)" }}>仕入日</label>
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input
              type="date"
              value={filters.purchaseDateFrom}
              onChange={(e) => updateFilter("purchaseDateFrom", e.target.value)}
            />
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>〜</span>
            <input
              type="date"
              value={filters.purchaseDateTo}
              onChange={(e) => updateFilter("purchaseDateTo", e.target.value)}
            />
          </div>
        </div>
        {hasActiveFilters && (
          <button onClick={() => setFilters(EMPTY_FILTERS)} style={{ fontSize: 12, padding: "4px 10px" }}>
            絞り込みをクリア
          </button>
        )}
        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          {filteredItems.length}件 / 全{items.length}件
        </span>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
        <button onClick={allFilteredSelected ? deselectAllFiltered : selectAllFiltered} style={{ fontSize: 12, padding: "4px 10px" }}>
          {allFilteredSelected ? "表示中の選択を解除" : "表示中をすべて選択"}
        </button>
        <button onClick={() => setSelectedIds(new Set())} disabled={selectedCount === 0} style={{ fontSize: 12, padding: "4px 10px" }}>
          選択を全解除
        </button>
        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{selectedCount}件選択中</span>
        <button
          onClick={() => setIsTableCollapsed((v) => !v)}
          style={{ fontSize: 12, padding: "4px 10px", marginLeft: "auto" }}
        >
          {isTableCollapsed ? `一覧を展開する(${filteredItems.length}件)` : "一覧を折りたたむ"}
        </button>
        <button
          onClick={handleExportCsv}
          disabled={selectedCount === 0}
          style={{ fontSize: 12, padding: "5px 12px", fontWeight: 500 }}
        >
          選択した{selectedCount}件をCSVに出力
        </button>
      </div>

      {loading ? (
        <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>読み込み中...</p>
      ) : isTableCollapsed ? null : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--text-secondary)" }}>
                <th style={{ padding: "6px 8px", width: 28 }} />
                <th style={{ padding: "6px 8px" }}>管理番号</th>
                <th style={{ padding: "6px 8px" }}>ブランド/機種</th>
                <th style={{ padding: "6px 8px" }}>カテゴリ</th>
                <th style={{ padding: "6px 8px" }}>ステータス</th>
                <th style={{ padding: "6px 8px" }}>仕入日</th>
                <th style={{ padding: "6px 8px" }}>販売アイテム名</th>
              </tr>
            </thead>
            <tbody>
              {filteredItems.map((item) => (
                <tr
                  key={item.id}
                  onClick={() => toggleSelect(item.id)}
                  style={{ borderTop: "0.5px solid var(--border)", cursor: "pointer" }}
                >
                  <td style={{ padding: "8px" }} onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggleSelect(item.id)} />
                  </td>
                  <td style={{ padding: "8px", fontWeight: 500 }}>{item.management_no}</td>
                  <td style={{ padding: "8px" }}>{[item.brand, item.model].filter(Boolean).join(" ") || "-"}</td>
                  <td style={{ padding: "8px" }}>{item.category}</td>
                  <td style={{ padding: "8px" }}>
                    <span
                      style={{
                        fontSize: 11,
                        padding: "2px 8px",
                        borderRadius: 999,
                        background: "var(--surface-0, transparent)",
                        border: "0.5px solid var(--border)",
                      }}
                    >
                      {ITEM_STATUS_LABELS[item.status]}
                    </span>
                  </td>
                  <td style={{ padding: "8px" }}>{item.purchase_date ?? "-"}</td>
                  <td style={{ padding: "8px", whiteSpace: "normal", overflowWrap: "break-word" }}>
                    {item.sale_item_title ?? "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filteredItems.length === 0 && (
            <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 12 }}>
              {hasActiveFilters ? "絞り込み条件に一致する商品がありません" : "商品がありません"}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
