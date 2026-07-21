"use client";

import { FormEvent, useState } from "react";
import { GoogleAuthProvider, signInWithEmailAndPassword, signInWithPopup } from "firebase/auth";
import { useRouter } from "next/navigation";

import { firebaseAuth } from "@/lib/firebase-client";

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"email" | "google" | "">("");

  async function createServerSession(idToken: string) {
    const response = await fetch("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(payload?.error || "Could not create server session");
    }
    router.replace("/dashboard");
    router.refresh();
  }

  async function signInWithGoogle() {
    setBusy("google");
    setError("");
    try {
      const result = await signInWithPopup(firebaseAuth, googleProvider);
      await createServerSession(await result.user.getIdToken(true));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Google sign in failed");
    } finally {
      setBusy("");
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("email");
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const result = await signInWithEmailAndPassword(
        firebaseAuth,
        String(form.get("email")),
        String(form.get("password")),
      );
      await createServerSession(await result.user.getIdToken(true));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign in failed");
    } finally {
      setBusy("");
    }
  }

  return (
    <form className="auth-card" onSubmit={submit}>
      <div>
        <p className="eyebrow">Docker Control Panel</p>
        <h1>Sign in</h1>
        <p className="muted">Manage repositories, workers, domains, and deployments.</p>
      </div>
      <label>Email<input name="email" type="email" autoComplete="email" required /></label>
      <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
      {error ? <p className="error">{error}</p> : null}
      <button type="submit" aria-label={busy === "email" ? "Signing in with email" : undefined} disabled={Boolean(busy)}>{busy === "email" ? <span className="button-spinner" aria-hidden="true" /> : "Start workspace"}</button>
      <button className="auth-google-button" type="button" aria-label={busy === "google" ? "Signing in with Gmail" : undefined} onClick={signInWithGoogle} disabled={Boolean(busy)}>
        {busy === "google" ? (
          <span className="button-spinner" aria-hidden="true" />
        ) : (
          <>
            <span className="google-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                <path fill="#4285F4" d="M21.55 12.22c0-.76-.07-1.49-.2-2.19H12v4.14h5.34a4.57 4.57 0 0 1-1.98 3v2.45h3.2c1.87-1.72 2.99-4.25 2.99-7.4Z" />
                <path fill="#34A853" d="M12 22c2.7 0 4.97-.89 6.62-2.42l-3.2-2.45c-.89.6-2.03.95-3.42.95-2.62 0-4.84-1.77-5.63-4.15H3.06v2.52A10 10 0 0 0 12 22Z" />
                <path fill="#FBBC05" d="M6.37 13.93A6 6 0 0 1 6.05 12c0-.67.12-1.32.32-1.93V7.55H3.06A10 10 0 0 0 2 12c0 1.61.39 3.14 1.06 4.45l3.31-2.52Z" />
                <path fill="#EA4335" d="M12 5.92c1.47 0 2.78.5 3.82 1.49l2.86-2.86C16.95 2.94 14.69 2 12 2a10 10 0 0 0-8.94 5.55l3.31 2.52C7.16 7.69 9.38 5.92 12 5.92Z" />
              </svg>
            </span>
            Continue with Gmail
          </>
        )}
      </button>
    </form>
  );
}
