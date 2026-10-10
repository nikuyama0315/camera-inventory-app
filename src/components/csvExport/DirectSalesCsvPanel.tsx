import { useEffect, useMemo, useState } from "react";
import { ITEM_STATUS_LABELS, type ItemStatus } from "../../lib/types";
import { runHis50sListingCheck } from "../../lib/api/ebaySync";
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
  /**
   * 2026-09-27追加(ユーザー指示): ステータス条件をもう1つ追加し、statusとstatus2の両方に値が
   * 設定されている場合は「いずれかに一致(OR)」で絞り込む(例: 「検品済・出品待ち」または「出品中」)。
   * この「ステータス」条件全体は、カテゴリ・仕入日等の他の絞り込み条件とはAND(かつ)で組み合わされる。
   */
  status2: ItemStatus | "not_sold" | "";
  purchaseDateFrom: string;
  purchaseDateTo: string;
}

const EMPTY_FILTERS: Filters = {
  managementNo: "",
  brandModel: "",
  category: "",
  status: "",
  status2: "",
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
  /**
   * 2026-10-10追加(ユーザー指示): 「出品中のアイテムは除外する」チェックボックス。ONのとき、直販プラットフォーム
   * (his50s.com)で現在公開中(status='published')の出品と管理番号(=his50s側のexternal_id)で突合し、
   * 一致するアイテムを一覧・CSV出力の対象から除外する。ONにした時点でhis50sから最新の公開中一覧を取得する。
   */
  const [excludeListed, setExcludeListed] = useState(false);
  const [listedManagementNos, setListedManagementNos] = useState<Set<string>>(new Set());
  const [listedLoading, setListedLoading] = useState(false);
  const [listedError, setListedError] = useState<string | null>(null);
  const [listedFetchedAt, setListedFetchedAt] = useState<Date | null>(null);

  /** his50sの公開中の出品の管理番号一覧を取得する(既存の「直販PF-アプリ同期チェック」と同じEdge Functionを利用)。 */
  async function fetchListedManagementNos(): Promise<boolean> {
    setListedLoading(true);
    setListedError(null);
    try {
      // his50s側の公開中一覧はshopIdに依存しない(shopIdはアプリ側の突合対象を絞るだけ)。公開中の出品は
      // 「アプリ側と一致したもの(matched)」か「一致しなかったもの(his50sOnly)」のどちらかに必ず入るため、
      // 両方の管理番号を合わせると公開中の全件になる。
      const result = await runHis50sListingCheck("soulcamera");
      const nos = new Set<string>();
      for (const row of result.matched) nos.add(row.managementNo);
      for (const row of result.his50sOnly) nos.add(row.externalId);
      setListedManagementNos(nos);
      setListedFetchedAt(new Date());
      return true;
    } catch (err) {
      setListedError(err instanceof Error ? err.message : "his50sの公開中一覧の取得に失敗しました");
      return false;
    } finally {
      setListedLoading(false);
    }
  }

  async function handleExcludeListedChange(checked: boolean) {
    if (!checked) {
      setExcludeListed(false);
      setListedError(null);
      return;
    }
    // 取得に失敗した状態でONのままにすると「除外されていないのに除外したつもり」になるため、失敗時はONにしない。
    const ok = await fetchListedManagementNos();
    setExcludeListed(ok);
  }

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
      const statusConditions = [filters.status, filters.status2].filter(
        (v): v is ItemStatus | "not_sold" => v !== "",
      );
      if (statusConditions.length > 0) {
        const matchesAny = statusConditions.some((v) =>
          v === "not_sold" ? item.status !== "sold" : item.status === v,
        );
        if (!matchesAny) return false;
      }
      if (filters.purchaseDateFrom && (!item.purchase_date || item.purchase_date < filters.purchaseDateFrom)) {
        return false;
      }
      if (filters.purchaseDateTo && (!item.purchase_date || item.purchase_date > filters.purchaseDateTo)) {
        return false;
      }
      if (excludeListed && item.management_no && listedManagementNos.has(item.management_no)) return false;
      return true;
    });
  }, [items, filters, excludeListed, listedManagementNos]);

  /** 「出品中は除外」がONのとき、他の絞り込み条件には合うが出品中のため除外された件数(表示用)。 */
  const excludedListedCount = useMemo(() => {
    if (!excludeListed) return 0;
    return items.filter((item) => item.management_no && listedManagementNos.has(item.management_no)).length;
  }, [items, excludeListed, listedManagementNos]);

  const hasActiveFilters = Object.values(filters).some((v) => v !== "") || excludeListed;

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

  // 「出品中は除外」がONのとき、選択済みでも出品中のアイテムはCSV対象に含めない(チェック後にONにした場合の保険)。
  const exportTargetItems = useMemo(
    () =>
      items.filter(
        (item) =>
          selectedIds.has(item.id) &&
          !(excludeListed && item.management_no && listedManagementNos.has(item.management_no)),
      ),
    [items, selectedIds, excludeListed, listedManagementNos],
  );
  const selectedCount = exportTargetItems.length;
  const allFilteredSelected = filteredItems.length > 0 && filteredItems.every((item) => selectedIds.has(item.id));

  function handleExportCsv() {
    const selectedItems = exportTargetItems;
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
          <label style={{ fontSize: 11, color: "var(--text-secondary)" }}>ステータス(いずれかに一致)</label>
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
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
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>または</span>
            <select
              value={filters.status2}
              onChange={(e) => updateFilter("status2", e.target.value as ItemStatus | "not_sold" | "")}
            >
              <option value="">(指定なし)</option>
              <option value="not_sold">販売済み以外</option>
              {STATUS_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
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
          <label style={{ fontSize: 11, color: "var(--text-secondary)" }}>直販プラットフォーム</label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12 }}>
            <input
              type="checkbox"
              checked={excludeListed}
              disabled={listedLoading}
              onChange={(e) => void handleExcludeListedChange(e.target.checked)}
            />
            出品中のアイテムは除外する
          </label>
        </div>
        {hasActiveFilters && (
          <button
            onClick={() => {
              setFilters(EMPTY_FILTERS);
              setExcludeListed(false);
              setListedError(null);
            }}
            style={{ fontSize: 12, padding: "4px 10px" }}
          >
            絞り込みをクリア
          </button>
        )}
        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          {filteredItems.length}件 / 全{items.length}件
        </span>
      </div>
      {(listedLoading || listedError || excludeListed) && (
        <p
          style={{
            fontSize: 12,
            margin: "0 0 8px",
            color: listedError ? "var(--danger-text)" : "var(--text-secondary)",
          }}
        >
          {listedLoading
            ? "his50sの公開中の出品を取得中です…"
            : listedError
              ? `${listedError}(「出品中のアイテムは除外する」はOFFのままです)`
              : `his50sで公開中の出品を管理番号で突合し、${excludedListedCount}件を除外しています` +
                `(公開中${listedManagementNos.size}件、取得: ${listedFetchedAt ? listedFetchedAt.toLocaleTimeString("ja-JP") : "-"})`}
        </p>
      )}

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
          disabled={selectedCount === 0 || listedLoading}
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
              {filteredItems.map((item, rowIndex) => (
                <tr
                  key={item.id}
                  onClick={() => toggleSelect(item.id)}
                  style={{
                    borderTop: "0.5px solid var(--border)",
                    cursor: "pointer",
                    background: rowIndex % 2 === 1 ? "var(--surface-1)" : undefined,
                  }}
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
