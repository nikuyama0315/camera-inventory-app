import { useState } from "react";
import { loginWithSharedCredentials, resetPasswordWithRecoveryCode } from "../lib/api/auth";
import logo from "../assets/logo.png";

interface Props {
  onLoggedIn: () => void;
}

const CARD_STYLE: React.CSSProperties = {
  width: 320,
  padding: "2rem",
  border: "0.5px solid var(--border)",
  borderRadius: 12,
  background: "var(--surface-2)",
};

/**
 * ログイン画面(2026-09-08、ebay-automationと同じ「共有ユーザー名/パスワード + リカバリーコード」
 * 方式に統一)。Supabase Authのメールアドレス+パスワード(signInWithPassword)は廃止し、
 * lib/api/auth.tsのloginWithSharedCredentials()(Edge Function `app-login` 経由)を使う。
 * 「パスワードをお忘れの方はこちら」も、メール送信(resetPasswordForEmail)からリカバリーコード
 * 入力方式(resetPasswordWithRecoveryCode、Edge Function `app-forgot-password`)に置き換えた。
 */
export default function LoginPage({ onLoggedIn }: Props) {
  const [mode, setMode] = useState<"login" | "forgot" | "forgot_done">("login");

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [recoveryCode, setRecoveryCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirm, setNewPasswordConfirm] = useState("");
  const [issuedRecoveryCode, setIssuedRecoveryCode] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMessage(null);

    if (!username.trim() || !password) {
      setErrorMessage("ユーザー名とパスワードを入力してください");
      return;
    }

    setBusy(true);
    try {
      await loginWithSharedCredentials(username.trim(), password);
      // マーケティング(ebay-automation)側のセッション確立は、App.tsx側のセッション監視
      // (onAuthStateChange)で一括して行う(2026-09-11、ページ再読み込みでの永続セッション
      // 復元時にも同じ処理が必要なため、ログイン直後だけでなくそちらに寄せた)。
      onLoggedIn();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "ログインに失敗しました");
    } finally {
      setBusy(false);
    }
  }

  function resetForgotForm() {
    setMode("login");
    setRecoveryCode("");
    setNewPassword("");
    setNewPasswordConfirm("");
    setIssuedRecoveryCode(null);
    setErrorMessage(null);
  }

  async function handleForgotSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMessage(null);

    if (!recoveryCode.trim()) {
      setErrorMessage("リカバリーコードを入力してください");
      return;
    }
    if (newPassword.length < 8) {
      setErrorMessage("新しいパスワードは8文字以上で入力してください");
      return;
    }
    if (newPassword !== newPasswordConfirm) {
      setErrorMessage("新しいパスワード(確認)が一致しません");
      return;
    }

    setBusy(true);
    try {
      const newCode = await resetPasswordWithRecoveryCode(recoveryCode.trim(), newPassword);
      setIssuedRecoveryCode(newCode);
      setMode("forgot_done");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "再設定に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  if (mode === "forgot" || mode === "forgot_done") {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh" }}>
        <div style={CARD_STYLE}>
          <p style={{ fontSize: 16, fontWeight: 500, marginTop: 0, marginBottom: 16 }}>
            パスワードの再設定
          </p>

          {mode === "forgot_done" ? (
            <>
              <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 12 }}>
                パスワードを再設定しました。あわせてリカバリーコードも新しいものに入れ替わっています。
                下記の新しいリカバリーコードは今だけ表示されます。必ず控えてください。
              </p>
              <p
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  fontFamily: "monospace",
                  wordBreak: "break-all",
                  padding: "10px 12px",
                  border: "0.5px solid var(--border-strong)",
                  borderRadius: 8,
                  marginBottom: 16,
                }}
              >
                {issuedRecoveryCode}
              </p>
              <button type="button" onClick={resetForgotForm} style={{ width: "100%" }}>
                ログイン画面に戻る
              </button>
            </>
          ) : (
            <form onSubmit={handleForgotSubmit}>
              <div style={{ marginBottom: 12 }}>
                <label style={{ fontSize: 12, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
                  リカバリーコード
                </label>
                <input
                  type="text"
                  value={recoveryCode}
                  onChange={(e) => setRecoveryCode(e.target.value)}
                  style={{ width: "100%" }}
                  autoComplete="off"
                />
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={{ fontSize: 12, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
                  新パスワード(8文字以上)
                </label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
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
                  value={newPasswordConfirm}
                  onChange={(e) => setNewPasswordConfirm(e.target.value)}
                  style={{ width: "100%" }}
                  autoComplete="new-password"
                />
              </div>
              {errorMessage && (
                <p style={{ color: "var(--danger-text)", fontSize: 13, marginBottom: 12 }}>{errorMessage}</p>
              )}
              <button type="submit" disabled={busy} style={{ width: "100%", marginBottom: 8 }}>
                {busy ? "再設定中..." : "パスワードを再設定"}
              </button>
              <button
                type="button"
                onClick={resetForgotForm}
                style={{ width: "100%", background: "transparent", border: "none", fontSize: 12, color: "var(--text-secondary)" }}
              >
                ログイン画面に戻る
              </button>
            </form>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
      }}
    >
      <form onSubmit={handleSubmit} style={CARD_STYLE}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 0, marginBottom: 16 }}>
          <img src={logo} alt="" style={{ width: 32, height: 32, borderRadius: "50%", flexShrink: 0 }} />
          <p style={{ fontSize: 16, fontWeight: 500, margin: 0 }}>
            Soulmen Japan Business Portal
          </p>
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
            ユーザー名
          </label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            style={{ width: "100%" }}
            autoComplete="username"
          />
        </div>
        <div style={{ marginBottom: 8 }}>
          <label style={{ fontSize: 12, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
            パスワード
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ width: "100%" }}
            autoComplete="current-password"
          />
        </div>
        <div style={{ textAlign: "right", marginBottom: 16 }}>
          <button
            type="button"
            onClick={() => {
              setMode("forgot");
              setErrorMessage(null);
            }}
            style={{ background: "transparent", border: "none", fontSize: 12, color: "var(--text-secondary)", padding: 0 }}
          >
            パスワードをお忘れの方はこちら
          </button>
        </div>
        {errorMessage && (
          <p style={{ color: "var(--danger-text)", fontSize: 13, marginBottom: 12 }}>{errorMessage}</p>
        )}
        <button type="submit" disabled={busy} style={{ width: "100%" }}>
          {busy ? "ログイン中..." : "ログイン"}
        </button>
      </form>
    </div>
  );
}
