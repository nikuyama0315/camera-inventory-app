import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchAllTodos,
  createTodo,
  updateTodoTitle,
  updateTodoSortOrder,
  moveTodoToParent,
  setTodoDone,
  deleteTodo,
  buildTodosBackup,
  restoreTodosFromBackup,
  type Todo,
  type TodoBackupFile,
} from "../lib/api/todos";

/** ヘッダーの「To Do」ボタンから新規ウィンドウで開かれる、ツリー構造のTo Doリスト単体ページ(2026-09-11追加)。
 *  App.tsx側でURLクエリ`?view=todo`を検出したとき、通常のタブ画面の代わりにこのページを描画する
 *  (認証セッションはSupabaseクライアントのlocalStorage永続化により同一オリジンの別ウィンドウでも共有される)。 */
export default function TodoPage() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [addingChildFor, setAddingChildFor] = useState<string | null>(null);
  const [newChildValue, setNewChildValue] = useState("");
  const [newRootValue, setNewRootValue] = useState("");
  const [busy, setBusy] = useState(false);

  const [backupBusy, setBackupBusy] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [backupMessage, setBackupMessage] = useState<string | null>(null);
  const restoreFileInputRef = useRef<HTMLInputElement>(null);

  /**
   * 追加日時を"yyyy/mm/dd hh:mm"形式・日本時間(JST)で表示するためのフォーマッタ。
   * 閲覧者のブラウザのタイムゾーン設定に依らず、常に日本時間で表示する
   * (ロケール依存の区切り文字ゆらぎを避けるため、パーツを個別に取り出して手動で組み立てる)。
   */
  function formatAddedDate(createdAt: string): string {
    const parts = new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(createdAt));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("year")}/${get("month")}/${get("day")} ${get("hour")}:${get("minute")}`;
  }

  async function reload() {
    setLoading(true);
    setErrorMessage(null);
    try {
      const rows = await fetchAllTodos();
      setTodos(rows);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "読み込みに失敗しました");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  const childrenByParent = useMemo(() => {
    const map = new Map<string | null, Todo[]>();
    for (const t of todos) {
      const key = t.parent_id;
      const arr = map.get(key) ?? [];
      arr.push(t);
      map.set(key, arr);
    }
    return map;
  }, [todos]);

  function toggleCollapse(id: string) {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleAddRoot() {
    const title = newRootValue.trim();
    if (!title) return;
    setBusy(true);
    setErrorMessage(null);
    try {
      await createTodo(null, title);
      setNewRootValue("");
      await reload();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "追加に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  async function handleAddChild(parentId: string) {
    const title = newChildValue.trim();
    if (!title) return;
    setBusy(true);
    setErrorMessage(null);
    try {
      await createTodo(parentId, title);
      setNewChildValue("");
      setAddingChildFor(null);
      setCollapsedIds((prev) => {
        if (!prev.has(parentId)) return prev;
        const next = new Set(prev);
        next.delete(parentId);
        return next;
      });
      await reload();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "追加に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleDone(todo: Todo) {
    setBusy(true);
    setErrorMessage(null);
    try {
      await setTodoDone(todo.id, !todo.done);
      await reload();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "更新に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  function startEdit(todo: Todo) {
    setEditingId(todo.id);
    setEditingValue(todo.title);
  }

  async function commitEdit() {
    if (!editingId) return;
    const title = editingValue.trim();
    if (!title) {
      setEditingId(null);
      return;
    }
    setBusy(true);
    setErrorMessage(null);
    try {
      await updateTodoTitle(editingId, title);
      setEditingId(null);
      await reload();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "更新に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(todo: Todo) {
    const hasChildren = (childrenByParent.get(todo.id)?.length ?? 0) > 0;
    const confirmMessage = hasChildren
      ? `「${todo.title}」を削除します。配下の項目もすべて削除されますがよろしいですか？`
      : `「${todo.title}」を削除しますか？`;
    if (!window.confirm(confirmMessage)) return;
    setBusy(true);
    setErrorMessage(null);
    try {
      await deleteTodo(todo.id);
      await reload();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "削除に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  /** 同じ親を持つ兄弟の中で、1つ上/下の項目とsort_orderを入れ替える(表示順の移動)。 */
  async function handleMove(todo: Todo, direction: "up" | "down") {
    const siblings = childrenByParent.get(todo.parent_id) ?? [];
    const idx = siblings.findIndex((t) => t.id === todo.id);
    const neighborIdx = direction === "up" ? idx - 1 : idx + 1;
    if (idx === -1 || neighborIdx < 0 || neighborIdx >= siblings.length) return;
    const neighbor = siblings[neighborIdx];

    setBusy(true);
    setErrorMessage(null);
    try {
      await Promise.all([
        updateTodoSortOrder(todo.id, neighbor.sort_order),
        updateTodoSortOrder(neighbor.id, todo.sort_order),
      ]);
      await reload();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "並び替えに失敗しました");
    } finally {
      setBusy(false);
    }
  }

  /** 階層を1つ上げる(親の階層へ、親と同じ兄弟レベルの末尾へ移動)。ルート直下の項目には適用不可。 */
  async function handlePromote(todo: Todo) {
    if (!todo.parent_id) return;
    const parentTodo = todos.find((t) => t.id === todo.parent_id);
    const newParentId = parentTodo?.parent_id ?? null;
    setBusy(true);
    setErrorMessage(null);
    try {
      await moveTodoToParent(todo.id, newParentId);
      await reload();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "階層の変更に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  /** 階層を1つ下げる(1つ上の兄弟の子として、その末尾へ移動)。先頭の項目には適用不可。 */
  async function handleDemote(todo: Todo) {
    const siblings = childrenByParent.get(todo.parent_id) ?? [];
    const idx = siblings.findIndex((t) => t.id === todo.id);
    if (idx <= 0) return;
    const newParent = siblings[idx - 1];
    setBusy(true);
    setErrorMessage(null);
    try {
      await moveTodoToParent(todo.id, newParent.id);
      setCollapsedIds((prev) => {
        if (!prev.has(newParent.id)) return prev;
        const next = new Set(prev);
        next.delete(newParent.id);
        return next;
      });
      await reload();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "階層の変更に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  async function handleBackup() {
    setBackupBusy(true);
    setBackupMessage(null);
    setErrorMessage(null);
    try {
      const backup = await buildTodosBackup();
      const json = JSON.stringify(backup, null, 2);
      const blob = new Blob([json], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const filename = `todo_backup_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}.json`;
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setBackupMessage(`${backup.todos.length}件をバックアップしました(${filename})`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "バックアップに失敗しました");
    } finally {
      setBackupBusy(false);
    }
  }

  function handleRestoreButtonClick() {
    restoreFileInputRef.current?.click();
  }

  async function handleRestoreFileSelected(file: File) {
    setBackupMessage(null);
    setErrorMessage(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as Partial<TodoBackupFile>;
      if (!Array.isArray(parsed.todos)) {
        throw new Error("バックアップファイルの形式が正しくありません(todos配列が見つかりません)");
      }
      const backup = parsed as TodoBackupFile;
      if (
        !window.confirm(
          `現在のTo Doをすべて削除し、バックアップファイル内の${backup.todos.length}件で置き換えます。よろしいですか？(元に戻せません)`,
        )
      ) {
        return;
      }
      setRestoreBusy(true);
      const count = await restoreTodosFromBackup(backup);
      setBackupMessage(`${count}件を復元しました`);
      await reload();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "復元に失敗しました");
    } finally {
      setRestoreBusy(false);
    }
  }

  function renderNode(todo: Todo, depth: number) {
    const children = childrenByParent.get(todo.id) ?? [];
    const hasChildren = children.length > 0;
    const collapsed = collapsedIds.has(todo.id);
    const isEditing = editingId === todo.id;
    const isAddingChild = addingChildFor === todo.id;

    const siblings = childrenByParent.get(todo.parent_id) ?? [];
    const siblingIdx = siblings.findIndex((t) => t.id === todo.id);
    const canMoveUp = siblingIdx > 0;
    const canMoveDown = siblingIdx >= 0 && siblingIdx < siblings.length - 1;
    const canPromote = todo.parent_id !== null;
    const canDemote = siblingIdx > 0;

    return (
      <div key={todo.id}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 4px",
            marginLeft: depth * 22,
            borderRadius: 6,
          }}
        >
          <button
            onClick={() => toggleCollapse(todo.id)}
            disabled={!hasChildren}
            style={{
              width: 18,
              height: 18,
              padding: 0,
              fontSize: 11,
              border: "none",
              background: "transparent",
              color: hasChildren ? "var(--text-secondary)" : "transparent",
              cursor: hasChildren ? "pointer" : "default",
              flexShrink: 0,
            }}
          >
            {hasChildren ? (collapsed ? "▸" : "▾") : "・"}
          </button>

          <input
            type="checkbox"
            checked={todo.done}
            onChange={() => void handleToggleDone(todo)}
            disabled={busy}
            style={{ flexShrink: 0 }}
          />

          {isEditing ? (
            <input
              type="text"
              autoFocus
              value={editingValue}
              onChange={(e) => setEditingValue(e.target.value)}
              onBlur={() => void commitEdit()}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitEdit();
                if (e.key === "Escape") setEditingId(null);
              }}
              style={{ flex: 1, fontSize: 13 }}
            />
          ) : (
            <span
              onDoubleClick={() => startEdit(todo)}
              title="ダブルクリックで編集"
              style={{
                flex: 1,
                fontSize: 13,
                color: todo.done ? "var(--text-muted)" : "var(--text-primary)",
                textDecoration: todo.done ? "line-through" : "none",
                cursor: "text",
                overflowWrap: "anywhere",
              }}
            >
              {todo.title}
              <span style={{ marginLeft: 8, fontSize: 11, color: "var(--text-muted)", textDecoration: "none" }}>
                (追加日時: {formatAddedDate(todo.created_at)})
              </span>
            </span>
          )}

          <button
            onClick={() => void handleMove(todo, "up")}
            disabled={!canMoveUp || busy}
            title="上へ移動"
            style={{ fontSize: 11, padding: "2px 6px", flexShrink: 0 }}
          >
            ▲
          </button>
          <button
            onClick={() => void handleMove(todo, "down")}
            disabled={!canMoveDown || busy}
            title="下へ移動"
            style={{ fontSize: 11, padding: "2px 6px", flexShrink: 0 }}
          >
            ▼
          </button>
          <button
            onClick={() => void handlePromote(todo)}
            disabled={!canPromote || busy}
            title="階層を上げる(親と同じ階層へ)"
            style={{ fontSize: 11, padding: "2px 6px", flexShrink: 0 }}
          >
            ←
          </button>
          <button
            onClick={() => void handleDemote(todo)}
            disabled={!canDemote || busy}
            title="階層を下げる(1つ上の項目の子にする)"
            style={{ fontSize: 11, padding: "2px 6px", flexShrink: 0 }}
          >
            →
          </button>
          <button
            onClick={() => {
              setAddingChildFor(isAddingChild ? null : todo.id);
              setNewChildValue("");
            }}
            style={{ fontSize: 11, padding: "2px 6px", flexShrink: 0 }}
          >
            ＋子を追加
          </button>
          <button
            onClick={() => startEdit(todo)}
            style={{ fontSize: 11, padding: "2px 6px", flexShrink: 0 }}
          >
            編集
          </button>
          <button
            onClick={() => void handleDelete(todo)}
            style={{ fontSize: 11, padding: "2px 6px", flexShrink: 0 }}
          >
            削除
          </button>
        </div>

        {isAddingChild && (
          <div
            style={{
              display: "flex",
              gap: 6,
              marginLeft: (depth + 1) * 22 + 24,
              marginBottom: 4,
            }}
          >
            <input
              type="text"
              autoFocus
              placeholder="子項目の内容"
              value={newChildValue}
              onChange={(e) => setNewChildValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleAddChild(todo.id);
                if (e.key === "Escape") setAddingChildFor(null);
              }}
              style={{ flex: 1, fontSize: 12, maxWidth: 320 }}
            />
            <button onClick={() => void handleAddChild(todo.id)} disabled={busy} style={{ fontSize: 11, padding: "2px 8px" }}>
              追加
            </button>
            <button onClick={() => setAddingChildFor(null)} style={{ fontSize: 11, padding: "2px 8px" }}>
              キャンセル
            </button>
          </div>
        )}

        {!collapsed && children.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  }

  const rootTodos = childrenByParent.get(null) ?? [];

  return (
    <div style={{ height: "100vh", overflowY: "auto", padding: "1.5rem", boxSizing: "border-box", background: "var(--surface-1)" }}>
      <h2 style={{ fontSize: 16, fontWeight: 700, marginTop: 0, marginBottom: 4 }}>To Do</h2>
      <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 0, marginBottom: 16 }}>
        ツリー構造で管理できるTo Doリストです。項目をダブルクリックすると内容を編集できます。
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          type="text"
          placeholder="新しいTo Doを追加"
          value={newRootValue}
          onChange={(e) => setNewRootValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleAddRoot();
          }}
          style={{ flex: 1, maxWidth: 360, fontSize: 13 }}
        />
        <button onClick={() => void handleAddRoot()} disabled={busy}>
          追加
        </button>
        <button onClick={() => void reload()} disabled={loading} style={{ marginLeft: "auto" }}>
          {loading ? "更新中..." : "更新"}
        </button>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16 }}>
        <button onClick={() => void handleBackup()} disabled={backupBusy}>
          {backupBusy ? "バックアップ中..." : "バックアップ(ダウンロード)"}
        </button>
        <button onClick={handleRestoreButtonClick} disabled={restoreBusy}>
          {restoreBusy ? "復元中..." : "バックアップから復元"}
        </button>
        <input
          ref={restoreFileInputRef}
          type="file"
          accept="application/json"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void handleRestoreFileSelected(file);
          }}
        />
        {backupMessage && <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{backupMessage}</span>}
      </div>

      {errorMessage && <p style={{ color: "var(--danger-text)", fontSize: 13 }}>{errorMessage}</p>}
      {loading && <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>読み込み中...</p>}
      {!loading && rootTodos.length === 0 && (
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>To Doはまだありません</p>
      )}

      <div
        style={{
          background: "var(--surface-2)",
          border: "0.5px solid var(--border)",
          borderRadius: 10,
          padding: "8px 6px",
        }}
      >
        {rootTodos.map((t) => renderNode(t, 0))}
      </div>
    </div>
  );
}
