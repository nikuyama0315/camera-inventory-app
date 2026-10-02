import { useMemo, useRef, useState } from "react";
import {
  fetchSalesForReconcile,
  overwriteShippingWithBilled,
  parseElogiBilledRecords,
  type OverwriteResult,
} from "../../lib/api/shippingReconcile";
import {
  decodeCsvBytes,
  parseCpassInvoiceFile,
  reconcile,
  type BilledRecord,
  type ReconcileCategory,
  type ReconcileReport,
  type ReconcileSource,
} from "../../lib/shippingReconcileCore";

const CATEGORY_LABELS: Record<ReconcileCategory, string> = {
  under: "請求のほうが多い",
  over: "登録のほうが多い",
  shared: "複数売上で共有",
};

const CATEGORY_HINTS: Record<ReconcileCategory, string> = {
  under: "追加請求・調整(燃料割増・混雑時割増など)が登録額に反映されていない可能性があります",
  over: "関税・VAT等を含めて登録している場合、請求明細(運送料金・割増金のみ)より大きくなります。上書きすると、その分が原価から外れます",
  shared: "1つの請求に複数の売上が紐付いているため、按分できず自動上書きの対象外です(必要なら売上を個別に編集してください)",
};

const SOURCE_LABELS: Record<ReconcileSource, string> = {
  cpass: "CPaSS請求明細",
  elogi: "eLogi発送済一覧",
};

function yen(n: number): string {
  return `¥${n.toLocaleString()}`;
}

function signedYen(n: number): string {
  return `${n > 0 ? "+" : n < 0 ? "-" : ""}¥${Math.abs(n).toLocaleString()}`;
}

/**
 * 「送料支払額の請求明細との照合」パネル(送料タブ、2026-10-03新規・ユーザー指示)。
 * CPaSS請求明細(.xlsx/.csv、追跡番号で突合)・eLogi発送済一覧CSV(eBayオーダー番号で突合)を
 * 取り込んだ時点で自動的に照合し、登録済みの送料支払額(sales.shipping_cost_paid)との相違一覧を表示する。
 * 相違行にチェックを付けて「請求額で上書き」を押すと、請求額を正として登録額を更新する。
 * 初期状態でチェックが付くのは「請求のほうが多い」行のみ(「登録のほうが多い」行は関税・VAT等を含む
 * 可能性があるため、利用者が明示的にチェックした場合のみ上書きする)。
 */
