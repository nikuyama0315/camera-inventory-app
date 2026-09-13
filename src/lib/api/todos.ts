import { supabase } from "../supabaseClient";

export interface Todo {
  id: string;
  parent_id: string | null;
  title: string;
  done: boolean;
  is_important: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  due_at: string | null;
  memo: string | null;
}

export async function fetchAllTodos(): Promise<Todo[]> {
  const { data, error } = await supabase
    .from("todos")
    .select("*")
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data as Todo[];
}

/** 指定した親の直下(parentIdがnullならルート直下)の兄弟の中で、末尾に追加するsort_orderを求める。 */
async function nextSortOrder(parentId: string | null): Promise<number> {
  let query = supabase.from("todos").select("sort_order").order("sort_order", { ascending: false }).limit(1);
  query = parentId ? query.eq("parent_id", parentId) : query.is("parent_id", null);
  const { data, error } = await query;
  if (error) throw error;
  const rows = data as { sort_order: number }[];
  return rows.length > 0 ? rows[0].sort_order + 1 : 0;
}

export async function createTodo(parentId: string | null, title: string): Promise<Todo> {
  const sortOrder = await nextSortOrder(parentId);
  const { data, error } = await supabase
    .from("todos")
    .insert({ parent_id: parentId, title, sort_order: sortOrder })
    .select("*")
    .single();
  if (error) throw error;
  return data as Todo;
}

