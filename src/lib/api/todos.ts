import { supabase } from "../supabaseClient";

export interface Todo {
  id: string;
  parent_id: string | null;
  title: string;
  done: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
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

export async function setTodoDone(id: string, done: boolean): Promise<void> {
  const { error } = await supabase
    .from("todos")
    .update({
      done,
      completed_at: done ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw error;
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
    sort_order: r.sort_order,
    created_at: r.created_at,
    updated_at: r.updated_at,
    completed_at: r.completed_at,
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

/** 添付ファイルをアップロードし、todo_attachmentsに行を作成する。 */
export async function uploadTodoAttachment(todoId: string, file: File): Promise<TodoAttachment> {
  const storagePath = `${todoId}/${crypto.randomUUID()}-${file.name}`;
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
