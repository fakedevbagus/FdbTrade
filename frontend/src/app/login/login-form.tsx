"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { JSX, FormEvent } from "react";

/**
 * Client login form (P01-04). Credentials go to the server action only —
 * never to an API directly, never logged, never stored client-side.
 */
export function LoginForm(): JSX.Element {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = event.currentTarget;
    const formData = new FormData(form);
    const payload = {
      username: String(formData.get("username") ?? ""),
      password: String(formData.get("password") ?? ""),
    };
    let result: { ok: boolean; error?: string };
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        cache: "no-store",
      });
      const body = (await response.json()) as {
        ok: boolean;
        error?: { code: string; message: string };
      };
      result = response.ok && body.ok
        ? { ok: true }
        : { ok: false, error: body.error?.message ?? "Sign-in failed." };
    } catch {
      result = { ok: false, error: "Sign-in failed." };
    }
    if (result.ok) {
      form.reset();
      startTransition(() => {
        router.replace("/dashboard");
        router.refresh();
      });
    } else {
      setError(result.error ?? "Sign-in failed.");
    }
  }

  return (
    <form className="fdb-login-form" onSubmit={handleSubmit}>
      <label className="fdb-login-form__label" htmlFor="username">
        Username
      </label>
      <input
        className="fdb-login-form__input"
        id="username"
        name="username"
        type="text"
        autoComplete="username"
        required
        minLength={1}
        maxLength={100}
      />
      <label className="fdb-login-form__label" htmlFor="password">
        Password
      </label>
      <input
        className="fdb-login-form__input"
        id="password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
        minLength={1}
        maxLength={1000}
      />
      {error ? (
        <p className="fdb-login-form__error" role="alert">
          {error}
        </p>
      ) : null}
      <button className="fdb-login-form__submit" type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
