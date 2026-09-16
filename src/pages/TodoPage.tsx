import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchAllTodos,
  createTodo,
  updateTodoTitle,
  updateTodoSortOrder,
  moveTodoToParent,
  setTodoDone,
  setTodoImportant,
  setTodoDueAt,
  deleteTodo,
  buildTodosBackup,
  restoreTodosFromBackup,
  fetchAttachmentsForTodoIds,
  uploadTodoAttachment,
  deleteTodoAttachment,
  deleteAttachmentsForTodoIds,
  getAttachmentSignedUrl,
  updateTodoMemo,
  type Todo,
  type TodoBackupFile,
  type TodoAttachment,
} from "../lib/api/todos";

/** ヘッダーの「To Do」ボタンから新規ウィンドウで開かれる、ツリー構造のTo Doリスト単体ページ(2026-09-11追加)。
 *  App.tsx側でURLクエリ`?view=todo`を検出したとき、通常のタブ画面の代わりにこのページを描画する
 *  (認証セッションはSupabaseクライアントのlocalStorage永続化により同一オリジンの別ウィンドウでも共有される)。 */
export default function TodoPage() {
  // 件名一覧のゼブラ表示用(2026-09-15追加)。renderNode内で参照するカウンタ(親子構造を無視し、
  // 画面表示順に1行ごとインクリメントする)。毎レンダーの描画直前にrootTodosの手前で0にリセットする。
  const zebraIndexRef = useRef(0);
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

  // 添付ファイル(2026-09-12追加)
  const [attachments, setAttachments] = useState<TodoAttachment[]>([]);
  const [expandedAttachmentsFor, setExpandedAttachmentsFor] = useState<Set<string>>(new Set());
  const [uploadingFor, setUploadingFor] = useState<string | null>(null);
  const [deletingAttachmentId, setDeletingAttachmentId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [attachmentMessage, setAttachmentMessage] = useState<string | null>(null);
  const uploadTargetIdRef = useRef<string | null>(null);
  const attachFileInputRef = useRef<HTMLInputElement>(null);

  // アイテムごとのメモ(添付ファイルパネル内、2026-09-13追加)
  const [memoValues, setMemoValues] = useState<Record<string, string>>({});
  const [savingMemoFor, setSavingMemoFor] = useState<string | null>(null);

  // 期限日時(2026-09-12追加)
  const [editingDueForId, setEditingDueForId] = useState<string | null>(null);
  const [editingDueValue, setEditingDueValue] = useState("");
  // 期限切れ判定用の「現在時刻」。1分ごとに更新し、ページを開きっぱなしでも期限切れ表示が追従するようにする。
  const [now, setNow] = useState(() => new Date());

  /**
   * 日時を"yyyy/mm/dd hh:mm"形式・日本時間(JST)で表示するためのフォーマッタ(追加日時・完了日時共通)。
   * 閲覧者のブラウザのタイムゾーン設定に依らず、常に日本時間で表示する
   * (ロケール依存の区切り文字ゆらぎを避けるため、パーツを個別に取り出して手動で組み立てる)。
   */
  function formatDateTime(iso: string): string {
    const parts = new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(iso));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("year")}/${get("month")}/${get("day")} ${get("hour")}:${get("minute")}`;
  }

  /**
   * <input type="datetime-local">用に、ISO文字列をその入力欄が要求する"yyyy-MM-ddTHH:mm"形式
   * (ブラウザのローカル時刻表現)に変換する。datetime-local入力欄はブラウザのローカルタイムゾーンでしか
   * 値を扱えない仕様のため、表示側のformatDateTime()のように常に日本時間へ変換する手段が無い
   * (この業務システムは日本国内での利用を前提としているため実用上は問題にならない想定)。
   */
  function toDatetimeLocalValue(iso: string): string {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function startEditDue(todo: Todo) {
    setEditingDueForId(todo.id);
    setEditingDueValue(todo.due_at ? toDatetimeLocalValue(todo.due_at) : "");
  }

  async function commitDueEdit(todoId: string) {
    setBusy(true);
    setErrorMessage(null);
    try {
      const dueAt = editingDueValue ? new Date(editingDueValue).toISOString() : null;
      await setTodoDueAt(todoId, dueAt);
      setEditingDueForId(null);
      await reload();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "期限の更新に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  async function clearDue(todoId: string) {
    setBusy(true);
    setErrorMessage(null);
    try {
      await setTodoDueAt(todoId, null);
      setEditingDueForId(null);
      await reload();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "期限の解除に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  function isTodoOverdue(todo: Todo): boolean {
    return !todo.done && !!todo.due_at && new Date(todo.due_at).getTime() < now.getTime();
  }

  async function reload() {
    setLoading(true);
    setErrorMessage(null);
    try {
      const rows = await fetchAllTodos();
      setTodos(rows);
      setAttachments(await fetchAttachmentsForTodoIds(rows.map((r) => r.id)));
      setMemoValues((prev) => {
        const next = { ...prev };
        for (const r of rows) {
          if (next[r.id] === undefined) next[r.id] = r.memo ?? "";
        }
        return next;
      });
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "読み込みに失敗しました");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  // このページは独立したウィンドウ(named window "soulmen_todo_window")で開かれるため、
  // メインアプリ(index.htmlの<title>「Soulmen Japan Business Portal」)とは別に
  // タブタイトルを上書きする(2026-09-12追加)。
  useEffect(() => {
    document.title = "Soulmen Japan To Do";
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(timer);
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

  const overdueTodos = useMemo(
    () => todos.filter((t) => !t.done && t.due_at && new Date(t.due_at).getTime() < now.getTime()),
    [todos, now],
  );

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

  async function handleToggleImportant(todo: Todo) {
    setBusy(true);
    setErrorMessage(null);
    try {
      await setTodoImportant(todo.id, !todo.is_important);
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

  /** 指定したTo Do自身と、その配下(子孫)すべてのIDを列挙する(添付ファイルのカスケード削除用)。 */
  function collectSelfAndDescendantIds(id: string): string[] {
    const result: string[] = [id];
    const children = childrenByParent.get(id) ?? [];
    for (const c of children) {
      result.push(...collectSelfAndDescendantIds(c.id));
    }
    return result;
  }

  async function handleDelete(todo: Todo) {
    const hasChildren = (childrenByParent.get(todo.id)?.length ?? 0) > 0;
    const confirmMessage = hasChildren
      ? `「${todo.title}」を削除します。配下の項目・添付ファイルもすべて削除されますがよろしいですか？`
      : `「${todo.title}」を削除しますか？(添付ファイルがあれば、それも削除されます)`;
    if (!window.confirm(confirmMessage)) return;
    setBusy(true);
    setErrorMessage(null);
    try {
      // todosのDB行自体(と、それに紐づくtodo_attachmentsのDB行)はON DELETE CASCADEで
      // 自動的に消えるが、ストレージ上の実ファイルはそれとは別に明示的に削除する必要がある
      // ため、削除対象(自分+配下すべて)を先に洗い出してから削除する。
      const targetIds = collectSelfAndDescendantIds(todo.id);
      await deleteAttachmentsForTodoIds(targetIds);
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

  /** 同じ親を持つ兄弟の中で、一番上/一番下へ一気に移動する(全兄弟のsort_orderを新しい順序で振り直す)。 */
  async function handleMoveToEdge(todo: Todo, edge: "top" | "bottom") {
    const siblings = childrenByParent.get(todo.parent_id) ?? [];
    const idx = siblings.findIndex((t) => t.id === todo.id);
    if (idx === -1) return;
    if (edge === "top" && idx === 0) return;
    if (edge === "bottom" && idx === siblings.length - 1) return;

    const reordered = siblings.filter((t) => t.id !== todo.id);
    if (edge === "top") reordered.unshift(todo);
    else reordered.push(todo);

    setBusy(true);
    setErrorMessage(null);
    try {
      await Promise.all(reordered.map((t, i) => updateTodoSortOrder(t.id, i)));
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

  function toggleAttachments(todoId: string) {
    setExpandedAttachmentsFor((prev) => {
      const next = new Set(prev);
      if (next.has(todoId)) next.delete(todoId);
      else next.add(todoId);
      return next;
    });
  }

  function attachmentsFor(todoId: string): TodoAttachment[] {
    return attachments.filter((a) => a.todo_id === todoId);
  }

  async function uploadFilesToTodo(todoId: string, files: FileList | File[]) {
    const fileArray = Array.from(files);
    if (fileArray.length === 0) return;
    setUploadingFor(todoId);
    setErrorMessage(null);
    setAttachmentMessage(null);
    try {
      for (const file of fileArray) {
        await uploadTodoAttachment(todoId, file);
      }
      setExpandedAttachmentsFor((prev) => new Set(prev).add(todoId));
      await reload();
      setAttachmentMessage(
        `${fileArray.length}件のファイルを添付しました(📎ボタンの一覧に表示されています)`,
      );
      setTimeout(() => setAttachmentMessage((cur) => (cur ? null : cur)), 5000);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "添付ファイルのアップロードに失敗しました");
    } finally {
      setUploadingFor(null);
    }
  }

  function handleAttachButtonClick(todoId: string) {
    uploadTargetIdRef.current = todoId;
    attachFileInputRef.current?.click();
  }

  function handleAttachFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    // e.target.filesは入力欄の状態と連動した"生きた"FileListのため、配列にコピーして
    // ファイル本体(File)を確保してからでないと、直後のe.target.value=""でリストの中身が
    // 消えてしまう(実機で確認: filesはlength=1で来ているのに、e.target.value=""の後に
    // 参照すると0件になっていた)。
    const files = e.target.files ? Array.from(e.target.files) : [];
    const todoId = uploadTargetIdRef.current;
    e.target.value = "";
    if (files.length > 0 && todoId) void uploadFilesToTodo(todoId, files);
  }

  function handleRowDragEnter(todoId: string, e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOverId(todoId);
  }

  function handleRowDragOver(todoId: string, e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (dragOverId !== todoId) setDragOverId(todoId);
  }

  function handleRowDragLeave(todoId: string) {
    setDragOverId((cur) => (cur === todoId ? null : cur));
  }

  function handleRowDrop(todoId: string, e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOverId(null);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length > 0) {
      void uploadFilesToTodo(todoId, files);
    }
  }

  async function handleOpenAttachment(attachment: TodoAttachment) {
    setErrorMessage(null);
    try {
      const url = await getAttachmentSignedUrl(attachment.storage_path);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "添付ファイルを開けませんでした");
    }
  }

  async function handleDeleteAttachment(attachment: TodoAttachment) {
    if (!window.confirm(`「${attachment.file_name}」を削除しますか？`)) return;
    setDeletingAttachmentId(attachment.id);
    setErrorMessage(null);
    try {
      await deleteTodoAttachment(attachment);
      await reload();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "添付ファイルの削除に失敗しました");
    } finally {
      setDeletingAttachmentId(null);
    }
  }

  function formatFileSize(bytes: number | null): string {
    if (bytes == null) return "";
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  async function handleSaveMemo(todoId: string, currentSavedValue: string | null) {
    const value = memoValues[todoId] ?? "";
    setSavingMemoFor(todoId);
    setErrorMessage(null);
    try {
      await updateTodoMemo(todoId, value);
      await reload();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "メモの保存に失敗しました");
    } finally {
      setSavingMemoFor(null);
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
    const todoAttachments = attachmentsFor(todo.id);
    const attachmentsExpanded = expandedAttachmentsFor.has(todo.id);
    const isDragOver = dragOverId === todo.id;
    const overdue = isTodoOverdue(todo);
    const memoValue = memoValues[todo.id] ?? (todo.memo ?? "");
    const isMemoDirty = memoValue !== (todo.memo ?? "");
    const isSavingMemo = savingMemoFor === todo.id;
    const isEditingDue = editingDueForId === todo.id;
    // 件名一覧のゼブラ表示用(2026-09-15追加)。階層(親子)構造を無視し、実際に画面へ表示される
    // 行の上から順番(深さ優先)で1行ごとに背景色を交互にする。
    const zebraRowIndex = zebraIndexRef.current++;
    const isZebraRow = zebraRowIndex % 2 === 1;

    return (
      <div key={todo.id}>
        <div
          onDragEnter={(e) => handleRowDragEnter(todo.id, e)}
          onDragOver={(e) => handleRowDragOver(todo.id, e)}
          onDragLeave={() => handleRowDragLeave(todo.id)}
          onDrop={(e) => handleRowDrop(todo.id, e)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 4px",
            marginLeft: depth * 22,
            borderRadius: 6,
            background: isDragOver ? "var(--surface-1)" : isZebraRow ? "#eef0f2" : undefined,
            outline: isDragOver ? "2px dashed var(--accent, #185fa5)" : "none",
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

          <button
            onClick={() => void handleToggleImportant(todo)}
            disabled={busy}
            title={todo.is_important ? "重要を解除" : "重要にする"}
            style={{
              width: 20,
              height: 20,
              padding: 0,
              fontSize: 14,
              lineHeight: "20px",
              border: "none",
              background: "transparent",
              color: todo.is_important ? "#d32f2f" : "var(--text-muted)",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            {todo.is_important ? "★" : "☆"}
          </button>

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
                cursor: "text",
                overflowWrap: "anywhere",
              }}
            >
              <span style={{ textDecoration: todo.done ? "line-through" : "none" }}>{todo.title}</span>
              {todo.is_important && (
                <span
                  style={{
                    marginLeft: 6,
                    fontSize: 10,
                    fontWeight: 700,
                    color: "#fff",
                    background: "#d32f2f",
                    borderRadius: 4,
                    padding: "1px 5px",
                  }}
                >
                  重要
                </span>
              )}
              {overdue && (
                <span
                  style={{
                    marginLeft: 6,
                    fontSize: 10,
                    fontWeight: 700,
                    color: "#fff",
                    background: "#d32f2f",
                    borderRadius: 4,
                    padding: "1px 5px",
                  }}
                >
                  期限切れ
                </span>
              )}
              <span
                style={{
                  marginLeft: 8,
                  fontSize: 11,
                  color: "var(--text-muted)",
                  textDecoration: todo.done ? "line-through" : "none",
                }}
              >
                (追加日時: {formatDateTime(todo.created_at)})
              </span>
              {(todo.due_at || !todo.done) && (isEditingDue ? (
                <span
                  style={{ marginLeft: 8, display: "inline-flex", gap: 4, alignItems: "center" }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="datetime-local"
                    autoFocus
                    value={editingDueValue}
                    onChange={(e) => setEditingDueValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitDueEdit(todo.id);
                      if (e.key === "Escape") setEditingDueForId(null);
                    }}
                    style={{ fontSize: 11 }}
                  />
                  <button
                    onClick={() => void commitDueEdit(todo.id)}
                    disabled={busy}
                    style={{ fontSize: 10, padding: "1px 6px" }}
                  >
                    保存
                  </button>
                  {todo.due_at && (
                    <button
                      onClick={() => void clearDue(todo.id)}
                      disabled={busy}
                      style={{ fontSize: 10, padding: "1px 6px" }}
                    >
                      解除
                    </button>
                  )}
                  <button
                    onClick={() => setEditingDueForId(null)}
                    style={{ fontSize: 10, padding: "1px 6px" }}
                  >
                    キャンセル
                  </button>
                </span>
              ) : (
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    startEditDue(todo);
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                  title="クリックして期限日時を設定・変更"
                  style={{
                    marginLeft: 8,
                    fontSize: 11,
                    cursor: "pointer",
                    textDecoration: "underline dotted",
                    color: overdue ? "#d32f2f" : todo.due_at ? "var(--text-secondary)" : "var(--text-muted)",
                    fontWeight: overdue ? 700 : 400,
                  }}
                >
                  {todo.due_at ? `期限: ${formatDateTime(todo.due_at)}` : "＋期限を設定"}
                </span>
              ))}
              {todo.done && todo.completed_at && (
                <span style={{ marginLeft: 8, fontSize: 11, color: "var(--text-muted)" }}>
                  (完了日時: {formatDateTime(todo.completed_at)})
                </span>
              )}
            </span>
          )}

          <button
            onClick={() => void handleMoveToEdge(todo, "top")}
            disabled={!canMoveUp || busy}
            title="一番上へ移動"
            style={{ fontSize: 11, padding: "2px 6px", flexShrink: 0 }}
          >
            ⏫
          </button>
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
            onClick={() => void handleMoveToEdge(todo, "bottom")}
            disabled={!canMoveDown || busy}
            title="一番下へ移動"
            style={{ fontSize: 11, padding: "2px 6px", flexShrink: 0 }}
          >
            ⏬
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
            onClick={() => toggleAttachments(todo.id)}
            title="添付ファイルを表示/追加(クリックして開閉)"
            style={{
              fontSize: 11,
              padding: "2px 6px",
              flexShrink: 0,
              fontWeight: todoAttachments.length > 0 ? 700 : 400,
            }}
          >
            📎{todoAttachments.length}
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

        {attachmentsExpanded && (
          <div
            style={{
              marginLeft: (depth + 1) * 22 + 24,
              marginBottom: 6,
              padding: "6px 8px",
              border: "0.5px dashed var(--border)",
              borderRadius: 6,
              background: "var(--surface-1)",
              display: "flex",
              gap: 12,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              {todoAttachments.length === 0 && (
                <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "0 0 6px" }}>
                  添付ファイルはありません(タスク行の上へドラッグ&ドロップ、または下のボタンで追加できます)
                </p>
              )}
              {todoAttachments.map((a) => (
                <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <button
                    onClick={() => void handleOpenAttachment(a)}
                    style={{ fontSize: 11, padding: "1px 6px", textAlign: "left" }}
                    title={a.file_name}
                  >
                    {a.file_name}
                  </button>
                  <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{formatFileSize(a.size_bytes)}</span>
                  <button
                    onClick={() => void handleDeleteAttachment(a)}
                    disabled={deletingAttachmentId === a.id}
                    style={{ fontSize: 10, padding: "1px 6px", marginLeft: "auto" }}
                  >
                    削除
                  </button>
                </div>
              ))}
              <button
                onClick={() => handleAttachButtonClick(todo.id)}
                disabled={uploadingFor === todo.id}
                style={{ fontSize: 11, padding: "2px 8px" }}
              >
                {uploadingFor === todo.id ? "アップロード中..." : "ファイルを選択して添付"}
              </button>
            </div>
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
              <textarea
                value={memoValue}
                onChange={(e) =>
                  setMemoValues((prev) => ({ ...prev, [todo.id]: e.target.value }))
                }
                placeholder="メモ"
                disabled={isSavingMemo}
                style={{ fontSize: 12, width: "100%", minHeight: 60, resize: "vertical", boxSizing: "border-box" }}
              />
              {isMemoDirty && (
                <button
                  onClick={() => void handleSaveMemo(todo.id, todo.memo)}
                  disabled={isSavingMemo}
                  style={{ fontSize: 11, padding: "2px 8px", alignSelf: "flex-start" }}
                >
                  {isSavingMemo ? "保存中..." : "保存"}
                </button>
              )}
            </div>
          </div>
        )}

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

  zebraIndexRef.current = 0;
  const rootTodos = childrenByParent.get(null) ?? [];

  return (
    <div
      onDragOver={(e) => {
        // ページ全体でブラウザ既定のファイルドロップ動作(ドロップしたファイルを新規タブで
        // 開いてしまう)を止める安全策(2026-09-12追加、ユーザー報告: タスク行の外側に
        // ドロップするとブラウザがファイルをそのまま開いてしまっていた)。各タスク行自体の
        // ドロップ処理は行側のonDropでstopPropagationしているため、ここまでバブリングして
        // くるのは「どの行にも当たらなかったドロップ」のみ。
        e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        setErrorMessage("ファイルは追加したいタスクの行の上にドロップしてください");
      }}
      style={{ height: "100vh", overflowY: "auto", padding: "1.5rem", boxSizing: "border-box", background: "var(--surface-1)" }}
    >
      <h2 style={{ fontSize: 16, fontWeight: 700, marginTop: 0, marginBottom: 4 }}>To Do</h2>
      <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 0, marginBottom: 16 }}>
        ツリー構造で管理できるTo Doリストです。項目をダブルクリックすると内容を編集できます。
      </p>

      {overdueTodos.length > 0 && (
        <div
          style={{
            background: "var(--danger-bg)",
            border: "0.5px solid var(--danger-text)",
            borderRadius: 8,
            padding: "10px 14px",
            marginBottom: 16,
            color: "var(--danger-text)",
            fontSize: 13,
          }}
        >
          <strong>期限切れの未完了To Doが{overdueTodos.length}件あります</strong>
          <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
            {overdueTodos.map((t) => (
              <li key={t.id}>
                {t.title}(期限: {formatDateTime(t.due_at as string)})
              </li>
            ))}
          </ul>
        </div>
      )}

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
        <input
          ref={attachFileInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={handleAttachFileInputChange}
        />
        <button onClick={() => void reload()} disabled={loading} style={{ marginLeft: "auto" }}>
          {loading ? "更新中..." : "更新"}
        </button>
      </div>

      {backupMessage && (
        <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: -8, marginBottom: 16 }}>
          {backupMessage}
        </p>
      )}

      {attachmentMessage && (
        <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>{attachmentMessage}</p>
      )}
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
