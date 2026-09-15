import { useEffect, useState } from "react";
import {
  checkStockAlertsAndNotify,
  fetchModelStockOverview,
  syncDriveStockCounts,
  deleteStockThreshold,
  renameModelFolder,
  upsertDriveFolderUrl,
  upsertPurchasingCount,
  upsertStockThreshold,
  type ModelStockRow,
} from "../lib/api/stockAlerts";

export default function StockAlertsPage() {
  const [rows, setRows] = useState<ModelStockRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkMessage, setCheckMessage] = useState<string | null>(null);

  // Google Driveからの在庫数再取得(2026-08-31追加)
  const [syncingDrive, setSyncingDrive] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  // 機種名フォルダごとの編集中しきい値・保存状態
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [savingModel, setSavingModel] = useState<string | null>(null);
  const [savedModel, setSavedModel] = useState<string | null>(null);

  // 機種名フォルダごとの編集中「仕入中」数量・保存状態(2026-09-13追加)
  const [purchasingValues, setPurchasingValues] = useState<Record<string, string>>({});
  const [savingPurchasing, setSavingPurchasing] = useState<string | null>(null);
  const [deletingModel, setDeletingModel] = useState<string | null>(null);

  // 機種名フォルダ名自体の編集中の値・保存状態(2026-09-15追加)
  const [modelNameEditValues, setModelNameEditValues] = useState<Record<string, string>>({});
  const [savingModelName, setSavingModelName] = useState<string | null>(null);
  const [savedModelName, setSavedModelName] = useState<string | null>(null);

  // 機種名フォルダごとの編集中Google DriveフォルダURL・保存状態(2026-09-15追加)
  const [driveUrlValues, setDriveUrlValues] = useState<Record<string, string>>({});
  const [savingDriveUrl, setSavingDriveUrl] = useState<string | null>(null);
  const [savedDriveUrl, setSavedDriveUrl] = useState<string | null>(null);

  // 新規機種名(在庫0件でも先にしきい値を登録できる)
  const [newModelName, setNewModelName] = useState("");
  const [newThreshold, setNewThreshold] = useState("1");
  const [addingModel, setAddingModel] = useState(false)
  const [addError, setAddError] = useState<string | null>(null);

  // 機種名での絞り込み・ソート(2026-08-31追加)
  const [searchQuery, setSearchQuery] = useState("");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");

  async function reload() {
    setLoading(true);
    setErrorMessage(null);
    try {
      const data = await fetchModelStockOverview();
      setRows(data);
      setEditValues((prev) => {
        const next = { ...prev };
        for (const r of data) {
          if (next[r.model_folder_name] === undefined) {
            next[r.model_folder_name] = String(r.threshold);
          }
        }
        return next;
      });
      setPurchasingValues((prev) => {
        const next = { ...prev };
        for (const r of data) {
          next[r.model_folder_name] = String(r.purchasing_count);
        }
        return next;
      });
      setModelNameEditValues((prev) => {
        const next = { ...prev };
        for (const r of data) {
          if (next[r.model_folder_name] === undefined) {
            next[r.model_folder_name] = r.model_folder_name;
          }
        }
        return next;
      });
      setDriveUrlValues((prev) => {
        const next = { ...prev };
        for (const r of data) {
          next[r.model_folder_name] = r.drive_folder_url ?? "";
        }
        return next;
      });
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  function updateEditValue(modelFolderName: string, value: string) {
    setEditValues((prev) => ({ ...prev, [modelFolderName]: value }));
    setSavedModel(null);
  }

  async function handleSaveThreshold(modelFolderName: string) {
    const value = editValues[modelFolderName];
    const threshold = Number(value);
    if (Number.isNaN(threshold) || threshold < 0) {
      setErrorMessage("しきい値は0以上の数値で入力してください");
      return;
    }
    setSavingModel(modelFolderName);
    setErrorMessage(null);
    try {
      await upsertStockThreshold(modelFolderName, threshold);
      await reload();
      setSavedModel(modelFolderName);
      setTimeout(() => setSavedModel((cur) => (cur === modelFolderName ? null : cur)), 2000);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "しきい値の保存に失敗しました");
    } finally {
      setSavingModel(null);
    }
  }

  function updateModelNameValue(modelFolderName: string, value: string) {
    setModelNameEditValues((prev) => ({ ...prev, [modelFolderName]: value }));
    setSavedModelName(null);
  }

  async function handleSaveModelName(oldName: string) {
    const newName = (modelNameEditValues[oldName] ?? oldName).trim();
    if (!newName) {
      setErrorMessage("機種名フォルダ名を入力してください");
      return;
    }
    if (newName !== oldName && rows.some((r) => r.model_folder_name === newName)) {
      setErrorMessage("この機種名は既に登録されています");
      return;
    }
    const row = rows.find((r) => r.model_folder_name === oldName);
    if (!row) return;
    setSavingModelName(oldName);
    setErrorMessage(null);
    try {
      await renameModelFolder(oldName, newName, row.threshold, row.purchasing_count, row.drive_folder_url);
      await reload();
      setSavedModelName(newName);
      setTimeout(() => setSavedModelName((cur) => (cur === newName ? null : cur)), 2000);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "機種名の変更に失敗しました");
    } finally {
      setSavingModelName(null);
    }
  }

  function updateDriveUrlValue(modelFolderName: string, value: string) {
    setDriveUrlValues((prev) => ({ ...prev, [modelFolderName]: value }));
    setSavedDriveUrl(null);
  }

  async function handleSaveDriveUrl(modelFolderName: string) {
    const value = (driveUrlValues[modelFolderName] ?? "").trim();
    setSavingDriveUrl(modelFolderName);
    setErrorMessage(null);
    try {
      await upsertDriveFolderUrl(modelFolderName, value);
      await reload();
      setSavedDriveUrl(modelFolderName);
      setTimeout(() => setSavedDriveUrl((cur) => (cur === modelFolderName ? null : cur)), 2000);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Google DriveフォルダURLの保存に失敗しました");
    } finally {
      setSavingDriveUrl(null);
    }
  }

  function handleOpenDriveFolder(modelFolderName: string) {
    const url = (driveUrlValues[modelFolderName] ?? "").trim();
    if (!url) return;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function updatePurchasingValue(modelFolderName: string, value: string) {
    setPurchasingValues((prev) => ({ ...prev, [modelFolderName]: value }));
  }

  async function handleSavePurchasing(modelFolderName: string, currentSavedValue: number) {
    const value = purchasingValues[modelFolderName];
    const count = Number(value);
    if (String(count) === String(currentSavedValue)) return; // 未変更なら何もしない
    if (Number.isNaN(count) || count < 0) {
      setErrorMessage("仕入中の数量は0以上の数値で入力してください");
      setPurchasingValues((prev) => ({ ...prev, [modelFolderName]: String(currentSavedValue) }));
      return;
    }
    setSavingPurchasing(modelFolderName);
    setErrorMessage(null);
    try {
      await upsertPurchasingCount(modelFolderName, count);
      await reload();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "仕入中の数量の保存に失敗しました");
    } finally {
      setSavingPurchasing(null);
    }
  }

  async function handleDeleteModel(modelFolderName: string) {
    if (
      !window.confirm(
        `機種名「${modelFolderName}」のしきい値・仕入中の設定を削除します。よろしいですか?(在庫がGoogle Drive上に残っている場合、次回の在庫数取得で一覧に再表示されます)`,
      )
    ) {
      return;
    }
    setDeletingModel(modelFolderName);
    setErrorMessage(null);
    try {
      await deleteStockThreshold(modelFolderName);
      await reload();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "削除に失敗しました");
    } finally {
      setDeletingModel(null);
    }
  }

  async function handleAddModel() {
    setAddError(null);
    const name = newModelName.trim();
    const threshold = Number(newThreshold);
    if (!name) {
      setAddError("機種名フォルダ名を入力してください");
      return;
    }
    if (Number.isNaN(threshold) || threshold < 0) {
      setAddError("しきい値は0以上の数値で入力してください");
      return;
    }
    if (rows.some((r) => r.model_folder_name === name)) {
      setAddError("この機種名は既に登録されています");
      return;
    }
    setAddingModel(true);
    try {
      await upsertStockThreshold(name, threshold);
      setNewModelName("");
      setNewThreshold("1");
      await reload();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "登録に失敗しました");
    } finally {
      setAddingModel(false);
    }
  }

  async function handleCheckNow() {
    setChecking(true);
    setCheckMessage(null);
    try {
      const result = await checkStockAlertsAndNotify();
      if (result && result.notified.length > 0) {
        setCheckMessage(`${result.notified.join("、")} についてメール通知を送信しました`);
      } else if (belowCount > 0) {
        setCheckMessage(
          `現在${belowCount}件の機種がしきい値を下回っていますが、いずれも前回チェック時から継続して下回っている状態のため、新規のメール通知はありません(同じ機種に重複送信しないための仕様です)`,
        );
      } else {
        setCheckMessage("しきい値を下回っている機種はありませんでした(通知なし)");
      }
    } catch (err) {
      setCheckMessage(
        "チェックに失敗しました: " + (err instanceof Error ? err.message : "不明なエラー") +
          "(Gmail送信用のシークレットが未設定の可能性があります)",
      );
    } finally {
      setChecking(false);
    }
  }

  async function handleSyncDrive() {
    setSyncingDrive(true);
    setSyncMessage(null);
    try {
      const result = await syncDriveStockCounts();
      await reload();
      setSyncMessage(`${result.synced}件の機種名フォルダをGoogle Driveから再取得しました`);
    } catch (err) {
      setSyncMessage(
        "Google Driveからの取得に失敗しました: " + (err instanceof Error ? err.message : "不明なエラー"),
      );
    } finally {
      setSyncingDrive(false);
    }
  }

  const belowCount = rows.filter((r) => r.belowThreshold).length;
  const latestCheckedAt = rows.reduce<string | null>((latest, r) => {
    if (!r.checked_at) return latest;
    if (!latest || r.checked_at > latest) return r.checked_at;
    return latest;
  }, null);

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const displayRows = rows
    .filter((r) => !normalizedQuery || r.model_folder_name.toLowerCase().includes(normalizedQuery))
    .sort((a, b) =>
      sortOrder === "asc"
        ? a.model_folder_name.localeCompare(b.model_folder_name)
        : b.model_folder_name.localeCompare(a.model_folder_name),
    );

  function toggleSortOrder() {
    setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
  }

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "1.5rem", paddingBottom: "3rem", boxSizing: "border-box" }}>
      <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 0, marginBottom: 4 }}>
        在庫数は、Google Driveの「@撮影済み・出品待ち」フォルダ配下にある機種名フォルダの中に、実際にいくつフォルダ(商品ごとの個別フォルダ)があるかをGoogle Drive APIで数えた実数です。下の「Google Driveから最新の在庫数を取得」ボタンで再取得できます。
      </p>
      <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 0, marginBottom: 16 }}>
        {latestCheckedAt ? `最終取得: ${new Date(latestCheckedAt).toLocaleString("ja-JP")}` : "まだGoogle Driveから在庫数を取得していません"}
      </p>

      {belowCount > 0 && (
        <div
          style={{
            marginBottom: 16,
            padding: "10px 12px",
            border: "0.5px solid var(--danger-text)",
            borderRadius: 8,
            background: "var(--danger-bg)",
          }}
        >
          <p style={{ fontSize: 13, color: "var(--danger-text)", margin: 0, fontWeight: 500 }}>
            {belowCount}件の機種がしきい値を下回っています
          </p>
        </div>
      )}

      <div
        style={{
          marginBottom: 16,
          padding: "10px 12px",
          border: "0.5px dashed var(--border-strong)",
          borderRadius: 8,
          background: "var(--surface-1)",
        }}
      >
        <label style={{ fontSize: 12, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
          新しい機種名を先に登録する(在庫がまだ0件でもしきい値を設定できます)
        </label>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="text"
            placeholder="例: Nikon FM2"
            value={newModelName}
            onChange={(e) => setNewModelName(e.target.value)}
            style={{ flex: 1 }}
          />
          <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>しきい値</label>
          <input
            type="number"
            value={newThreshold}
            onChange={(e) => setNewThreshold(e.target.value)}
            style={{ width: 60 }}
          />
          <button onClick={handleAddModel} disabled={addingModel}>
            {addingModel ? "登録中..." : "登録"}
          </button>
        </div>
        {addError && <p style={{ color: "var(--danger-text)", fontSize: 12, margin: "6px 0 0" }}>{addError}</p>}
        <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "6px 0 0" }}>
          機種名は、Google Driveの「@撮影済み・出品待ち」フォルダ配下にある機種名フォルダの名前と完全に同じ表記にしてください(大文字小文字・前後の空白の違いは吸収されますが、それ以外の表記が一致しないと在庫数が正しく連動しません)。
        </p>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
        <button onClick={handleSyncDrive} disabled={syncingDrive}>
          {syncingDrive ? "取得中..." : "Google Driveから最新の在庫数を取得"}
        </button>
        {syncMessage && <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{syncMessage}</span>}
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16 }}>
        <button onClick={handleCheckNow} disabled={checking}>
          {checking ? "確認中..." : "今すぐチェック+メール通知"}
        </button>
        {checkMessage && <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{checkMessage}</span>}
      </div>

      {errorMessage && <p style={{ color: "var(--danger-text)", fontSize: 13 }}>{errorMessage}</p>}
      {loading && <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>読み込み中...</p>}

      {!loading && rows.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <input
            type="text"
            placeholder="機種名で絞り込み..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ width: "100%", maxWidth: 320 }}
          />
        </div>
      )}

      {!loading && (
        <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-secondary)" }}>
              <th
                style={{ padding: "6px 4px", fontWeight: 500, cursor: "pointer", userSelect: "none" }}
                onClick={toggleSortOrder}
                title="クリックで並び替え"
              >
                機種名フォルダ {sortOrder === "asc" ? "▲" : "▼"}
              </th>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}>Driveフォルダ</th>
              <th style={{ padding: "6px 4px", fontWeight: 500, textAlign: "right" }}>在庫数</th>
              <th style={{ padding: "6px 4px", fontWeight: 500, textAlign: "right" }}>しきい値</th>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}></th>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}></th>
              <th style={{ padding: "6px 4px", fontWeight: 500, textAlign: "right" }}>仕入中</th>
              <th style={{ padding: "6px 4px", fontWeight: 500 }}></th>
            </tr>
          </thead>
          <tbody>
            {displayRows.map((r, rowIndex) => {
              const zebraBackground = rowIndex % 2 === 1 ? "var(--surface-1)" : undefined;
              const editValue = editValues[r.model_folder_name] ?? String(r.threshold);
              const isDirty = editValue !== String(r.threshold);
              const isSaving = savingModel === r.model_folder_name;
              const isSaved = savedModel === r.model_folder_name;
              const purchasingValue = purchasingValues[r.model_folder_name] ?? String(r.purchasing_count);
              const isSavingPurchasing = savingPurchasing === r.model_folder_name;
              const isDirtyPurchasing = purchasingValue !== String(r.purchasing_count);
              const modelNameValue = modelNameEditValues[r.model_folder_name] ?? r.model_folder_name;
              const isDirtyModelName = modelNameValue !== r.model_folder_name;
              const isSavingModelName = savingModelName === r.model_folder_name;
              const isSavedModelName = savedModelName === r.model_folder_name;
              const driveUrlValue = driveUrlValues[r.model_folder_name] ?? r.drive_folder_url ?? "";
              const isDirtyDriveUrl = driveUrlValue !== (r.drive_folder_url ?? "");
              const isSavingDriveUrl = savingDriveUrl === r.model_folder_name;
              const isSavedDriveUrl = savedDriveUrl === r.model_folder_name;
              return (
                <tr
                  key={r.model_folder_name}
                  style={{ borderTop: "0.5px solid var(--border)", background: zebraBackground }}
                >
                  <td style={{ padding: "8px 4px" }}>
                    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                      <input
                        type="text"
                        value={modelNameValue}
                        onChange={(e) => updateModelNameValue(r.model_folder_name, e.target.value)}
                        disabled={isSavingModelName}
                        style={{ flex: 1, minWidth: 120 }}
                      />
                      {isDirtyModelName && (
                        <button
                          onClick={() => handleSaveModelName(r.model_folder_name)}
                          disabled={isSavingModelName}
                          style={{ fontSize: 12, padding: "3px 10px", whiteSpace: "nowrap" }}
                        >
                          {isSavingModelName ? "保存中..." : "保存"}
                        </button>
                      )}
                      {!isDirtyModelName && isSavedModelName && (
                        <span style={{ fontSize: 12, color: "var(--text-secondary)", whiteSpace: "nowrap" }}>保存しました</span>
                      )}
                    </div>
                  </td>
                  <td style={{ padding: "8px 4px" }}>
                    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                      <input
                        type="text"
                        placeholder="https://drive.google.com/..."
                        value={driveUrlValue}
                        onChange={(e) => updateDriveUrlValue(r.model_folder_name, e.target.value)}
                        disabled={isSavingDriveUrl}
                        style={{ flex: 1, minWidth: 160 }}
                      />
                      <button
                        onClick={() => handleOpenDriveFolder(r.model_folder_name)}
                        disabled={!driveUrlValue.trim()}
                        style={{ fontSize: 12, padding: "3px 10px", whiteSpace: "nowrap" }}
                      >
                        フォルダを開く
                      </button>
                      {isDirtyDriveUrl && (
                        <button
                          onClick={() => handleSaveDriveUrl(r.model_folder_name)}
                          disabled={isSavingDriveUrl}
                          style={{ fontSize: 12, padding: "3px 10px", whiteSpace: "nowrap" }}
                        >
                          {isSavingDriveUrl ? "保存中..." : "保存"}
                        </button>
                      )}
                      {!isDirtyDriveUrl && isSavedDriveUrl && (
                        <span style={{ fontSize: 12, color: "var(--text-secondary)", whiteSpace: "nowrap" }}>保存しました</span>
                      )}
                    </div>
                  </td>
                  <td style={{ padding: "8px 4px", textAlign: "right", fontWeight: 500 }}>{r.in_stock_count}</td>
                  <td style={{ padding: "8px 4px", textAlign: "right" }}>
                    <input
                      type="number"
                      value={editValue}
                      onChange={(e) => updateEditValue(r.model_folder_name, e.target.value)}
                      disabled={isSaving}
                      style={{ width: 60, textAlign: "right" }}
                    />
                  </td>
                  <td style={{ padding: "8px 4px" }}>
                    {isDirty && (
                      <button
                        onClick={() => handleSaveThreshold(r.model_folder_name)}
                        disabled={isSaving}
                        style={{ fontSize: 12, padding: "3px 10px" }}
                      >
                        {isSaving ? "保存中..." : "保存"}
                      </button>
                    )}
                    {!isDirty && isSaved && (
                      <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>保存しました</span>
                    )}
                  </td>
                  <td style={{ padding: "8px 4px" }}>
                    {r.belowThreshold && (
                      <span
                        style={{
                          fontSize: 11,
                          padding: "2px 8px",
                          borderRadius: 999,
                          background: "var(--danger-bg)",
                          color: "var(--danger-text)",
                          border: "0.5px solid var(--danger-text)",
                        }}
                      >
                        しきい値割れ
                      </span>
                    )}
                  </td>
                  <td style={{ padding: "8px 4px" }}>
                    <div style={{ display: "flex", gap: 4, alignItems: "center", justifyContent: "flex-end" }}>
                      <input
                        type="number"
                        value={purchasingValue}
                        onChange={(e) => updatePurchasingValue(r.model_folder_name, e.target.value)}
                        disabled={isSavingPurchasing}
                        style={{ width: 60, textAlign: "right" }}
                      />
                      {isDirtyPurchasing && (
                        <button
                          onClick={() => handleSavePurchasing(r.model_folder_name, r.purchasing_count)}
                          disabled={isSavingPurchasing}
                          style={{ fontSize: 12, padding: "3px 10px" }}
                        >
                          {isSavingPurchasing ? "保存中..." : "保存"}
                        </button>
                      )}
                    </div>
                  </td>
                  <td style={{ padding: "8px 4px", textAlign: "right" }}>
                    <button
                      onClick={() => void handleDeleteModel(r.model_folder_name)}
                      disabled={deletingModel === r.model_folder_name}
                      style={{ fontSize: 12, padding: "3px 10px" }}
                    >
                      {deletingModel === r.model_folder_name ? "削除中..." : "削除"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {!loading && rows.length === 0 && (
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
          機種名フォルダが登録された商品がまだありません(基本情報タブで画像保管フォルダを登録すると表示されます)
        </p>
      )}
      {!loading && rows.length > 0 && displayRows.length === 0 && (
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
          「{searchQuery}」に一致する機種名フォルダがありません
        </p>
      )}
    </div>
  );
}