export default function ShippingReconcilePanel() {
  const cpassInputRef = useRef<HTMLInputElement>(null);
  const elogiInputRef = useRef<HTMLInputElement>(null);

  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [report, setReport] = useState<ReconcileReport | null>(null);
  const [records, setRecords] = useState<BilledRecord[]>([]);
  const [fileName, setFileName] = useState("");
  const [periodText, setPeriodText] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<"all" | ReconcileCategory>("all");
  const [overwriteMessage, setOverwriteMessage] = useState<string | null>(null);

  function applyReport(next: ReconcileReport) {
    setReport(next);
    setChecked(new Set(next.rows.filter((r) => r.category === "under").map((r) => r.id)));
    setFilter("all");
  }

  async function handleFile(source: ReconcileSource, e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    setErrorMessage(null);
    setOverwriteMessage(null);
    setReport(null);
    try {
      let parsed: BilledRecord[];
      let period: string | null = null;
      if (source === "cpass") {
        const r = await parseCpassInvoiceFile(file);
        parsed = r.records;
        if (r.periodFrom && r.periodTo) period = `請求期間 ${r.periodFrom} 〜 ${r.periodTo}`;
      } else {
        parsed = parseElogiBilledRecords(decodeCsvBytes(await file.arrayBuffer()));
      }
      if (parsed.length === 0) {
        throw new Error("照合できるデータが見つかりませんでした。ファイルの内容をご確認ください");
      }
      const sales = await fetchSalesForReconcile();
      setRecords(parsed);
      setFileName(`${SOURCE_LABELS[source]}: ${file.name}`);
      setPeriodText(period);
      applyReport(reconcile(source, parsed, sales));
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "取り込みに失敗しました");
    } finally {
      setBusy(false);
    }
  }

  const visibleRows = useMemo(
    () => (report ? report.rows.filter((r) => filter === "all" || r.category === filter) : []),
    [report, filter],
  );
  const counts = useMemo(() => {
    const c: Record<ReconcileCategory, number> = { under: 0, over: 0, shared: 0 };
    report?.rows.forEach((r) => c[r.category]++);
    return c;
  }, [report]);

  const selectedRows = report ? report.rows.filter((r) => checked.has(r.id) && r.category !== "shared") : [];
  const selectedOverCount = selectedRows.filter((r) => r.category === "over").length;
  const selectedCostChange = selectedRows.reduce((sum, r) => sum + r.diff, 0);

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function setVisibleChecked(on: boolean) {
    setChecked((prev) => {
      const next = new Set(prev);
      visibleRows.filter((r) => r.category !== "shared").forEach((r) => (on ? next.add(r.id) : next.delete(r.id)));
      return next;
    });
  }

  async function handleOverwrite() {
    if (!report || selectedRows.length === 0) return;
    const warn =
      selectedOverCount > 0
        ? `\n\n⚠ 「登録のほうが多い」行が${selectedOverCount}件含まれています。登録額に関税・VAT等が含まれている場合、上書きするとその分が原価から外れ、粗利が増えます。`
        : "";
    const ok = window.confirm(
      `${selectedRows.length}件の送料支払額を、請求額で上書きします。\n` +
        `送料の合計: ${signedYen(selectedCostChange)}(粗利は自動で再計算されます)。` +
        warn +
        `\n\nよろしいですか?`,
    );
    if (!ok) return;

    setBusy(true);
    setErrorMessage(null);
    setOverwriteMessage(null);
    try {
      const result: OverwriteResult = await overwriteShippingWithBilled(selectedRows);
      const parts = [`${result.updated}件を請求額で更新しました`];
      if (result.changedElsewhere > 0) {
        parts.push(`${result.changedElsewhere}件は、表示後に登録額が他で変更されていたため更新していません`);
      }
      if (result.failed.length > 0) {
        parts.push(`${result.failed.length}件は更新に失敗しました(${result.failed.map((f) => f.managementNo).join("、")})`);
      }
      setOverwriteMessage(parts.join(" / "));
      // 最新の売上で照合し直して、更新済みの行を一覧から外す
      const sales = await fetchSalesForReconcile();
      applyReport(reconcile(report.source, records, sales));
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "更新に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 32, paddingTop: 24, borderTop: "1px solid var(--border)" }}>
      <h3 style={{ fontSize: 15, fontWeight: 700, marginTop: 0, marginBottom: 8 }}>請求明細との照合(送料支払額)</h3>
      <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 0, marginBottom: 12 }}>
        運送会社の請求明細を取り込むと、その場で登録済みの送料支払額と照合し、相違の一覧を表示します。
        CPaSSは請求明細(.xlsx/.csv)を追跡番号で、eLogiは発送済一覧CSVをeBayオーダー番号で突合します。
        相違する行は、チェックして「請求額で上書き」を押すと、請求額を正として登録額を更新します。
        初期状態でチェックが付くのは「請求のほうが多い」行のみです。
      </p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <input
          ref={cpassInputRef}
          type="file"
          accept=".xlsx,.csv"
          onChange={(e) => void handleFile("cpass", e)}
          style={{ display: "none" }}
        />
        <input
          ref={elogiInputRef}
          type="file"
          accept=".csv"
          onChange={(e) => void handleFile("elogi", e)}
          style={{ display: "none" }}
        />
        <button onClick={() => cpassInputRef.current?.click()} disabled={busy} style={{ fontSize: 12, padding: "4px 12px" }}>
          CPaSS請求明細を取り込んで照合(.xlsx/.csv)
        </button>
        <button onClick={() => elogiInputRef.current?.click()} disabled={busy} style={{ fontSize: 12, padding: "4px 12px" }}>
          eLogi発送済一覧CSVを取り込んで照合
        </button>
        {busy && <span style={{ fontSize: 12, color: "var(--text-muted)", alignSelf: "center" }}>処理中...</span>}
      </div>

      {errorMessage && <p style={{ color: "var(--danger-text)", fontSize: 13, marginTop: 8 }}>{errorMessage}</p>}
      {overwriteMessage && <p style={{ color: "var(--text-secondary)", fontSize: 13, marginTop: 8 }}>{overwriteMessage}</p>}

      {report && (
        <div style={{ marginTop: 12 }}>
          <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: "0 0 6px" }}>
            {fileName}
            {periodText ? `(${periodText})` : ""}
          </p>
          <p style={{ fontSize: 13, margin: "0 0 8px" }}>
            請求{report.recordCount}件のうち、金額も一致 <strong>{report.equalCount}</strong>件 / 相違{" "}
            <strong>{report.rows.length}</strong>件(請求のほうが多い {counts.under} / 登録のほうが多い {counts.over} /
            複数売上で共有 {counts.shared}) / 売上に対応なし <strong>{report.unmatched.length}</strong>件
          </p>

          {report.rows.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--text-muted)" }}>相違はありません。</p>
          ) : (
            <>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
                <select
                  value={filter}
                  onChange={(e) => setFilter(e.target.value as "all" | ReconcileCategory)}
                  style={{ fontSize: 12, padding: "3px 6px" }}
                >
                  <option value="all">すべて表示({report.rows.length})</option>
                  <option value="under">{CATEGORY_LABELS.under}({counts.under})</option>
                  <option value="over">{CATEGORY_LABELS.over}({counts.over})</option>
                  <option value="shared">{CATEGORY_LABELS.shared}({counts.shared})</option>
                </select>
                <button onClick={() => setVisibleChecked(true)} disabled={busy} style={{ fontSize: 12, padding: "3px 10px" }}>
                  表示中をすべて選択
                </button>
                <button onClick={() => setVisibleChecked(false)} disabled={busy} style={{ fontSize: 12, padding: "3px 10px" }}>
                  表示中の選択を解除
                </button>
                <button
                  onClick={() => void handleOverwrite()}
                  disabled={busy || selectedRows.length === 0}
                  style={{ fontSize: 12, padding: "3px 12px", fontWeight: 700, color: "var(--danger-text)" }}
                >
                  選択した{selectedRows.length}件を請求額で上書き
                </button>
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  選択分の送料の変化: {signedYen(selectedCostChange)}
                </span>
              </div>
              {filter !== "all" && (
                <p style={{ fontSize: 11, color: filter === "over" ? "var(--danger-text)" : "var(--text-muted)", margin: "0 0 6px" }}>
                  {CATEGORY_HINTS[filter]}
                </p>
              )}

              <div style={{ maxHeight: 420, overflow: "auto", border: "1px solid var(--border)", borderRadius: 6 }}>
                <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
                  <thead style={{ position: "sticky", top: 0, background: "var(--surface-2)" }}>
                    <tr style={{ textAlign: "left", color: "var(--text-secondary)" }}>
                      <th style={{ padding: "4px 6px" }} />
                      <th style={{ padding: "4px 6px" }}>管理番号</th>
                      <th style={{ padding: "4px 6px" }}>販売日</th>
                      <th style={{ padding: "4px 6px" }}>{report.source === "cpass" ? "追跡番号" : "eBayオーダー番号"}</th>
                      <th style={{ padding: "4px 6px", textAlign: "right" }}>登録額</th>
                      <th style={{ padding: "4px 6px", textAlign: "right" }}>請求額</th>
                      <th style={{ padding: "4px 6px", textAlign: "right" }}>差額(請求−登録)</th>
                      <th style={{ padding: "4px 6px" }}>区分</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((r, i) => (
                      <tr
                        key={r.id}
                        style={{ borderTop: "0.5px solid var(--border)", background: i % 2 === 1 ? "var(--surface-1)" : undefined }}
                      >
                        <td style={{ padding: "3px 6px" }}>
                          <input
                            type="checkbox"
                            checked={checked.has(r.id)}
                            disabled={busy || r.category === "shared"}
                            onChange={() => toggle(r.id)}
                          />
                        </td>
                        <td style={{ padding: "3px 6px", whiteSpace: "nowrap" }}>
                          {r.sales.map((s) => s.managementNo || "-").join(" / ")}
                        </td>
                        <td style={{ padding: "3px 6px", whiteSpace: "nowrap" }}>{r.sales[0].saleDate}</td>
                        <td style={{ padding: "3px 6px", fontFamily: "monospace", whiteSpace: "nowrap" }}>{r.record.key}</td>
                        <td style={{ padding: "3px 6px", textAlign: "right", whiteSpace: "nowrap" }}>{yen(r.registered)}</td>
                        <td style={{ padding: "3px 6px", textAlign: "right", whiteSpace: "nowrap" }}>{yen(r.billed)}</td>
                        <td
                          style={{
                            padding: "3px 6px",
                            textAlign: "right",
                            whiteSpace: "nowrap",
                            fontWeight: 600,
                            color: r.diff > 0 ? "var(--accent)" : "var(--danger-text)",
                          }}
                        >
                          {signedYen(r.diff)}
                        </td>
                        <td
                          style={{ padding: "3px 6px", whiteSpace: "nowrap" }}
                          title={CATEGORY_HINTS[r.category]}
                        >
                          {CATEGORY_LABELS[r.category]}
                          {r.category === "shared" ? `(${r.sales.length}売上)` : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {report.unmatched.length > 0 && (
            <details style={{ marginTop: 12 }}>
              <summary style={{ fontSize: 12, cursor: "pointer" }}>
                売上に対応が見つからない請求({report.unmatched.length}件)を表示
              </summary>
              <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "6px 0" }}>
                請求にはあるものの、アプリの売上に同じ{report.source === "cpass" ? "追跡番号" : "eBayオーダー番号・追跡番号"}の
                売上がありません(売上が未登録・追跡番号が未登録・返品や別用途の発送など)。
              </p>
              <div style={{ maxHeight: 240, overflow: "auto", border: "1px solid var(--border)", borderRadius: 6 }}>
                <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
                  <tbody>
                    {report.unmatched.map((u) => (
                      <tr key={u.key} style={{ borderTop: "0.5px solid var(--border)" }}>
                        <td style={{ padding: "3px 6px", fontFamily: "monospace" }}>{u.key}</td>
                        <td style={{ padding: "3px 6px", textAlign: "right" }}>{yen(Math.round(u.billed))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
