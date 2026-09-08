/**
 * Frontend route middleware (P01-04).
 *
 * Server-side authorization for the protected app area, executed BEFORE any
 * rendering begins: validates the request's session cookie against the
 * backend auth API and redirects unauthenticated users to /login. This runs
 * ahead of React streaming, so protected page content never reaches an
 * unauthenticated response (the layout guard in `(app)/layout.tsx` is
 * defense-in-depth but cannot block streamed content by itself).
 *
 * Fail closed: a backend outage or malformed response redirects to /login.
 */
import { NextResponse, type NextRequest } from "next/server";

const BFF_API_URL = process.env.FDB_BFF_URL ?? "http://127.0.0.1:3100";

/** Paths that require an authenticated session (protected app area). */
const PROTECTED_PREFIXES = ["/dashboard"];

async function hasValidSession(request: NextRequest): Promise<boolean> {
  const sessionCookie = request.cookies.get("fdb_session");
  if (!sessionCookie?.value) {
    return false;
  }
  try {
    const response = await fetch(`${BFF_API_URL}/api/auth/session`, {
      headers: { cookie: `fdb_session=${sessionCookie.value}` },
      cache: "no-store",
    });
    if (response.status !== 200) {
      return false;
    }
    const body = (await response.json()) as {
      ok?: boolean;
      data?: { user?: { id?: string } };
    };
    return (
      body.ok === true &&
      typeof body.data?.user?.id === "string" &&
      body.data.user.id.length > 0
    );
  } catch {
    return false; // backend unreachable: fail closed
  }
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  if (!isProtected) {
    return NextResponse.next();
  }
  const authenticated = await hasValidSession(request);
  if (!authenticated) {
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*"],
};