export async function updateTodoTitle(id: string, title: string): Promise<void> {
  const { error } = await supabase
    .from("todos")
    .update({ title, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

/** アイテムごとのテキストメモを保存する(添付ファイルパネル内、2026-09-13追加)。 */
export async function updateTodoMemo(id: string, memo: string): Promise<void> {
  const { error } = await supabase
    .from("todos")
    .update({ memo, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

export async function setTodoDone(id: string, done: boolean): Promise<void> {
  const { error } = await supabase
    .from("todos")
    .update({
      done,
      completed_at: done ? new Date().toISOString() : null,
      // 完了を取り消した場合、期限切れ警告メールを再度送れるようにリセットする
      // (再オープンしたタスクが引き続き/再び期限切れのままなら、次回チェック時に再通知されるべきため)。
      ...(done ? {} : { due_alert_sent_at: null }),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw error;
}

/** 「重要」マーク(赤バッジ表示)のON/OFFを切り替える。 */
export async function setTodoImportant(id: string, isImportant: boolean): Promise<void> {
  const { error } = await supabase
    .from("todos")
    .update({ is_important: isImportant, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

/** 期限日時を設定・変更・解除する(dueAt=nullで期限なしに戻す)。 */
export async function setTodoDueAt(id: string, dueAt: string | null): Promise<void> {
  const { error } = await supabase
    .from("todos")
    // 期限日時を変更(延長・繰り下げ含む)するたびに通知済みフラグをリセットする。新しい期限を
    // 過ぎたときに改めてメール警告できるようにするため。
    .update({ due_at: dueAt, due_alert_sent_at: null, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

/** Edge Functionを呼び出し、期限切れなのに未完了のTo Doがあればまとめてメール通知する。 */
export async function checkTodoDueAlertsAndNotify(): Promise<{ notified: string[] } | null> {
  const { data, error } = await supabase.functions.invoke("check-todo-due-alerts");
  if (error) throw error;
  return data as { notified: string[] };
}

/** 期限切れ(due_atを過ぎているのに未完了)のTo Do件数を取得する(ヘッダーの警告バナー用の軽量クエリ)。 */
export async function fetchOverdueTodoCount(): Promise<number> {
  const { count, error } = await supabase
    .from("todos")
    .select("id", { count: "exact", head: true })
    .eq("done", false)
    .lt("due_at", new Date().toISOString());
  if (error) throw error;
  return count ?? 0;
}

/** 削除すると配下(子孫)もDB側のON DELETE CASCADEで一緒に削除される。 */
export async function deleteTodo(id: string): Promise<void> {
  const { error } = await supabase.from("todos").delete().eq("id", id);
  if (error) throw error;
}

export async function updateTodoSortOrder(id: string, sortOrder: number): Promise<void> {
  const { error } = await supabase
    .from("todos")
    .update({ sort_order: sortOrder, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

/** 項目の階層(親)を変更する。新しい親の子リストの末尾に追加される。 */
export async function moveTodoToParent(id: string, newParentId: string | null): Promise<void> {
  const sortOrder = await nextSortOrder(newParentId);
  const { error } = await supabase
    .from("todos")
    .update({ parent_id: newParentId, sort_order: sortOrder, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

export interface TodoBackupFile {
  exported_at: string;
  todos: Todo[];
}

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/** 現在の全To Doをバックアップ用のJSON構造として取得する。 */
export async function buildTodosBackup(): Promise<TodoBackupFile> {
  const todos = await fetchAllTodos();
  return { exported_at: new Date().toISOString(), todos };
}

/**
 * バックアップJSONから全To Doを復元する(既存のTo Doはすべて置き換わる)。
 * id/parent_id/sort_order/created_atを保持するため、まずparent_idをnullにした状態で
 * 全行を挿入し(親子の挿入順を気にしなくて済む)、その後に本来のparent_idを行ごとに反映する。
 */
export async function restoreTodosFromBackup(backup: TodoBackupFile): Promise<number> {
  const rows = backup.todos;

  const { error: delError } = await supabase.from("todos").delete().neq("id", ZERO_UUID);
  if (delError) throw delError;
  if (rows.length === 0) return 0;

  const insertRows = rows.map((r) => ({
    id: r.id,
    parent_id: null,
    title: r.title,
    done: r.done,
    is_important: r.is_important ?? false,
    sort_order: r.sort_order,
    created_at: r.created_at,
    updated_at: r.updated_at,
    completed_at: r.completed_at,
    due_at: r.due_at ?? null,
  }));
  const { error: insError } = await supabase.from("todos").insert(insertRows);
  if (insError) throw insError;

  const withParent = rows.filter((r) => r.parent_id !== null);
  for (const r of withParent) {
    const { error: updError } = await supabase.from("todos").update({ parent_id: r.parent_id }).eq("id", r.id);
    if (updError) throw updError;
  }

  return rows.length;
}

// ---------------------------------------------------------------
// 添付ファイル(2026-09-12追加)
// ---------------------------------------------------------------

const ATTACHMENT_BUCKET = "todo-attachments";

export interface TodoAttachment {
  id: string;
  todo_id: string;
  file_name: string;
  storage_path: string;
  size_bytes: number | null;
  content_type: string | null;
  created_at: string;
}

/** 複数のTo Do IDに紐づく添付ファイルをまとめて取得する(一覧表示・階層丸ごと削除時の対象洗い出し用)。 */
export async function fetchAttachmentsForTodoIds(todoIds: string[]): Promise<TodoAttachment[]> {
  if (todoIds.length === 0) return [];
  const { data, error } = await supabase
    .from("todo_attachments")
    .select("*")
    .in("todo_id", todoIds)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data as TodoAttachment[];
}

/**
 * ファイル名の重複回避用に、一意な文字列を生成する。
 * crypto.randomUUID()はセキュアコンテキスト(HTTPS、またはlocalhost)でしか使えず、
 * このアプリはプレーンHTTP配信のため呼び出すとTypeErrorになり、添付アップロードが
 * 常に失敗する不具合があった(ユーザー報告により発覚。クリップボードコピー機能で
 * 過去に踏んだのと同じ制約)。crypto.randomUUID()が使える環境ではそちらを優先し、
 * 使えない場合は現在時刻+乱数によるフォールバックを使う。
 */
function generateUniqueSuffix(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {
      /* セキュアコンテキストでない場合など、呼び出し自体が例外になることがあるためフォールバックへ */
    }
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * ストレージ保存キー用に、拡張子だけを安全に取り出す(英数字のみ、無ければ空文字)。
 * 元のファイル名をそのまま保存パスに使うと、"#"(URLフラグメント区切り)や空白・カンマ等の
 * 特殊文字を含む場合にアップロード先のキーが途中で切れてしまう不具合があった
 * (実データで確認: "....PBC #2269-0645-3513.pdf"というファイル名で、保存されたオブジェクト名が
 * "#"の手前で切れ、DB上のstorage_pathと実体が食い違っていた)。ファイル名は表示用として
 * file_name列にそのまま保存し、実際の保存パスには含めないことで回避する。
 */
function safeFileExtension(fileName: string): string {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(fileName);
  return match ? `.${match[1].toLowerCase()}` : "";
}

/** 添付ファイルをアップロードし、todo_attachmentsに行を作成する。 */
export async function uploadTodoAttachment(todoId: string, file: File): Promise<TodoAttachment> {
  const storagePath = `${todoId}/${generateUniqueSuffix()}${safeFileExtension(file.name)}`;
  const { error: uploadError } = await supabase.storage.from(ATTACHMENT_BUCKET).upload(storagePath, file);
  if (uploadError) throw uploadError;

  const { data, error: insertError } = await supabase
    .from("todo_attachments")
    .insert({
      todo_id: todoId,
      file_name: file.name,
      storage_path: storagePath,
      size_bytes: file.size,
      content_type: file.type || null,
    })
    .select("*")
    .single();
  if (insertError) throw insertError;
  return data as TodoAttachment;
}

/** 添付ファイル1件を削除する(ストレージの実ファイル→DB行の順)。 */
export async function deleteTodoAttachment(attachment: TodoAttachment): Promise<void> {
  const { error: storageError } = await supabase.storage.from(ATTACHMENT_BUCKET).remove([attachment.storage_path]);
  if (storageError) throw storageError;
  const { error: dbError } = await supabase.from("todo_attachments").delete().eq("id", attachment.id);
  if (dbError) throw dbError;
}

/**
 * 指定したTo Do ID群に紐づく添付ファイルのストレージ実体をまとめて削除する
 * (todo_attachmentsのDB行自体はtodosのON DELETE CASCADEで自動削除されるため、
 * ここではストレージ側の実ファイルの削除のみを担当する。To Do削除前に呼ぶこと)。
 */
export async function deleteAttachmentsForTodoIds(todoIds: string[]): Promise<void> {
  const attachments = await fetchAttachmentsForTodoIds(todoIds);
  if (attachments.length === 0) return;
  const paths = attachments.map((a) => a.storage_path);
  const { error } = await supabase.storage.from(ATTACHMENT_BUCKET).remove(paths);
  if (error) throw error;
}

/** 非公開バケットのため、ダウンロード/表示用の署名付きURLを発行する(1時間有効)。 */
export async function getAttachmentSignedUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage.from(ATTACHMENT_BUCKET).createSignedUrl(storagePath, 3600);
  if (error) throw error;
  return data.signedUrl;
}
