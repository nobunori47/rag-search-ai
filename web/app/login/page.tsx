"use client";

import { useState, FormEvent, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "../../lib/supabase/client";

const ALLOWED_DOMAIN =
  process.env.NEXT_PUBLIC_ALLOWED_EMAIL_DOMAIN ?? "@techbridge.co.jp";

function LoginForm() {
  const searchParams = useSearchParams();
  const urlError = searchParams.get("error");

  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(
    urlError === "domain"
      ? `${ALLOWED_DOMAIN} のメールアドレスのみ使用できます`
      : urlError === "auth"
        ? "認証に失敗しました。再度お試しください"
        : null
  );
  const [loading, setLoading] = useState(false);

  const supabase = createClient();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const trimmed = email.trim().toLowerCase();

    if (!trimmed.endsWith(ALLOWED_DOMAIN)) {
      setError(`${ALLOWED_DOMAIN} のメールアドレスのみ使用できます`);
      return;
    }

    setLoading(true);
    const { error: authError } = await supabase.auth.signInWithOtp({
      email: trimmed,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (authError) {
      setError(authError.message);
      setLoading(false);
    } else {
      setSent(true);
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <div className="login-container">
        <div className="login-box">
          <h1 className="login-title">社内文書 RAG チャット</h1>
          <div className="login-sent">
            <p className="login-sent-text">
              <strong>{email}</strong> にログインリンクを送信しました。
            </p>
            <p className="login-sent-sub">
              メールを確認してリンクをクリックしてください。
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="login-container">
      <div className="login-box">
        <h1 className="login-title">社内文書 RAG チャット</h1>
        <p className="login-desc">
          社内メールアドレスでログインしてください
        </p>
        <form onSubmit={handleSubmit} className="login-form">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={`例: taro@techbridge.co.jp`}
            required
            disabled={loading}
            className="login-input"
            autoComplete="email"
          />
          {error && <p className="login-error">{error}</p>}
          <button type="submit" disabled={loading} className="login-button">
            {loading ? "送信中…" : "ログインリンクを送信"}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
