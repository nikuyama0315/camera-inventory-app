import { supabase } from "../supabaseClient";

/** パスワード変更完了後、本人のログインメールアドレス宛に変更通知メールを送る(Edge Function `notify-password-changed` 経由、Gmail送信) */
export async function notifyPasswordChanged(): Promise<void> {
  const { error } = await supabase.functions.invoke("notify-password-changed");
  if (error) throw error;
}

/**
 * Edge Functionが非2xxを返した際、supabase-jsは`error`をFunctionsHttpErrorとして返すが、
 * こちらが返したJSONボディ(`{error: "日本語メッセージ"}`)は自動では読み込まれない
 * (`error.context`が未パースのResponseのまま渡ってくる)。ここでボディを読み取り、
 * 無ければ汎用メッセージにフォールバックする。
 */
async function extractEdgeFunctionErrorMessage(error: unknown, fallback: string): Promise<string> {
  const context = (error as { context?: unknown } | null)?.context;
  if (context instanceof Response) {
    try {
      const body = await context.clone().json();
      if (body && typeof body === "object" && "error" in body && body.error) {
        return String((body as { error: unknown }).error);
      }
    } catch {
      /* ボディがJSONでない場合はフォールバックする */
    }
  }
  return error instanceof Error ? error.message : fallback;
}

/**
 * 共有ユーザー名/パスワードでログインする(2026-09-08、ebay-automationと同じ認証方式に統一)。
 * Edge Function `app-login` で照合し、成功時に返るemail_otpをsupabase.auth.verifyOtp()に渡すことで
 * 本物のSupabaseセッションを確立する(実際のメール送信は発生しない。実機検証済み)。
 */
export async function loginWithSharedCredentials(username: string, password: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke("app-login", { body: { username, password } });
  if (error) throw new Error(await extractEdgeFunctionErrorMessage(error, "ログインに失敗しました"));

  const result = data as { email: string; token: string };
  const { error: verifyError } = await supabase.auth.verifyOtp({
    email: result.email,
    token: result.token,
    type: "magiclink",
  });
  if (verifyError) throw verifyError;
}

/** 「ログイン情報再設定」画面: 現在のパスワードを確認のうえ新しいパスワードに変更する。 */
export async function changeSharedPassword(currentPassword: string, newPassword: string): Promise<void> {
  const { error } = await supabase.functions.invoke("app-change-password", {
    body: { currentPassword, newPassword },
  });
  if (error) throw new Error(await extractEdgeFunctionErrorMessage(error, "パスワードの変更に失敗しました"));
}

/** 「ログイン情報再設定」画面: 現在のパスワードを確認のうえリカバリーコードを再発行する(新コードを一度だけ返す)。 */
export async function reissueRecoveryCode(currentPassword: string): Promise<string> {
  const { data, error } = await supabase.functions.invoke("app-recovery-code-reissue", {
    body: { currentPassword },
  });
  if (error) throw new Error(await extractEdgeFunctionErrorMessage(error, "リカバリーコードの再発行に失敗しました"));
  return (data as { newRecoveryCode: string }).newRecoveryCode;
}

/** ログイン画面「パスワードを忘れた場合」: リカバリーコードで新しいパスワードを設定する(新しいリカバリーコードを一度だけ返す)。 */
export async function resetPasswordWithRecoveryCode(recoveryCode: string, newPassword: string): Promise<string> {
  const { data, error } = await supabase.functions.invoke("app-forgot-password", {
    body: { recoveryCode, newPassword },
  });
  if (error) throw new Error(await extractEdgeFunctionErrorMessage(error, "パスワードの再設定に失敗しました"));
  return (data as { newRecoveryCode: string }).newRecoveryCode;
}
