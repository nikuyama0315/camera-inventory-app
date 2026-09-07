import { supabase } from "../supabaseClient";

/** パスワード変更完了後、本人のログインメールアドレス宛に変更通知メールを送る(Edge Function `notify-password-changed` 経由、Gmail送信) */
export async function notifyPasswordChanged(): Promise<void> {
  const { error } = await supabase.functions.invoke("notify-password-changed");
  if (error) throw error;
}
