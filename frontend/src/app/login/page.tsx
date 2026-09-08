import type { Metadata } from "next";
import type { JSX } from "react";

import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Sign in",
};

/**
 * `/login` (P01-04) — single-user sign-in.
 *
 * The form posts via a server action that calls the backend login API;
 * credentials never touch the browser bundle beyond this form's inputs and
 * are never logged. The backend's httpOnly session cookie is mirrored onto
 * the response so subsequent requests authenticate.
 */
export default function LoginPage(): JSX.Element {
  return (
    <main className="fdb-container" id="fdb-main">
      <h1 className="fdb-title">Sign in to FdbTrade</h1>
      <p className="fdb-subtitle">
        Private single-user access. All timestamps are UTC.
      </p>
      <LoginForm />
    </main>
  );
}
