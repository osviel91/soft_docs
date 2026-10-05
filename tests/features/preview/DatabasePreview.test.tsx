import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DatabasePreview from "../../../src/features/preview/DatabasePreview";
import * as geometryLayout from "../../../src/layout/elk-geometry-adapter";

describe("DatabasePreview", () => {
  it("renders valid source using the Database Diagram pipeline", async () => {
    render(<DatabasePreview source={'table customer - "Customer"\ncolumn customer id "id" {uuid} not-null\nprimary-key customer_pk customer (id)'} />);
    const viewport = await screen.findByTestId("database-preview-svg");
    expect(viewport.querySelector("svg")).toHaveAttribute("aria-label", "Database Diagram");
    expect(screen.getByRole("button", { name: "Fit diagram to view" })).toBeInTheDocument();
  });

  it("keeps invalid source in a safe diagnostic preview state", () => {
    render(<DatabasePreview source={'table broken - "unterminated'} />);
    expect(screen.getByTestId("database-preview-invalid")).toHaveAttribute("role", "status");
    expect(screen.queryByTestId("database-preview-svg")).not.toBeInTheDocument();
  });

  it("keeps a layout failure separate from invalid source", async () => {
    const layout = vi.spyOn(geometryLayout, "layoutGeometry").mockRejectedValueOnce(new Error("layout failed"));
    try {
      render(<DatabasePreview source={'table customer - "Customer"\ncolumn customer id "id" {uuid} not-null\nprimary-key customer_pk customer (id)'} />);
      expect(await screen.findByRole("alert")).toHaveTextContent("does not indicate invalid source");
      expect(screen.queryByTestId("database-preview-invalid")).not.toBeInTheDocument();
    } finally {
      layout.mockRestore();
    }
  });

  it("does not relayout for table selection, guidance, or viewport zoom", async () => {
    const layout = vi.spyOn(geometryLayout, "layoutGeometry");
    try {
      render(<DatabasePreview source={'table customer - "Customer"\ncolumn customer id "id" {uuid} not-null\nprimary-key customer_pk customer (id)'} onNodeSelect={vi.fn()} />);
      const viewport = await screen.findByTestId("database-preview-svg");
      await vi.waitFor(() => expect(layout).toHaveBeenCalledTimes(1));
      fireEvent.click(viewport.querySelector('[data-node-id="customer"]')!);
      fireEvent.click(screen.getByRole("button", { name: "How to read Database Diagram" }));
      fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
      expect(layout).toHaveBeenCalledTimes(1);
    } finally {
      layout.mockRestore();
    }
  });
});
