import { useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { notifyPasswordChanged } from "../lib/api/auth";

interface Props {
  onCompleted: () => void;
}

export default function ResetPasswordPage({ onCompleted }: Props) {
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMessage(null);

    if (!password || password.length < 8) {
      setErrorMessage("パスワードは8文字以上で入力してください");
      return;
    }
    if (password !== passwordConfirm) {
      setErrorMessage("確認用パスワードが一致しません");
      return;
    }

    setBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      // 不正検知用の通知メール送信。失敗してもパスワード変更自体はブロックしない(ベストエフォート)
      notifyPasswordChanged().catch(() => {});
      onCompleted();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "パスワードの更新に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh" }}>
      <form
        onSubmit={handleSubmit}
        style={{
          width: 320,
          padding: "2rem",
          border: "0.5px solid var(--border)",
          borderRadius: 12,
          background: "var(--surface-2)",
        }}
      >
        <p style={{ fontSize: 16, fontWeight: 500, marginTop: 0, marginBottom: 16 }}>
          新しいパスワードを設定
        </p>
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
            新パスワード(8文字以上)
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ width: "100%" }}
            autoComplete="new-password"
          />
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 12, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
            新パスワード(確認用)
          </label>
          <input
            type="password"
            value={passwordConfirm}
            onChange={(e) => setPasswordConfirm(e.target.value)}
            style={{ width: "100%" }}
            autoComplete="new-password"
          />
        </div>
        {errorMessage && (
          <p style={{ color: "var(--danger-text)", fontSize: 13, marginBottom: 12 }}>{errorMessage}</p>
        )}
        <button type="submit" disabled={busy} style={{ width: "100%" }}>
          {busy ? "更新中..." : "パスワードを更新"}
        </button>
      </form>
    </div>
  );
}
