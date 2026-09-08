"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import type { JSX } from "react";

/**
 * Client sign-out control (P01-04). Calls the same-origin BFF logout proxy;
 * the backend deletes the DB session and the cookie is cleared.
 */
export function SignOutButton(): JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  async function handleSignOut() {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        cache: "no-store",
      });
    } catch {
      // Even on failure, redirect to the public area (fail closed).
    }
    startTransition(() => {
      router.replace("/login");
      router.refresh();
    });
  }

  return (
    <button
      className="fdb-signout"
      type="button"
      onClick={handleSignOut}
      disabled={pending}
    >
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
