import { useState } from "react";
import { supabase } from "../lib/supabaseClient";
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

export default function LoginPage({ onLoggedIn }: Props) {
  const [mode, setMode] = useState<"login" | "forgot" | "forgot_sent">("login");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [forgotEmail, setForgotEmail] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMessage(null);

    if (!email.trim() || !password.trim()) {
      setErrorMessage("メールアドレスとパスワードを入力してください");
      return;
    }

    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      onLoggedIn();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "ログインに失敗しました");
    } finally {
      setBusy(false);
    }
  }

  async function handleForgotSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMessage(null);

    if (!forgotEmail.trim()) {
      setErrorMessage("メールアドレスを入力してください");
      return;
    }

    setBusy(true);
    try {
      // Supabaseの仕様上、登録の有無にかかわらず常に成功が返る(メールアドレスの存在を外部に漏らさないため)
      await supabase.auth.resetPasswordForEmail(forgotEmail.trim(), {
        redirectTo: window.location.origin,
      });
      setMode("forgot_sent");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "送信に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  if (mode === "forgot" || mode === "forgot_sent") {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh" }}>
        <div style={CARD_STYLE}>
          <p style={{ fontSize: 16, fontWeight: 500, marginTop: 0, marginBottom: 16 }}>
            パスワードの再発行
          </p>

          {mode === "forgot_sent" ? (
            <>
              <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 16 }}>
                入力されたメールアドレスが登録されている場合、パスワード再設定用のリンクを送信しました。メールをご確認ください。
              </p>
              <button
                type="button"
                onClick={() => {
                  setMode("login");
                  setForgotEmail("");
                }}
                style={{ width: "100%" }}
              >
                ログイン画面に戻る
              </button>
            </>
          ) : (
            <form onSubmit={handleForgotSubmit}>
              <div style={{ marginBottom: 16 }}>
                <label style={{ fontSize: 12, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
                  登録済みのメールアドレス
                </label>
                <input
                  type="email"
                  value={forgotEmail}
                  onChange={(e) => setForgotEmail(e.target.value)}
                  style={{ width: "100%" }}
                  autoComplete="username"
                />
              </div>
              {errorMessage && (
                <p style={{ color: "var(--danger-text)", fontSize: 13, marginBottom: 12 }}>{errorMessage}</p>
              )}
              <button type="submit" disabled={busy} style={{ width: "100%", marginBottom: 8 }}>
                {busy ? "送信中..." : "再設定リンクを送信"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode("login");
                  setErrorMessage(null);
                }}
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
            メールアドレス
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
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
