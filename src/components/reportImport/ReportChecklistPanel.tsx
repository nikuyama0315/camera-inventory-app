import { useEffect, useState } from "react";
import {
  fetchChecklistTypes,
  fetchChecklistChecks,
  createChecklistType,
  updateChecklistType,
  deleteChecklistType,
  setChecklistChecked,
  checklistMonthRange,
  checklistTypeHasAlert,
  type ChecklistType,
  type ChecklistCheck,
} from "../../lib/api/checklist";

/**
 * 「請求書・領収書 月次取込チェック」(2026-09-11新規)。
 * 月次で取り込んでおく請求書・領収書(freee外部の各種サービスからダウンロードするものなど)の
 * 取込忘れを防ぐための、種別×年月のチェック表。レポート取込状況(自動判定)とは異なり、
 * こちらはユーザーが手動でチェックを付ける。各月7日を過ぎても前月分のチェックが付いていない
 * 種別には⚠を表示する(判定基準はレポート取込状況のreportImportRowHasAlert()と同じ)。
 */
export default function ReportChecklistPanel() {
  const [types, setTypes] = useState<ChecklistType[]>([]);
  const [checks, setChecks] = useState<ChecklistCheck[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editSourceUrl, setEditSourceUrl] = useState("");
  const [editFolderUrl, setEditFolderUrl] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  const [newName, setNewName] = useState("");
  const [newSourceUrl, setNewSourceUrl] = useState("");
  const [newFolderUrl, setNewFolderUrl] = useState("");
  const [adding, setAdding] = useState(false);

  const months = checklistMonthRange();

  async function reload() {
    setLoading(true);
    setErrorMessage(null);
    try {
      const [t, c] = await Promise.all([fetchChecklistTypes(), fetchChecklistChecks()]);
      setTypes(t);
      setChecks(c);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "読み込みに失敗しました");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  function isChecked(typeId: string, ym: string): boolean {
    return checks.find((c) => c.type_id === typeId && c.year_month === ym)?.checked ?? false;
  }

  async function handleToggle(typeId: string, ym: string) {
    const next = !isChecked(typeId, ym);
    setChecks((prev) => {
      const idx = prev.findIndex((c) => c.type_id === typeId && c.year_month === ym);
      if (idx === -1) {
        return [
          ...prev,
          { id: `temp-${typeId}-${ym}`, type_id: typeId, year_month: ym, checked: next, checked_at: null },
        ];
      }
      const copy = [...prev];
      copy[idx] = { ...copy[idx], checked: next };
      return copy;
    });
    try {
      await setChecklistChecked(typeId, ym, next);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "更新に失敗しました");
      await reload();
    }
  }

  function startEdit(t: ChecklistType) {
    setEditingId(t.id);
    setEditName(t.name);
    setEditSourceUrl(t.source_url ?? "");
    setEditFolderUrl(t.storage_folder_url ?? "");
  }

  async function commitEdit() {
    if (!editingId) return;
    if (!editName.trim()) {
      setErrorMessage("種別名を入力してください");
      return;
    }
    setSavingEdit(true);
    setErrorMessage(null);
    try {
      await updateChecklistType(editingId, {
        name: editName.trim(),
        source_url: editSourceUrl.trim() || null,
        storage_folder_url: editFolderUrl.trim() || null,
      });
      setEditingId(null);
      await reload();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "更新に失敗しました");
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleDelete(t: ChecklistType) {
    if (!window.confirm(`「${t.name}」を削除しますか？(このチェック履歴も削除されます)`)) return;
    setErrorMessage(null);
    try {
      await deleteChecklistType(t.id);
      await reload();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "削除に失敗しました");
    }
  }

  async function handleAdd() {
    if (!newName.trim()) return;
    setAdding(true);
    setErrorMessage(null);
    try {
      await createChecklistType({
        name: newName.trim(),
        source_url: newSourceUrl.trim() || null,
        storage_folder_url: newFolderUrl.trim() || null,
      });
      setNewName("");
      setNewSourceUrl("");
      setNewFolderUrl("");
      await reload();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "追加に失敗しました");
    } finally {
      setAdding(false);
    }
  }

  return (
    <>
      <h3 style={{ fontSize: 14, fontWeight: 500, marginTop: 32 }}>請求書・領収書 月次取込チェック</h3>
      <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "0 0 8px" }}>
        月次で取り込んでおく請求書・領収書の取込忘れをチェックするための表です(チェックは手動で付けます)。
        各月7日を過ぎても前月分のチェックが付いていない種別には行に警告(⚠)を表示します。
      </p>
      {errorMessage && <p style={{ color: "var(--danger-text)", fontSize: 13 }}>{errorMessage}</p>}
      {loading && <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>読み込み中...</p>}

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse", marginBottom: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-secondary)" }}>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>種別</th>
              {months.map((ym) => (
                <th key={ym} style={{ padding: "6px 4px", fontWeight: 500, textAlign: "center" }}>
                  {ym}
                </th>
              ))}
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>取込先URL</th>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>保管フォルダ</th>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}></th>
            </tr>
          </thead>
          <tbody>
            {types.map((t) => {
              const isEditing = editingId === t.id;
              const alert = checklistTypeHasAlert(t.id, checks, months);
              return (
                <tr key={t.id} style={{ borderTop: "0.5px solid var(--border)" }}>
                  <td style={{ padding: "6px 4px", whiteSpace: "nowrap" }}>
                    {isEditing ? (
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        style={{ width: 110, fontSize: 12 }}
                      />
                    ) : (
                      <>
                        {t.name}
                        {alert && (
                          <span
                            style={{ marginLeft: 6, color: "var(--danger-text)", fontWeight: 700 }}
                            title="前月分のチェックが、当月7日を過ぎても付いていません"
                          >
                            ⚠
                          </span>
                        )}
                      </>
                    )}
                  </td>
                  {months.map((ym) => (
                    <td key={ym} style={{ padding: "6px 4px", textAlign: "center" }}>
                      <input type="checkbox" checked={isChecked(t.id, ym)} onChange={() => void handleToggle(t.id, ym)} />
                    </td>
                  ))}
                  <td style={{ padding: "6px 4px" }}>
                    {isEditing ? (
                      <input
                        type="text"
                        placeholder="取込先URL"
                        value={editSourceUrl}
                        onChange={(e) => setEditSourceUrl(e.target.value)}
                        style={{ width: 160, fontSize: 12 }}
                      />
                    ) : t.source_url ? (
                      <a href={t.source_url} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                        開く
                      </a>
                    ) : (
                      <span style={{ color: "var(--text-muted)" }}>-</span>
                    )}
                  </td>
                  <td style={{ padding: "6px 4px" }}>
                    {isEditing ? (
                      <input
                        type="text"
                        placeholder="保管フォルダURL(Google Drive)"
                        value={editFolderUrl}
                        onChange={(e) => setEditFolderUrl(e.target.value)}
                        style={{ width: 180, fontSize: 12 }}
                      />
                    ) : t.storage_folder_url ? (
                      <a href={t.storage_folder_url} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                        フォルダを開く
                      </a>
                    ) : (
                      <span style={{ color: "var(--text-muted)" }}>-</span>
                    )}
                  </td>
                  <td style={{ padding: "6px 4px", whiteSpace: "nowrap" }}>
                    {isEditing ? (
                      <>
                        <button
                          onClick={() => void commitEdit()}
                          disabled={savingEdit}
                          style={{ fontSize: 11, padding: "2px 6px", marginRight: 4 }}
                        >
                          保存
                        </button>
                        <button onClick={() => setEditingId(null)} style={{ fontSize: 11, padding: "2px 6px" }}>
                          キャンセル
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => startEdit(t)}
                          style={{ fontSize: 11, padding: "2px 6px", marginRight: 4 }}
                        >
                          編集
                        </button>
                        <button onClick={() => void handleDelete(t)} style={{ fontSize: 11, padding: "2px 6px" }}>
                          削除
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
            {types.length === 0 && !loading && (
              <tr>
                <td colSpan={months.length + 4} style={{ padding: "8px 4px", color: "var(--text-muted)" }}>
                  種別がまだ登録されていません
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 24 }}>
        <input
          type="text"
          placeholder="種別名(例: 斉藤商会)"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          style={{ width: 140, fontSize: 12 }}
        />
        <input
          type="text"
          placeholder="取込先URL"
          value={newSourceUrl}
          onChange={(e) => setNewSourceUrl(e.target.value)}
          style={{ width: 200, fontSize: 12 }}
        />
        <input
          type="text"
          placeholder="保管フォルダURL(Google Drive)"
          value={newFolderUrl}
          onChange={(e) => setNewFolderUrl(e.target.value)}
          style={{ width: 200, fontSize: 12 }}
        />
        <button onClick={() => void handleAdd()} disabled={adding || !newName.trim()} style={{ fontSize: 12, padding: "4px 10px" }}>
          種別を追加
        </button>
      </div>
    </>
  );
}
