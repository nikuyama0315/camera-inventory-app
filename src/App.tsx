import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabaseClient";
import InventoryPage from "./pages/InventoryPage";
import LoginPage from "./pages/LoginPage";
import ExpensesPage from "./pages/ExpensesPage";
import ImportPage from "./pages/ImportPage";
import ExportPage from "./pages/ExportPage";
import StockAlertsPage from "./pages/StockAlertsPage";
import SkuLookupPage from "./pages/SkuLookupPage";
import AccountSecurityPage from "./pages/AccountSecurityPage";
import SalesPage from "./pages/SalesPage";
import LedgerImportPage from "./pages/LedgerImportPage";
import ExchangeRatePage from "./pages/ExchangeRatePage";
import EventLogPage from "./pages/EventLogPage";
import TodoPage from "./pages/TodoPage";
import { checkStockAlertsAndNotify, fetchModelStockOverview, type ModelStockRow } from "./lib/api/stockAlerts";
import { fetchMonthlyImportStatus, reportImportRowHasAlert } from "./lib/api/reportImports";
import logo from "./assets/logo.png";

type Tab = "inventory" | "sales" | "stockAlerts" | "skuLookup" | "expenses" | "exchangeRate" | "import" | "export" | "eventLog" | "ledgerImport";

const TABS: { key: Tab; label: string }[] = [
  { key: "inventory", label: "仕入・在庫・販売" },
  { key: "sales", label: "売上・粗利" },
  { key: "expenses", label: "経費" },
  { key: "skuLookup", label: "SKU検索" },
  { key: "stockAlerts", label: "在庫アラート" },
  { key: "import", label: "レポート取込" },
  { key: "export", label: "データ作成" },
  { key: "exchangeRate", label: "為替" },
  { key: "eventLog", label: "イベントログ" },
];

// 2026-09-09追加: ポータル統合(ebay-automationと同一オリジン)で「マーケティング →」
// 「← 販売管理」を行き来した際、それぞれ前に見ていた画面へ戻れるようにする。
// このアプリはSPAで単一URLのため、直前のタブをlocalStorageに保存・復元する
// (ebay-automation側はページ遷移そのものなので、直前のURLをlocalStorageに保存し、
// こちらの「マーケティング →」リンクがその値を読んで遷移先にする)。
const SALES_LAST_TAB_KEY = "soulmen_portal_sales_last_tab";
const MARKETING_LAST_PATH_KEY = "soulmen_portal_marketing_last_path";
const TAB_KEYS = TABS.map((t) => t.key);

function loadInitialTab(): Tab {
  try {
    const saved = localStorage.getItem(SALES_LAST_TAB_KEY);
    if (saved && (TAB_KEYS as string[]).includes(saved)) return saved as Tab;
  } catch {
    /* localStorageが使えない環境では既定値にフォールバック */
  }
  return "inventory";
}

