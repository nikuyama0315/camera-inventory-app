import { useState } from "react";
import { buildFreeeTemplateWorkbook, type FreeeTemplateRowValues } from "../../lib/api/freeeTemplateExport";

/**
 * 「Freee取引テンプレート用データ作成」パネル(CSV出力タブ、「売上データCSV」の右、2026-09-10追加)。
 * 対象年月を選択して「データ作成」を押すと、ユーザー提供のfreee取引テンプレートに
 * eBay(Soulcamera/Soulmenjapan)・メルカリ・ヤフーフリマの月次集計値を書き込んでダウンロードする。
 *
 * 2026-09-10追加(ユーザー指示): 「利益管理票更新用データの作成」(EbayXlsxFillPanel.tsx)と同じ
 * 形式(値をreadOnlyのテキストボックスに入れた表)で、作成した当該月分のデータを画面上にも
 * 一覧表示する(ダウンロード自体の挙動は変更しない)。
 */

function fmtYen(value: number | null): string {
  if (value == null) return "-";
  return value.toLocaleString("ja-JP");
}

/** EbayXlsxFillPanel.tsxのValueCellと同じ考え方: 値をクリック→選択してコピーしやすくするため、
 *  プレーンなセルではなくreadOnlyのinputに入れて表示する。 */
function ValueCell({ value, width }: { value: string; width: number }) {
  return (
    <td style={{ padding: "2px 3px" }}>
      <input
        type="text"
        value={value}
        readOnly
        onFocus={(e) => e.currentTarget.select()}
        style={{
          width,
          border: "0.5px solid var(--border)",
          borderRadius: 4,
          padding: "3px 5px",
          fontSize: 12,
          fontFamily: "inherit",
          color: "inherit",
          background: "var(--surface-1, transparent)",
          whiteSpace: "nowrap",
        }}
      />
    </td>
  );
}

export default function FreeeTemplatePanel() {
  const [yearMonth, setYearMonth] = useState(new Date().toISOString().slice(0, 7));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const [rows, setRows] = useState<FreeeTemplateRowValues[] | null>(null);

  async function handleCreate() {
    setBusy(true);
    setMessage(null);
    setIsError(false);
    setRows(null);
    try {
      const result = await buildFreeeTemplateWorkbook(yearMonth);
      const blob = new Blob([result.buffer as BlobPart], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = result.fileName;
      a.click();
      URL.revokeObjectURL(url);
      setRows(result.rows);
      if (result.warnings.length > 0) {
        setIsError(true);
        setMessage(`作成しました。${result.warnings.join(" ")}`);
      } else {
        setIsError(false);
        setMessage(`作成しました(${result.fileName})。ダウンロードフォルダをご確認ください。`);
      }
    } catch (err) {
      setIsError(true);
      setMessage(err instanceof Error ? err.message : "データ作成に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{ background: "var(--surface-1)", borderRadius: 8, padding: "1rem", border: "0.5px solid var(--border)" }}
    >
      <p style={{ fontSize: 13, fontWeight: 500, margin: "0 0 8px" }}>Freee取引テンプレート用データ作成</p>
      <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "0 0 10px" }}>
        対象月のeBay Transaction Report・Tax Invoicesの取込済みデータ(Soulcamera・Soulmenjapan)と、
        メルカリ・ヤフーフリマの登録済み売上データから、freee取引テンプレートの売上高・販売手数料・広告宣伝費(I〜K列)を自動計算して埋め、ダウンロードします。
      </p>
      <div style={{ marginBottom: 10 }}>
        <label style={{ fontSize: 12, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
          対象年月
        </label>
        <input type="month" value={yearMonth} onChange={(e) => setYearMonth(e.target.value)} />
      </div>
      <button onClick={handleCreate} disabled={busy}>
        {busy ? "作成中..." : "データ作成"}
      </button>
      {message && (
        <p style={{ fontSize: 12, color: isError ? "var(--danger-text)" : "var(--text-secondary)", marginTop: 8 }}>
          {message}
        </p>
      )}

      {rows && rows.length > 0 && (
        <div style={{ overflowX: "auto", marginTop: 12, width: "50%", minWidth: 420 }}>
          <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse", whiteSpace: "nowrap" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--text-secondary)" }}>
                <th style={{ padding: "4px" }}>プラットフォーム</th>
                <th style={{ padding: "4px" }}>アカウント</th>
                <th style={{ padding: "4px" }}>売上高(円)</th>
                <th style={{ padding: "4px" }}>販売手数料(円)</th>
                <th style={{ padding: "4px" }}>広告宣伝費(円)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} style={{ borderTop: "0.5px solid var(--border)" }}>
                  <ValueCell value={r.platform} width={90} />
                  <ValueCell value={r.account ?? "-"} width={110} />
                  <ValueCell value={fmtYen(r.salesJpy)} width={100} />
                  <ValueCell value={fmtYen(r.feeJpy)} width={100} />
                  <ValueCell value={fmtYen(r.adFeeJpy)} width={100} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
