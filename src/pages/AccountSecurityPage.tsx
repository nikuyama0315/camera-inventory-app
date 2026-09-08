import { useState } from "react";
import { changeSharedPassword, notifyPasswordChanged, reissueRecoveryCode } from "../lib/api/auth";

interface Props {
  onBack: () => void;
}

const SECTION_STYLE: React.CSSProperties = {
  maxWidth: 420,
  padding: "1.25rem 1.5rem",
  border: "0.5px solid var(--border)",
  borderRadius: 12,
  background: "var(--surface-2)",
  marginBottom: 20,
};

/**
 * 「ログイン情報再設定」画面(2026-09-08、ebay-automationのaccount_security.htmlと同じ構成に統一)。
 * 旧・ResetPasswordPage.tsx(Supabaseのメールリンク経由パスワード再設定)を置き換えた。
 * パスワード変更・リカバリーコード再発行の両方とも、現在のパスワードの入力を必須にしている点も
 * ebay-automationと同じ(Edge Function側でも検証するが、UI側でも早期にエラーを出せるようにする)。
 */
export default function AccountSecurityPage({ onBack }: Props) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirm, setNewPasswordConfirm] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);

  const [recoveryCurrentPassword, setRecoveryCurrentPassword] = useState("");
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [issuedRecoveryCode, setIssuedRecoveryCode] = useState<string | null>(null);

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPasswordError(null);
    setPasswordSuccess(false);

    if (!currentPassword) {
      setPasswordError("現在のパスワードを入力してください");
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError("新しいパスワードは8文字以上で入力してください");
      return;
    }
    if (newPassword !== newPasswordConfirm) {
      setPasswordError("新しいパスワード(確認)が一致しません");
      return;
    }

    setPasswordBusy(true);
    try {
      await changeSharedPassword(currentPassword, newPassword);
      // 不正検知用の通知メール送信。失敗してもパスワード変更自体はブロックしない(ベストエフォート)
      notifyPasswordChanged().catch(() => {});
      setPasswordSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
      setNewPasswordConfirm("");
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : "パスワードの変更に失敗しました");
    } finally {
      setPasswordBusy(false);
    }
  }

  async function handleReissueRecoveryCode(e: React.FormEvent) {
    e.preventDefault();
    setRecoveryError(null);
    setIssuedRecoveryCode(null);

    if (!recoveryCurrentPassword) {
      setRecoveryError("現在のパスワードを入力してください");
      return;
    }

    setRecoveryBusy(true);
    try {
      const newCode = await reissueRecoveryCode(recoveryCurrentPassword);
      setIssuedRecoveryCode(newCode);
      setRecoveryCurrentPassword("");
    } catch (err) {
      setRecoveryError(err instanceof Error ? err.message : "リカバリーコードの再発行に失敗しました");
    } finally {
      setRecoveryBusy(false);
    }
  }

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "1.5rem", boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <p style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>ログイン情報再設定</p>
        <button type="button" onClick={onBack} style={{ fontSize: 12, padding: "4px 10px" }}>
          戻る
        </button>
      </div>

      <form onSubmit={handleChangePassword} style={SECTION_STYLE}>
        <p style={{ fontSize: 14, fontWeight: 500, marginTop: 0, marginBottom: 12 }}>パスワード変更</p>
        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 12, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
            現在のパスワード
          </label>
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            style={{ width: "100%" }}
            autoComplete="current-password"
          />
        </div>
        <div style={{ marginBottom: 10 }}>
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
        <div style={{ marginBottom: 12 }}>
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
        {passwordError && (
          <p style={{ color: "var(--danger-text)", fontSize: 13, marginBottom: 10 }}>{passwordError}</p>
        )}
        {passwordSuccess && (
          <p style={{ color: "var(--text-secondary)", fontSize: 13, marginBottom: 10 }}>
            パスワードを変更しました。
          </p>
        )}
        <button type="submit" disabled={passwordBusy}>
          {passwordBusy ? "変更中..." : "パスワードを変更"}
        </button>
      </form>

      <form onSubmit={handleReissueRecoveryCode} style={SECTION_STYLE}>
        <p style={{ fontSize: 14, fontWeight: 500, marginTop: 0, marginBottom: 8 }}>リカバリーコード再発行</p>
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 0, marginBottom: 12 }}>
          ログイン画面の「パスワードをお忘れの方はこちら」で使う、メール不要の第二の鍵です。紛失した場合や、
          念のため入れ替えたい場合にここで再発行してください。
        </p>
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
            現在のパスワード
          </label>
          <input
            type="password"
            value={recoveryCurrentPassword}
            onChange={(e) => setRecoveryCurrentPassword(e.target.value)}
            style={{ width: "100%" }}
            autoComplete="current-password"
          />
        </div>
        {recoveryError && (
          <p style={{ color: "var(--danger-text)", fontSize: 13, marginBottom: 10 }}>{recoveryError}</p>
        )}
        {issuedRecoveryCode && (
          <div style={{ marginBottom: 12 }}>
            <p style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 6 }}>
              新しいリカバリーコードです。今だけ表示されます。必ず控えてください。
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
                margin: 0,
              }}
            >
              {issuedRecoveryCode}
            </p>
          </div>
        )}
        <button type="submit" disabled={recoveryBusy}>
          {recoveryBusy ? "発行中..." : "リカバリーコードを再発行"}
        </button>
      </form>
    </div>
  );
}
