import { useMemo, useState } from "react";
import { EBAY_ACCOUNT_LABELS, EBAY_ACCOUNT_OPTIONS, ITEM_STATUS_LABELS, type ItemStatus } from "../../lib/types";
import { deleteItem, updateItemBasicInfo, updateItemStatus, type ItemWithPurchase } from "../../lib/api/items";
import { computeDriveLocalPath, SOURCE_TYPE_OPTIONS } from "../../lib/constants";

interface Props {
  items: ItemWithPurchase[];
  loading: boolean;
  errorMessage: string | null;
  onSelectItem: (itemId: string) => void;
  /** ステータス・カテゴリをこの一覧上のプルダウンから直接修正した後、呼び出し元に一覧の再取得を促す。 */
  onItemChanged?: () => void | Promise<void>;
}

type SortColumn =
  | "management_no"
  | "account"
  | "status"
  | "sales_record_reference"
  | "category"
  | "brand_model"
  | "purchase_date"
  | "source_name"
  | "seller_name"
  | "title"
  | "sale_date"
  | "sale_item_title"
  | "tracking_info";
type SortDirection = "asc" | "desc";

// 表示順: 管理番号 ステータス Sales# カテゴリ ブランド/機種 仕入日 仕入先 出品者名 仕入品名 (仕入高) 販売日 販売アイテム名 (フォルダ)
// 仕入高・フォルダはソート対象外の静的列のため、COLUMNS_BEFORE_PRICE / COLUMNS_AFTER_PRICE に分けてヘッダーに個別配置する。
const COLUMNS_BEFORE_PRICE: { key: SortColumn; label: string }[] = [
  { key: "management_no", label: "管理番号" },
  { key: "account", label: "アカウント" },
  { key: "status", label: "ステータス" },
  { key: "sales_record_reference", label: "Sales #" },
  { key: "category", label: "カテゴリ" },
  { key: "brand_model", label: "ブランド/機種" },
  { key: "purchase_date", label: "仕入日" },
  { key: "source_name", label: "仕入先" },
  { key: "seller_name", label: "出品者名" },
  { key: "title", label: "仕入品名" },
];

const COLUMNS_AFTER_PRICE: { key: SortColumn; label: string }[] = [
  { key: "sale_date", label: "販売日" },
  { key: "sale_item_title", label: "販売アイテム名" },
  { key: "tracking_info", label: "追跡番号" },
];

const SOURCE_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  SOURCE_TYPE_OPTIONS.map((o) => [o.value, o.label]),
);

/** 「仕入先/仕入先2」形式で表示する(仕入先=source_typeのラベル、仕入先2=source_name)。いずれか片方のみでもスラッシュ無しで表示。 */
function formatSourceDisplay(item: ItemWithPurchase): string {
  const sourceTypeLabel = item.source_type ? (SOURCE_TYPE_LABELS[item.source_type] ?? item.source_type) : null;
  return [sourceTypeLabel, item.source_name].filter(Boolean).join("/");
}

function sortValue(item: ItemWithPurchase, column: SortColumn): string {
  switch (column) {
    case "management_no":
      return item.management_no ?? "";
    case "account":
      return item.account ?? "";
    case "brand_model":
      return [item.brand, item.model].filter(Boolean).join(" ");
    case "category":
      return item.category ?? "";
    case "status":
      return ITEM_STATUS_LABELS[item.status] ?? "";
    case "purchase_date":
      return item.purchase_date ?? "";
    case "source_name":
      return formatSourceDisplay(item);
    case "seller_name":
      return item.source_name ?? "";
    case "title":
      return item.title ?? "";
    case "sale_date":
      return item.sale_date ?? "";
    case "sale_item_title":
      return item.sale_item_title ?? "";
    case "sales_record_reference":
      return item.sales_record_reference ?? "";
    case "tracking_info":
      return item.tracking_info ?? "";
  }
}

interface FolderLink {
  url: string;
  title: string;
}

