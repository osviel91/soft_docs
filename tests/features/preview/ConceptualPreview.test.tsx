import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ConceptualPreview from "../../../src/features/preview/ConceptualPreview";

describe("ConceptualPreview", () => {
  it("renders accessible concepts and routes selection to the semantic ID", async () => {
    const select = vi.fn();
    render(<ConceptualPreview source={'concept customer "Customer & Co" description "Buyer\\naccount"\nconcept order "Order"\nrelation places customer -> order "places"\nrelation related customer -- order "related to"'} onNodeSelect={select} />);
    const preview = await screen.findByTestId("conceptual-preview");
    expect(preview).toHaveClass("preview");
    await waitFor(() => expect(preview.querySelector("svg")?.querySelectorAll("[data-concept-id]")).toHaveLength(2));
    expect(preview.querySelector('[data-concept-id="customer"]')).toHaveAttribute("role", "button");
    expect(preview.querySelector('[data-concept-id="customer"]')).toHaveAttribute("aria-label", expect.stringContaining("Customer & Co"));
    const directed = preview.querySelector('[data-edge-id="places"] path');
    const undirected = preview.querySelector('[data-edge-id="related"] path');
    expect(directed).toHaveAttribute("marker-end");
    expect(undirected).not.toHaveAttribute("marker-end");
    expect(preview.querySelector("svg")?.textContent).toContain("Buyer");
    const customer = preview.querySelector('[data-concept-id="customer"]')!;
    fireEvent.click(customer);
    fireEvent.keyDown(customer, { key: "Enter" });
    expect(select).toHaveBeenCalledTimes(2);
    expect(select).toHaveBeenCalledWith("customer");
  });

  it("shows syntax errors without attempting to render a diagram", () => {
    render(<ConceptualPreview source={'concept broken "unterminated'} />);
    expect(screen.getByTestId("conceptual-preview-invalid")).toHaveAttribute("role", "status");
    expect(screen.queryByTestId("conceptual-preview-svg")).not.toBeInTheDocument();
  });
});
