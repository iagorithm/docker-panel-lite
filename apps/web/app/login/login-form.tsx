"use client";

import { FormEvent, useState } from "react";
import { signInWithEmailAndPassword } from "firebase/auth";
import { useRouter } from "next/navigation";

import { firebaseAuth } from "@/lib/firebase-client";

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const result = await signInWithEmailAndPassword(
        firebaseAuth,
        String(form.get("email")),
        String(form.get("password")),
      );
      const idToken = await result.user.getIdToken(true);
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idToken }),
      });
      if (!response.ok) throw new Error("Could not create server session");
      router.replace("/dashboard");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="auth-card" onSubmit={submit}>
      <div>
        <p className="eyebrow">Docker Control Plane</p>
        <h1>Sign in</h1>
        <p className="muted">Manage repositories, workers, domains, and deployments.</p>
      </div>
      <label>Email<input name="email" type="email" autoComplete="email" required /></label>
      <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
      {error ? <p className="error">{error}</p> : null}
      <button type="submit" disabled={busy}>{busy ? "Signing in…" : "Continue"}</button>
    </form>
  );
}