/**
 * Windowsのフルパス(バックスラッシュ区切り)を、独自プロトコル openfolder:// のURLに変換する。
 * ブラウザの file:// リンクではWindowsのエクスプローラーを直接起動できない(ブラウザ内蔵の
 * ファイル一覧表示になってしまう)ため、各PCにインストールする openfolder:// ハンドラ経由で
 * エクスプローラーを起動する方式にしている。
 * 例: "G:\\マイドライブ\\Foo\\Bar\\" → "openfolder://G/%E3%83%9E...%2FFoo/Bar/"
 * 先頭のドライブ文字(例: G)はそのまま、それ以外の各階層名はURLエンコードする。
 */
function windowsPathToOpenFolderUrl(windowsPath: string): string {
  const segments = windowsPath.split("\\").filter(Boolean);
  if (segments.length === 0) return "";
  const [driveWithColon, ...rest] = segments;
  const drive = driveWithColon.replace(/:$/, "");
  return `openfolder://${drive}/${rest.map((s) => encodeURIComponent(s)).join("/")}/`;
}

/**
 * 商品のフォルダへのリンクを組み立てる。
 * 機種名フォルダ・商品フォルダの名前から、Googleドライブが同期されているローカルのWindowsパス(DRIVE_BASE_PATH配下)を
 * 組み立て、openfolder:// 経由でWindowsのエクスプローラーでそのフォルダを開く。
 */
function getFolderLink(item: ItemWithPurchase): FolderLink | null {
  // 2026-09-05バグ修正(ユーザー報告「フォルダを開くを押すとドキュメントフォルダが開かれてしまう」):
  // 以前は常にDRIVE_BASE_PATH(検品済・出品待ちステージ)を使ってパスを組み立てていたが、商品が
  // 出品中・販売済みステージへ進むとmove-drive-folderによりGoogle Drive上の実フォルダは別の場所へ
  // 移動され(かつ機種名フォルダを介さないフラット配置になる)、item_drive_folders.model_folder_name等は
  // その移動時に更新されず古い値のまま残る。そのため常にDRIVE_BASE_PATH+機種名フォルダで組み立てると、
  // 出品中・販売済みの商品では実在しないパスが生成され、エクスプローラーが解決できずドキュメント等の
  // 既定フォルダにフォールバックしていた。drive_current_stage(現在の実際のステージ)に応じて正しい
  // ベースパスを選ぶcomputeDriveLocalPathを使うよう修正。
  const fullPath = computeDriveLocalPath(item.drive_current_stage, item.drive_model_folder_name, item.drive_item_folder_name);
  if (!fullPath) return null;
  return {
    url: windowsPathToOpenFolderUrl(fullPath),
    title: fullPath,
  };
}

// テーブル内絞り込み用のstate(2026-08-31追加)。管理番号・ブランド/機種はテキスト部分一致、
// カテゴリ・ステータスはプルダウン完全一致、仕入日・販売日はfrom/toの範囲指定。
interface TableFilters {
  managementNo: string;
  brandModel: string;
  category: string;
  /** ""=すべて, "unset"=未設定(null)のみ, それ以外はEbayAccountの値と完全一致 */
  account: string;
  /** "not_sold" はステータスが"sold"(販売済み)以外の全件を対象とする特殊な絞り込み条件。
   *  "sold_missing_shipping_tracking"は、ステータスが"sold"かつ送料支払額未入力(0/未設定)か
   *  追跡番号未入力のものを対象とする特殊な絞り込み条件(2026-09-10追加、ユーザー指示)。 */
  status: ItemStatus | "not_sold" | "sold_missing_shipping_tracking" | "";
  purchaseDateFrom: string;
  purchaseDateTo: string;
  saleDateFrom: string;
  saleDateTo: string;
  /** 仕入先種別(purchases.source_type、SOURCE_TYPE_OPTIONSの値)との完全一致。2026-09-03追加。 */
  sourceType: string;
  /** 仕入先・出品者名(purchases.source_name)のテキスト部分一致。2026-09-03追加。 */
  sourceName: string;
  /** 仕入品名(items.title)のテキスト部分一致。2026-09-03追加。 */
  purchaseItemName: string;
  /** 追跡番号(items.tracking_info、sales.tracking_info由来)のテキスト部分一致。2026-09-06追加。 */
  trackingNumber: string;
}

