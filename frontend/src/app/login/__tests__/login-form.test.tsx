/**
 * Unit tests for the auth UI components (P01-04).
 *
 * Covers: LoginForm submit success (redirect to /dashboard), failure (error
 * shown, no redirect), backend-unreachable failure; SignOutButton logout and
 * redirect. fetch and the Next router are mocked; no real network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { LoginForm } from "@/app/login/login-form";
import { SignOutButton } from "@/components/ui/SignOutButton";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: vi.fn(),
    refresh: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("LoginForm", () => {
  it("renders username and password fields with autocomplete attributes", () => {
    render(<LoginForm />);
    const username = screen.getByLabelText("Username");
    const password = screen.getByLabelText("Password");
    expect(username).toHaveProperty("type", "text");
    expect(password).toHaveProperty("type", "password");
    expect(username.getAttribute("autocomplete")).toBe("username");
    expect(password.getAttribute("autocomplete")).toBe("current-password");
  });

  it("redirects to /dashboard on successful sign-in", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, data: { user: {}, session: {} } }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<LoginForm />);
    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "owner" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "pw123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/auth/login",
        expect.objectContaining({ method: "POST" }),
      );
    });
    // Credentials go in the request body only.
    const firstCall = fetchMock.mock.calls[0] as unknown[];
    const init = firstCall[1] as { body?: string };
    expect(init.body).toContain('"username":"owner"');
  });

  it("shows a friendly error and stays on the form on 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            error: { code: "UNAUTHORIZED", message: "Invalid credentials." },
          }),
          { status: 401 },
        ),
      ),
    );

    render(<LoginForm />);
    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "owner" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "wrong" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(
        "Invalid credentials.",
      );
    });
  });

  it("fails gracefully when the backend is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );

    render(<LoginForm />);
    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "owner" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "pw123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("Sign-in failed.");
    });
  });
});

describe("SignOutButton", () => {
  it("calls the logout endpoint on click", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<SignOutButton />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/auth/logout", {
        method: "POST",
        cache: "no-store",
      });
    });
  });
});
