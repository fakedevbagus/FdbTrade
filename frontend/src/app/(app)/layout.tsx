import type { JSX, ReactNode } from "react";
import { redirect } from "next/navigation";

import { SignOutButton } from "@/components/ui";
import { fetchSession } from "@/lib/auth";

/**
 * Protected app area layout (P01-04).
 *
 * Server-side authorization guard: every request under this route group is
 * checked against the backend session API before any child renders. An
 * invalid, missing, or backend-unreachable session redirects to /login
 * (fail closed). The UI check is convenience only — the backend guard on
 * every private API route remains the security boundary.
 */
export default async function AppAreaLayout({
  children,
}: {
  children: ReactNode;
}): Promise<JSX.Element> {
  const session = await fetchSession();
  if (!session) {
    redirect("/login");
  }
  return (
    <div className="fdb-container">
      <p className="fdb-app-area__banner" role="note">
        Protected area — signed in as {session.user.username}. All timestamps
        are UTC. <SignOutButton />
      </p>
      {children}
    </div>
  );
}