const EMPTY_FILTERS: TableFilters = {
  managementNo: "",
  brandModel: "",
  category: "",
  account: "",
  status: "",
  purchaseDateFrom: "",
  purchaseDateTo: "",
  saleDateFrom: "",
  saleDateTo: "",
  sourceType: "",
  sourceName: "",
  purchaseItemName: "",
  trackingNumber: "",
};

const STATUS_OPTIONS = Object.entries(ITEM_STATUS_LABELS) as [ItemStatus, string][];

export default function ItemTableView({ items, loading, errorMessage, onSelectItem, onItemChanged }: Props) {
  const [sortColumn, setSortColumn] = useState<SortColumn | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [filters, setFilters] = useState<TableFilters>(EMPTY_FILTERS);
  // 一覧上でステータス・カテゴリをプルダウン編集する際の保存中item・エラー表示用(2026-09-02追加)。
  const [savingItemId, setSavingItemId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  // 削除中の商品ID(2026-09-06追加、削除ボタンの多重クリック防止用。savingItemIdとは別管理にし、
  // プルダウン保存中の行と削除中の行が誤って混同されないようにしている)。
  const [deletingItemId, setDeletingItemId] = useState<string | null>(null);

  /** ステータス列のプルダウンから直接変更する(通常のステータス遷移用アクションではなく、手動修正用のupdateItemStatusを使用)。 */
  async function handleStatusChange(item: ItemWithPurchase, newStatus: ItemStatus) {
    if (newStatus === item.status) return;
    setSavingItemId(item.id);
    setRowError(null);
    try {
      await updateItemStatus(item.id, newStatus);
      await onItemChanged?.();
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "ステータスの更新に失敗しました");
    } finally {
      setSavingItemId(null);
    }
  }

  /** カテゴリ列のプルダウンから直接変更する。 */
  async function handleCategoryChange(item: ItemWithPurchase, newCategory: string) {
    if (newCategory === item.category) return;
    setSavingItemId(item.id);
    setRowError(null);
    try {
      await updateItemBasicInfo(item.id, { category: newCategory });
      await onItemChanged?.();
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "カテゴリの更新に失敗しました");
    } finally {
      setSavingItemId(null);
    }
  }

  /** アカウント列のプルダウンから直接変更する(2026-09-02追加、eBayアカウント区分)。 */
  async function handleAccountChange(item: ItemWithPurchase, newAccount: string) {
    const normalized = newAccount || null;
    if (normalized === item.account) return;
    setSavingItemId(item.id);
    setRowError(null);
    try {
      await updateItemBasicInfo(item.id, { account: normalized });
      await onItemChanged?.();
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "アカウントの更新に失敗しました");
    } finally {
      setSavingItemId(null);
    }
  }

  /** 「削除」ボタン(2026-09-06追加)。確認のうえdeleteItem()を呼び、一覧を再取得する。 */
  async function handleDeleteItem(item: ItemWithPurchase) {
    const label = `${item.management_no}${item.title ? ` / ${item.title}` : ""}`;
    if (
      !window.confirm(
        `商品「${label}」を削除します。この商品に紐づく仕入・検品・売上・Google Driveフォルダ連携情報もあわせて削除されます(eBay取引データ自体は削除されず、未登録の状態に戻ります)。この操作は取り消せません。よろしいですか?`,
      )
    ) {
      return;
    }
    setDeletingItemId(item.id);
    setRowError(null);
    try {
      await deleteItem(item.id);
      await onItemChanged?.();
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "削除に失敗しました");
    } finally {
      setDeletingItemId(null);
    }
  }

  function handleHeaderClick(column: SortColumn) {
    if (sortColumn === column) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortColumn(column);
      setSortDirection("asc");
    }
  }

  function updateFilter<K extends keyof TableFilters>(key: K, value: TableFilters[K]) {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  // この一覧に実際に存在するカテゴリ値からプルダウンの選択肢を組み立てる
  // (カテゴリは固定の列挙型ではなく自由入力のため、決め打ちの選択肢リストは持たない)
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
    const sourceNameQuery = filters.sourceName.trim().toLowerCase();
    const purchaseItemNameQuery = filters.purchaseItemName.trim().toLowerCase();
    const trackingNumberQuery = filters.trackingNumber.trim().toLowerCase();
    return items.filter((item) => {
      if (managementNoQuery && !(item.management_no ?? "").toLowerCase().includes(managementNoQuery)) {
        return false;
      }
      if (brandModelQuery) {
        const brandModel = [item.brand, item.model].filter(Boolean).join(" ").toLowerCase();
        if (!brandModel.includes(brandModelQuery)) return false;
      }
      if (filters.sourceType && item.source_type !== filters.sourceType) return false;
      if (sourceNameQuery && !(item.source_name ?? "").toLowerCase().includes(sourceNameQuery)) {
        return false;
      }
      if (purchaseItemNameQuery && !(item.title ?? "").toLowerCase().includes(purchaseItemNameQuery)) {
        return false;
      }
      if (trackingNumberQuery && !(item.tracking_info ?? "").toLowerCase().includes(trackingNumberQuery)) {
        return false;
      }
      if (filters.category && item.category !== filters.category) return false;
      if (filters.account === "unset") {
        if (item.account) return false;
      } else if (filters.account && item.account !== filters.account) {
        return false;
      }
      if (filters.status === "not_sold") {
        if (item.status === "sold") return false;
      } else if (filters.status === "sold_missing_shipping_tracking") {
        if (item.status !== "sold") return false;
        const shippingMissing = !item.shipping_cost_paid;
        const trackingMissing = !item.tracking_info;
        if (!shippingMissing && !trackingMissing) return false;
      } else if (filters.status && item.status !== filters.status) {
        return false;
      }
      if (filters.purchaseDateFrom && (!item.purchase_date || item.purchase_date < filters.purchaseDateFrom)) {
        return false;
      }
      if (filters.purchaseDateTo && (!item.purchase_date || item.purchase_date > filters.purchaseDateTo)) {
        return false;
      }
      if (filters.saleDateFrom && (!item.sale_date || item.sale_date < filters.saleDateFrom)) {
        return false;
      }
      if (filters.saleDateTo && (!item.sale_date || item.sale_date > filters.saleDateTo)) {
        return false;
      }
      return true;
    });
  }, [items, filters]);

  const sortedItems = useMemo(() => {
    if (!sortColumn) return filteredItems;
    const sorted = [...filteredItems].sort((a, b) => {
      const va = sortValue(a, sortColumn);
      const vb = sortValue(b, sortColumn);
      // 空欄は常に末尾に置く(昇順・降順にかかわらず)
      if (!va && !vb) return 0;
      if (!va) return 1;
      if (!vb) return -1;
      return va < vb ? -1 : va > vb ? 1 : 0;
    });
    if (sortDirection === "desc") sorted.reverse();
    return sorted;
  }, [filteredItems, sortColumn, sortDirection]);

  const totalPurchasePrice = useMemo(
    () => filteredItems.reduce((sum, item) => sum + (item.purchase_price ?? 0), 0),
    [filteredItems],
  );

  const hasActiveFilters = Object.values(filters).some((v) => v !== "");

  if (errorMessage) {
    return <p style={{ color: "var(--danger-text)", fontSize: 13, padding: "1rem 1.5rem" }}>{errorMessage}</p>;
  }
  if (loading) {
    return <p style={{ fontSize: 13, color: "var(--text-secondary)", padding: "1rem 1.5rem" }}>読み込み中...</p>;
  }

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "1rem 1.5rem", paddingBottom: "3rem", boxSizing: "border-box" }}>
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
          background: "var(--surface-1)",
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
          <label style={{ fontSize: 11, color: "var(--text-secondary)" }}>アカウント</label>
          <select value={filters.account} onChange={(e) => updateFilter("account", e.target.value)}>
            <option value="">すべて</option>
            <option value="unset">未設定</option>
            {EBAY_ACCOUNT_OPTIONS.map((a) => (
              <option key={a} value={a}>
                {EBAY_ACCOUNT_LABELS[a]}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <label style={{ fontSize: 11, color: "var(--text-secondary)" }}>ステータス</label>
          <select
            value={filters.status}
            onChange={(e) =>
              updateFilter(
                "status",
                e.target.value as ItemStatus | "not_sold" | "sold_missing_shipping_tracking" | "",
              )
            }
          >
            <option value="">すべて</option>
            <option value="not_sold">販売済み以外</option>
            <option value="sold_missing_shipping_tracking">販売済・送料/追跡情報未入力</option>
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
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <label style={{ fontSize: 11, color: "var(--text-secondary)" }}>仕入先</label>
          <select value={filters.sourceType} onChange={(e) => updateFilter("sourceType", e.target.value)}>
            <option value="">すべて</option>
            {SOURCE_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <label style={{ fontSize: 11, color: "var(--text-secondary)" }}>出品者名</label>
          <input
            type="text"
            placeholder="部分一致"
            value={filters.sourceName}
            onChange={(e) => updateFilter("sourceName", e.target.value)}
            style={{ width: 140 }}
          />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <label style={{ fontSize: 11, color: "var(--text-secondary)" }}>仕入品名</label>
          <input
            type="text"
            placeholder="部分一致"
            value={filters.purchaseItemName}
            onChange={(e) => updateFilter("purchaseItemName", e.target.value)}
            style={{ width: 160 }}
          />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <label style={{ fontSize: 11, color: "var(--text-secondary)" }}>販売日</label>
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input
              type="date"
              value={filters.saleDateFrom}
              onChange={(e) => updateFilter("saleDateFrom", e.target.value)}
            />
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>〜</span>
            <input
              type="date"
              value={filters.saleDateTo}
              onChange={(e) => updateFilter("saleDateTo", e.target.value)}
            />
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <label style={{ fontSize: 11, color: "var(--text-secondary)" }}>追跡番号</label>
          <input
            type="text"
            placeholder="部分一致"
            value={filters.trackingNumber}
            onChange={(e) => updateFilter("trackingNumber", e.target.value)}
            style={{ width: 160 }}
          />
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

      {rowError && (
        <p style={{ color: "var(--danger-text)", fontSize: 12, marginBottom: 8 }}>{rowError}</p>
      )}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse", whiteSpace: "nowrap", tableLayout: "fixed" }}>
          <colgroup>
            <col style={{ width: "6%" }} />
            <col style={{ width: "6%" }} />
            <col style={{ width: "6%" }} />
            <col style={{ width: "6%" }} />
            <col style={{ width: "7%" }} />
            <col style={{ width: "7%" }} />
            <col style={{ width: "7%" }} />
            <col style={{ width: "7%" }} />
            <col style={{ width: "7%" }} />
            <col style={{ width: "8%" }} />
            <col style={{ width: "7%" }} />
            <col style={{ width: "6%" }} />
            <col style={{ width: "7%" }} />
            <col style={{ width: "8%" }} />
            <col style={{ width: "7%" }} />
            <col style={{ width: "5%" }} />
          </colgroup>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-secondary)" }}>
              {COLUMNS_BEFORE_PRICE.map((col) => (
                <th
                  key={col.key}
                  onClick={() => handleHeaderClick(col.key)}
                  style={{ padding: "6px 8px", cursor: "pointer", userSelect: "none" }}
                >
                  {col.label}
                  {sortColumn === col.key && (sortDirection === "asc" ? " ▲" : " ▼")}
                </th>
              ))}
              <th style={{ padding: "6px 8px", textAlign: "right" }}>
                <div>仕入高</div>
                <div style={{ fontSize: 11, fontWeight: 400 }}>
                  （合計：{totalPurchasePrice.toLocaleString()}円）
                </div>
              </th>
              {COLUMNS_AFTER_PRICE.map((col) => (
                <th
                  key={col.key}
                  onClick={() => handleHeaderClick(col.key)}
                  style={{ padding: "6px 8px", cursor: "pointer", userSelect: "none" }}
                >
                  {col.label}
                  {sortColumn === col.key && (sortDirection === "asc" ? " ▲" : " ▼")}
                </th>
              ))}
              <th style={{ padding: "6px 8px" }}>フォルダ</th>
              <th style={{ padding: "6px 8px" }}>削除</th>
            </tr>
          </thead>
          <tbody>
            {sortedItems.map((item) => (
              <tr
                key={item.id}
                onClick={() => onSelectItem(item.id)}
                style={{ borderTop: "0.5px solid var(--border)", cursor: "pointer" }}
              >
                <td style={{ padding: "8px", fontWeight: 500 }}>{item.management_no}</td>
                <td style={{ padding: "8px" }} onClick={(e) => e.stopPropagation()}>
                  <select
                    value={item.account ?? ""}
                    disabled={savingItemId === item.id}
                    onChange={(e) => void handleAccountChange(item, e.target.value)}
                    style={{ fontSize: 11, padding: "2px 4px", maxWidth: "100%" }}
                  >
                    <option value="">未設定</option>
                    {EBAY_ACCOUNT_OPTIONS.map((a) => (
                      <option key={a} value={a}>
                        {EBAY_ACCOUNT_LABELS[a]}
                      </option>
                    ))}
                  </select>
                </td>
                <td style={{ padding: "8px" }} onClick={(e) => e.stopPropagation()}>
                  <select
                    value={item.status}
                    disabled={savingItemId === item.id}
                    onChange={(e) => void handleStatusChange(item, e.target.value as ItemStatus)}
                    style={{ fontSize: 11, padding: "2px 4px", maxWidth: "100%" }}
                  >
                    {STATUS_OPTIONS.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </td>
                <td style={{ padding: "8px" }}>{item.sales_record_reference ?? "-"}</td>
                <td style={{ padding: "8px" }} onClick={(e) => e.stopPropagation()}>
                  <select
                    value={item.category}
                    disabled={savingItemId === item.id}
                    onChange={(e) => void handleCategoryChange(item, e.target.value)}
                    style={{ fontSize: 11, padding: "2px 4px", maxWidth: "100%" }}
                  >
                    {categoryOptions.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </td>
                <td style={{ padding: "8px", whiteSpace: "normal", overflowWrap: "break-word" }}>
                  {[item.brand, item.model].filter(Boolean).join(" ") || "-"}
                </td>
                <td style={{ padding: "8px" }}>{item.purchase_date ?? "-"}</td>
                <td style={{ padding: "8px", whiteSpace: "normal", overflowWrap: "break-word" }}>
                  {formatSourceDisplay(item) || "-"}
                </td>
                <td style={{ padding: "8px", whiteSpace: "normal", overflowWrap: "break-word" }}>
                  {item.source_name ?? "-"}
                </td>
                <td style={{ padding: "8px", whiteSpace: "normal", overflowWrap: "break-word" }}>
                  {item.title ?? "-"}
                </td>
                <td style={{ padding: "8px", textAlign: "right" }}>
                  {item.purchase_price != null ? `¥${item.purchase_price.toLocaleString()}` : "-"}
                </td>
                <td style={{ padding: "8px" }}>{item.sale_date ?? "-"}</td>
                <td style={{ padding: "8px", whiteSpace: "normal", overflowWrap: "break-word" }}>
                  {item.sale_item_title ?? "-"}
                </td>
                <td style={{ padding: "8px" }}>{item.tracking_info ?? "-"}</td>
                <td style={{ padding: "8px" }}>
                  {(() => {
                    const link = getFolderLink(item);
                    if (!link) return "-";
                    return (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          window.open(link.url, "_blank", "noopener,noreferrer");
                        }}
                        title={link.title}
                        style={{ fontSize: 11, padding: "2px 8px" }}
                      >
                        フォルダを開く
                      </button>
                    );
                  })()}
                </td>
                <td style={{ padding: "8px" }} onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => void handleDeleteItem(item)}
                    disabled={deletingItemId === item.id}
                    style={{ fontSize: 11, padding: "2px 8px", color: "var(--danger-text)" }}
                  >
                    {deletingItemId === item.id ? "削除中..." : "削除"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {filteredItems.length === 0 && (
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 12 }}>
          {hasActiveFilters ? "絞り込み条件に一致する商品がありません" : "該当する商品がありません"}
        </p>
      )}
    </div>
  );
}
