import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import AppAreaError from "@/app/(app)/error";
import RootError from "@/app/error";

afterEach(cleanup);

describe("route error boundaries", () => {
  it("renders an alert and calls reset when retried (failure path)", () => {
    const reset = vi.fn();
    render(<RootError error={new Error("boom")} reset={reset} />);
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("shows the digest hint when a digest is present", () => {
    const error = Object.assign(new Error("boom"), { digest: "abc123" });
    render(<AppAreaError error={error} reset={() => undefined} />);
    expect(screen.getByText("Workspace error")).toBeTruthy();
    expect(screen.getByText(/Digest: abc123/)).toBeTruthy();
  });

  it("hides the digest hint when no digest is present (boundary case)", () => {
    render(<RootError error={new Error("boom")} reset={() => undefined} />);
    expect(screen.queryByText(/Digest:/)).toBeNull();
  });
});