function loadMarketingHref(): string {
  try {
    return localStorage.getItem(MARKETING_LAST_PATH_KEY) || "/marketing/";
  } catch {
    return "/marketing/";
  }
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checked, setChecked] = useState(false);
  const [tab, setTab] = useState<Tab>(loadInitialTab);
  const [belowThresholdRows, setBelowThresholdRows] = useState<ModelStockRow[]>([]);
  const [alertDismissed, setAlertDismissed] = useState(false);
  const [reportImportAlertCount, setReportImportAlertCount] = useState(0);
  const [reportImportAlertDismissed, setReportImportAlertDismissed] = useState(false);
  const [showAccountSecurity, setShowAccountSecurity] = useState(false);
  const [marketingHref, setMarketingHref] = useState(loadMarketingHref);

  // タブを切り替えるたびに保存し、次回このアプリを開いたとき(マーケティング側から
  // 戻ってきたときを含む)に復元できるようにする。
  useEffect(() => {
    try {
      localStorage.setItem(SALES_LAST_TAB_KEY, tab);
    } catch {
      /* localStorageが使えない環境では保存を諦める(タブ切替自体は継続) */
    }
  }, [tab]);

  // マーケティング側で最後に見ていたページを、ウィンドウにフォーカスが戻るたびに
  // 読み直す(このタブで「マーケティング →」を押して戻ってきた直後に反映するため)。
  useEffect(() => {
    function refreshMarketingHref() {
      setMarketingHref(loadMarketingHref());
    }
    window.addEventListener("focus", refreshMarketingHref);
    return () => window.removeEventListener("focus", refreshMarketingHref);
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setChecked(true);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      // ログアウト時、次回ログイン後に前回開いていた画面(ログイン情報再設定)が
      // そのまま残らないようリセットする(実機テストで発見)。
      if (!newSession) setShowAccountSecurity(false);
    });

    return () => {
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!session) return;
    fetchModelStockOverview()
      .then((rows) => setBelowThresholdRows(rows.filter((r) => r.belowThreshold)))
      .catch(() => {
        /* バナー表示のための取得失敗は致命的でないため無視 */
      });
    // ログイン中のセッションでアプリを開くたびに、しきい値割れをチェックしてGmail通知する
    // (Gmail用シークレット未設定の場合はエラーになるが、画面上のバナー表示には影響しない)
    checkStockAlertsAndNotify().catch(() => {
      /* メール送信設定が未完了の場合は静かに失敗させる */
    });
    // レポート取込(ImportPage.tsxの「取込状況」)で、前月分が当月7日を過ぎても未取込のレポートが
    // 1件でもあれば全ページ共通バナーで知らせる(2026-09-08追加、在庫アラートバナーと同じ方式。
    // 2026-09-09修正: 各レポートは月が閉まってから翌月7日頃までに提供されるため、判定対象は
    // 「当月分」ではなく「前月分」)。
    fetchMonthlyImportStatus()
      .then((rows) => setReportImportAlertCount(rows.filter((r) => reportImportRowHasAlert(r)).length))
      .catch(() => {
        /* バナー表示のための取得失敗は致命的でないため無視 */
      });
  }, [session]);

  if (!checked) {
    return null;
  }

  if (!session) {
    return <LoginPage onLoggedIn={() => {}} />;
  }

  // ヘッダーの「To Do →」ボタンから新規ウィンドウ(?view=todo)で開かれた場合は、
  // 通常のタブ画面ではなくTo Doリスト単体ページを描画する(2026-09-11追加)。
  if (new URLSearchParams(window.location.search).get("view") === "todo") {
    return <TodoPage />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          padding: "10px 16px",
          borderBottom: "0.5px solid var(--border)",
          background: "var(--surface-2)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <img src={logo} alt="" style={{ width: 28, height: 28, borderRadius: "50%", flexShrink: 0 }} />
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
            Soulmen Japan Business Portal
          </span>
        </div>
        <a
          href="/?view=todo"
          target="soulmen_todo_window"
          rel="noopener noreferrer"
          style={{
            fontSize: 12,
            padding: "4px 10px",
            border: "0.5px solid var(--border-strong)",
            borderRadius: 6,
            background: "var(--surface-1)",
            color: "var(--text-primary)",
            textDecoration: "none",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            flexShrink: 0,
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="4" y="3" width="16" height="18" rx="2" />
            <line x1="8" y1="8" x2="16" y2="8" />
            <line x1="8" y1="12" x2="16" y2="12" />
            <line x1="8" y1="16" x2="12" y2="16" />
          </svg>
          To Do
        </a>
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "8px 16px",
          borderBottom: "0.5px solid var(--border)",
          background: "var(--surface-2)",
        }}
      >
        <div style={{ display: "flex", gap: 4 }}>
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => {
                setShowAccountSecurity(false);
                setTab(t.key);
              }}
              style={{
                border: "none",
                borderBottom: tab === t.key ? "2px solid var(--accent)" : "2px solid transparent",
                borderRadius: 0,
                background: "transparent",
                color: tab === t.key ? "var(--accent)" : "var(--text-secondary)",
                fontSize: 13,
                padding: "6px 10px",
              }}
            >
              {t.label}
              {t.key === "stockAlerts" && belowThresholdRows.length > 0 && (
                <span
                  style={{
                    marginLeft: 6,
                    fontSize: 11,
                    padding: "1px 6px",
                    borderRadius: 999,
                    background: "var(--danger-bg)",
                    color: "var(--danger-text)",
                  }}
                >
                  {belowThresholdRows.length}
                </span>
              )}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <a
            href={marketingHref}
            style={{
              fontSize: 12,
              padding: "4px 10px",
              border: "0.5px solid var(--border-strong)",
              borderRadius: 6,
              background: "var(--surface-2)",
              color: "var(--text-primary)",
              textDecoration: "none",
              display: "inline-flex",
              alignItems: "center",
            }}
          >
            マーケティング →
          </a>
          <button
            onClick={() => setShowAccountSecurity(true)}
            style={{ fontSize: 12, padding: "4px 10px" }}
          >
            ログイン情報再設定
          </button>
          <button onClick={() => supabase.auth.signOut()} style={{ fontSize: 12, padding: "4px 10px" }}>
            ログアウト
          </button>
        </div>
      </div>

      {belowThresholdRows.length > 0 && tab !== "stockAlerts" && !alertDismissed && (
        <div
          style={{
            padding: "8px 16px",
            background: "var(--danger-bg)",
            borderBottom: "0.5px solid var(--danger-text)",
            fontSize: 12,
            color: "var(--danger-text)",
          }}
        >
          {belowThresholdRows.length}機種の在庫数がしきい値を下回っています
          <button
            onClick={() => setTab("stockAlerts")}
            style={{ fontSize: 11, padding: "1px 8px", marginLeft: 8 }}
          >
            確認する
          </button>
          <button
            onClick={() => setAlertDismissed(true)}
            style={{ fontSize: 11, padding: "1px 8px", marginLeft: 4 }}
          >
            隠す
          </button>
        </div>
      )}

      {reportImportAlertCount > 0 && tab !== "import" && !reportImportAlertDismissed && (
        <div
          style={{
            padding: "8px 16px",
            background: "var(--danger-bg)",
            borderBottom: "0.5px solid var(--danger-text)",
            fontSize: 12,
            color: "var(--danger-text)",
          }}
        >
          未取込みの月次レポートがあります
          <button
            onClick={() => setTab("import")}
            style={{ fontSize: 11, padding: "1px 8px", marginLeft: 8 }}
          >
            確認する
          </button>
          <button
            onClick={() => setReportImportAlertDismissed(true)}
            style={{ fontSize: 11, padding: "1px 8px", marginLeft: 4 }}
          >
            隠す
          </button>
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        {showAccountSecurity ? (
          <AccountSecurityPage onBack={() => setShowAccountSecurity(false)} />
        ) : (
          <>
            {tab === "inventory" && <InventoryPage />}
            {tab === "sales" && <SalesPage />}
            {tab === "stockAlerts" && <StockAlertsPage />}
            {tab === "expenses" && <ExpensesPage />}
            {tab === "exchangeRate" && <ExchangeRatePage />}
            {tab === "skuLookup" && <SkuLookupPage />}
            {tab === "import" && <ImportPage />}
            {tab === "export" && <ExportPage />}
            {tab === "eventLog" && <EventLogPage />}
            {tab === "ledgerImport" && <LedgerImportPage />}
          </>
        )}
      </div>

      <div
        style={{
          borderTop: "0.5px solid var(--border)",
          padding: "8px 16px",
          textAlign: "center",
          fontSize: 11,
          color: "var(--text-muted)",
          flexShrink: 0,
        }}
      >
        Copyright © 2026 Soulmen, Inc.
      </div>
    </div>
  );
}
