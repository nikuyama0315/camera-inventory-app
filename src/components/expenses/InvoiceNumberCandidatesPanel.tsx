import { useEffect, useMemo, useState } from "react";
import {
  fetchInvoiceNumberCandidates,
  acceptInvoiceNumberCandidate,
  rejectInvoiceNumberCandidate,
  rejectAllCandidatesForVendor,
  applyManualInvoiceNumber,
  fetchLatestScanRequest,
  requestInvoiceNumberScan,
  type InvoiceNumberCandidate,
  type InvoiceNumberScanRequest,
} from "../../lib/api/invoiceLookup";

/**
 * 「適格請求書番号 候補」パネル(2026-09-11新規)。経費のvendor(事業者名)から国税庁の
 * 適格請求書発行事業者公表サイトの全件データを名称検索した結果(invoice_number_candidates、
 * VPS側で都度バッチ検索して投入)を一覧表示し、ユーザーが確認のうえ採用・却下する。
 * 採用すると、その事業者名で登録番号が未入力の経費・仕入(purchases.source_name)レコードすべてに反映される
 * (2026-09-13、仕入先・出品者名にも対象拡大)。
 * 個人事業主は全件データで氏名が非公開のため、この方式では法人・人格のない社団等のみ検出できる。
 */
export default function InvoiceNumberCandidatesPanel() {
  const [rows, setRows] = useState<InvoiceNumberCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyVendor, setBusyVendor] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [manualInputs, setManualInputs] = useState<Record<string, string>>({});
  const [manualBusyVendor, setManualBusyVendor] = useState<string | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(false);

  // 未登録事業者の自動スキャン(2026-09-12追加)。実際の処理はVPS側cronジョブが非同期で行うため、
  // ここでは依頼を出して状態を表示するのみ(重い処理は一切ブラウザ側で行わない)。
  const [scanRequest, setScanRequest] = useState<InvoiceNumberScanRequest | null>(null);
  const [scanRequesting, setScanRequesting] = useState(false);

  async function reload() {
    setLoading(true);
    setErrorMessage(null);
    try {
      setRows(await fetchInvoiceNumberCandidates());
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "読み込みに失敗しました");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  useEffect(() => {
    fetchLatestScanRequest()
      .then(setScanRequest)
      .catch(() => {
        /* スキャン状態表示の取得失敗は致命的でないため無視 */
      });
  }, []);

  const byVendor = useMemo(() => {
    const map = new Map<string, InvoiceNumberCandidate[]>();
    for (const r of rows) {
      const arr = map.get(r.vendor) ?? [];
      arr.push(r);
      map.set(r.vendor, arr);
    }
    return map;
  }, [rows]);

  async function handleAccept(c: InvoiceNumberCandidate) {
    setBusyId(c.id);
    setMessage(null);
    setErrorMessage(null);
    try {
      const count = await acceptInvoiceNumberCandidate(c);
      setMessage(`「${c.vendor}」の経費${count}件に登録番号 ${c.candidate_reg_no} を反映しました`);
      await reload();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "採用に失敗しました");
    } finally {
      setBusyId(null);
    }
  }

  async function handleReject(id: string) {
    setBusyId(id);
    setErrorMessage(null);
    try {
      await rejectInvoiceNumberCandidate(id);
      await reload();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "却下に失敗しました");
    } finally {
      setBusyId(null);
    }
  }

  async function handleRejectVendor(vendor: string) {
    setBusyVendor(vendor);
    setErrorMessage(null);
    try {
      await rejectAllCandidatesForVendor(vendor);
      await reload();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "却下に失敗しました");
    } finally {
      setBusyVendor(null);
    }
  }

  async function handleScanRequest() {
    setScanRequesting(true);
    setErrorMessage(null);
    try {
      const req = await requestInvoiceNumberScan();
      setScanRequest(req);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "スキャン依頼に失敗しました");
    } finally {
      setScanRequesting(false);
    }
  }

  function scanStatusText(req: InvoiceNumberScanRequest | null): string {
    if (!req) return "";
    if (req.status === "pending") return "スキャン待ち(数分以内に開始されます)";
    if (req.status === "running") return "スキャン中...";
    if (req.status === "error") return `前回のスキャンでエラーが発生しました: ${req.error_message ?? ""}`;
    // done
    const scanned = req.vendors_scanned ?? 0;
    const matched = req.vendors_matched ?? 0;
    const finishedAt = req.finished_at ? new Date(req.finished_at).toLocaleString("ja-JP") : "";
    if (scanned === 0) return `前回のスキャン(${finishedAt}): 対象事業者はありませんでした`;
    return `前回のスキャン(${finishedAt}): 対象${scanned}件中${matched}件で候補が見つかりました`;
  }

  async function handleApplyManual(vendor: string) {
    const value = manualInputs[vendor] ?? "";
    setManualBusyVendor(vendor);
    setMessage(null);
    setErrorMessage(null);
    try {
      const count = await applyManualInvoiceNumber(vendor, value);
      setMessage(`「${vendor}」の経費${count}件に登録番号を反映しました`);
      setManualInputs((prev) => ({ ...prev, [vendor]: "" }));
      await reload();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "登録に失敗しました");
    } finally {
      setManualBusyVendor(null);
    }
  }

  return (
    <div
      style={{
        border: "0.5px solid var(--border)",
        borderRadius: 10,
        padding: "1rem 1.25rem",
        marginBottom: 20,
        background: "var(--surface-2)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <p style={{ fontSize: 14, fontWeight: 500, margin: 0 }}>適格請求書番号 候補{rows.length > 0 ? `(${byVendor.size}件)` : ""}</p>
        <button
          onClick={() => void handleScanRequest()}
          disabled={scanRequesting || scanRequest?.status === "pending" || scanRequest?.status === "running"}
          style={{ fontSize: 11, padding: "2px 8px", marginLeft: "auto" }}
        >
          {scanRequesting ? "依頼中..." : "未登録をスキャンする"}
        </button>
        <button
          onClick={() => setIsCollapsed((v) => !v)}
          style={{ fontSize: 11, padding: "2px 8px" }}
        >
          {isCollapsed ? "展開する" : "折りたたむ"}
        </button>
      </div>
      <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "0 0 10px" }}>
        経費の事業者名・仕入先/出品者名から、国税庁の適格請求書発行事業者公表サイトの全件データ(法人・人格のない社団等分)を名称検索した候補です。
        採用すると、その事業者名で登録番号が未入力の経費・仕入レコードすべてに反映されます。個人事業主は全件データで氏名が非公開のため検出できません
        (国税庁側に名称検索機能自体が無く、登録番号での検索のみのため、全件データをダウンロードして名称一致を検索しています)。
        「未登録をスキャンする」を押すと、登録番号が未設定かつ未スキャンの事業者を対象に検索依頼を出します
        (実際の処理はサーバー側で数分以内にバックグラウンド実行されるため、ブラウザやPCへの負荷はありません)。
      </p>
      {scanRequest && (
        <p style={{ fontSize: 11, color: "var(--text-secondary)", margin: "0 0 10px" }}>{scanStatusText(scanRequest)}</p>
      )}
      {message && <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: "0 0 8px" }}>{message}</p>}
      {errorMessage && <p style={{ color: "var(--danger-text)", fontSize: 13 }}>{errorMessage}</p>}
      {loading && <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>読み込み中...</p>}

      {!isCollapsed && Array.from(byVendor.entries()).map(([vendor, candidates]) => {
        const hasCandidates = candidates.some((c) => c.candidate_reg_no);
        return (
          <div key={vendor} style={{ marginBottom: 14, paddingBottom: 10, borderBottom: "0.5px solid var(--border)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{vendor}</span>
              {!hasCandidates && (
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>候補が見つかりませんでした</span>
              )}
              <button
                onClick={() => void handleRejectVendor(vendor)}
                disabled={busyVendor === vendor}
                style={{ fontSize: 11, padding: "2px 8px", marginLeft: "auto" }}
              >
                {hasCandidates ? "候補をすべて却下" : "確認済みにする"}
              </button>
            </div>
            {hasCandidates && (
              <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
                <tbody>
                  {candidates
                    .filter((c) => c.candidate_reg_no)
                    .map((c) => (
                      <tr key={c.id} style={{ borderTop: "0.5px solid var(--border)" }}>
                        <td style={{ padding: "4px 6px" }}>{c.candidate_name}</td>
                        <td style={{ padding: "4px 6px", fontFamily: "monospace" }}>{c.candidate_reg_no}</td>
                        <td style={{ padding: "4px 6px", textAlign: "right", whiteSpace: "nowrap" }}>
                          <button
                            onClick={() => void handleAccept(c)}
                            disabled={busyId === c.id}
                            style={{ fontSize: 11, padding: "2px 8px", marginRight: 4 }}
                          >
                            採用
                          </button>
                          <button
                            onClick={() => void handleReject(c.id)}
                            disabled={busyId === c.id}
                            style={{ fontSize: 11, padding: "2px 8px" }}
                          >
                            却下
                          </button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6 }}>
              <input
                type="text"
                placeholder="登録番号を手動入力(例: T1234567890123)"
                value={manualInputs[vendor] ?? ""}
                onChange={(e) => setManualInputs((prev) => ({ ...prev, [vendor]: e.target.value }))}
                style={{ fontSize: 12, width: 220 }}
              />
              <button
                onClick={() => void handleApplyManual(vendor)}
                disabled={manualBusyVendor === vendor || !(manualInputs[vendor] ?? "").trim()}
                style={{ fontSize: 11, padding: "2px 8px" }}
              >
                この番号を登録
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
