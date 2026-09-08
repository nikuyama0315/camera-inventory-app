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
import { checkStockAlertsAndNotify, fetchModelStockOverview, type ModelStockRow } from "./lib/api/stockAlerts";
import { fetchMonthlyImportStatus, reportImportRowHasAlert } from "./lib/api/reportImports";
import logo from "./assets/logo.png";

type Tab = "inventory" | "sales" | "stockAlerts" | "skuLookup" | "expenses" | "exchangeRate" | "import" | "export" | "ledgerImport";

const TABS: { key: Tab; label: string }[] = [
  { key: "inventory", label: "在庫・販売済" },
  { key: "sales", label: "売上・粗利" },
  { key: "skuLookup", label: "SKU検索" },
  { key: "stockAlerts", label: "在庫アラート" },
  { key: "expenses", label: "経費" },
  { key: "exchangeRate", label: "為替" },
  { key: "import", label: "レポート取込" },
  { key: "export", label: "CSV出力" },
  { key: "ledgerImport", label: "台帳一括取込" },
];

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checked, setChecked] = useState(false);
  const [tab, setTab] = useState<Tab>("inventory");
  const [belowThresholdRows, setBelowThresholdRows] = useState<ModelStockRow[]>([]);
  const [alertDismissed, setAlertDismissed] = useState(false);
  const [reportImportAlertCount, setReportImportAlertCount] = useState(0);
  const [reportImportAlertDismissed, setReportImportAlertDismissed] = useState(false);
  const [showAccountSecurity, setShowAccountSecurity] = useState(false);

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
    // レポート取込(ImportPage.tsxの「取込状況」)で、当月分が7日を過ぎても未取込のレポートが
    // 1件でもあれば全ページ共通バナーで知らせる(2026-09-08追加、在庫アラートバナーと同じ方式)。
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

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 16px",
          borderBottom: "0.5px solid var(--border)",
        }}
      >
        <img src={logo} alt="" style={{ width: 28, height: 28, borderRadius: "50%", flexShrink: 0 }} />
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
          Soulmen Japan Business Portal
        </span>
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "8px 16px",
          borderBottom: "0.5px solid var(--border)",
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
            href="/marketing/"
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
          {belowThresholdRows.length}機種がしきい値を下回っています
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
          未取込みのレポートがあります
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
