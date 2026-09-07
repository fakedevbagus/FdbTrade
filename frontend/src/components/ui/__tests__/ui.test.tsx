import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";

import { EmptyState, ErrorState, Loading } from "@/components/ui";

describe("Loading", () => {
  it("renders a status region with the default label (happy path)", () => {
    render(<Loading />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("renders a custom label (valid input)", () => {
    render(<Loading label="Loading workspace…" />);
    expect(screen.getByText("Loading workspace…")).toBeTruthy();
  });

  it("is deterministic for deterministic inputs", () => {
    const first = renderToString(<Loading label="Loading FdbTrade…" />);
    const second = renderToString(<Loading label="Loading FdbTrade…" />);
    expect(first).toBe(second);
  });
});

describe("EmptyState", () => {
  it("renders title, description and action (happy path)", () => {
    render(
      <EmptyState
        title="Nothing here yet"
        description="No signals yet."
        action={<a href="/dashboard">Open the dashboard</a>}
      />,
    );
    expect(screen.getByText("Nothing here yet")).toBeTruthy();
    expect(screen.getByText("No signals yet.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open the dashboard" })).toBeTruthy();
  });

  it("omits the description when not provided (boundary/empty case)", () => {
    const { container } = render(<EmptyState title="Nothing here yet" />);
    expect(
      container.querySelector(".fdb-empty__description"),
    ).toBeNull();
    expect(container.querySelector(".fdb-empty__action")).toBeNull();
  });

  it("is deterministic for deterministic inputs", () => {
    const first = renderToString(<EmptyState title="A" description="B" />);
    const second = renderToString(<EmptyState title="A" description="B" />);
    expect(first).toBe(second);
  });
});

describe("ErrorState", () => {
  it("renders an alert with the default title and message (happy path)", () => {
    render(<ErrorState message="The page failed to render." />);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Something went wrong")).toBeTruthy();
    expect(screen.getByText("The page failed to render.")).toBeTruthy();
  });

  it("renders a custom title and hint (valid input)", () => {
    render(
      <ErrorState
        title="Render error"
        message="Failed."
        hint="Digest: abc123"
      />,
    );
    expect(screen.getByText("Render error")).toBeTruthy();
    expect(screen.getByText("Digest: abc123")).toBeTruthy();
  });

  it("omits the hint when not provided (boundary case)", () => {
    const { container } = render(<ErrorState message="Failed." />);
    expect(container.querySelector(".fdb-error__hint")).toBeNull();
  });

  it("is deterministic for deterministic inputs", () => {
    const first = renderToString(<ErrorState message="Failed." title="T" />);
    const second = renderToString(<ErrorState message="Failed." title="T" />);
    expect(first).toBe(second);
  });
});
