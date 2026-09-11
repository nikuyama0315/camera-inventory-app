import { supabase } from "../supabaseClient";

export interface Todo {
  id: string;
  parent_id: string | null;
  title: string;
  done: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
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
    .update({ done, updated_at: new Date().toISOString() })
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
