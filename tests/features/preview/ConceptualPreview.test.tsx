import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ConceptualPreview from "../../../src/features/preview/ConceptualPreview";

describe("ConceptualPreview", () => {
  it("renders accessible concepts and routes selection to the semantic ID", async () => {
    const select = vi.fn();
    const source = 'concept customer "Customer & Co" description "Buyer\\naccount"\nconcept order "Order"\nconcept archive "Archive"\nrelation places customer -> order "places"\nrelation related customer -- order "related to"';
    const view = render(<ConceptualPreview source={source} onNodeSelect={select} />);
    const preview = await screen.findByTestId("conceptual-preview");
    expect(preview).toHaveClass("preview");
    await waitFor(() => expect(preview.querySelector("svg")?.querySelectorAll("[data-concept-id]")).toHaveLength(3));
    expect(preview.querySelector('[data-concept-id="customer"]')).toHaveAttribute("role", "button");
    expect(preview.querySelector('[data-concept-id="customer"]')).toHaveAttribute("aria-label", expect.stringContaining("Customer & Co"));
    const directed = preview.querySelector('[data-edge-id="places"] path');
    const undirected = preview.querySelector('[data-edge-id="related"]');
    expect(directed).toHaveAttribute("marker-end");
    expect(undirected?.querySelector("path")).not.toHaveAttribute("marker-end");
    expect(undirected).toHaveClass("conceptual__connection--undirected");
    expect(preview.querySelector('[data-label-for="places"] rect')).toBeInTheDocument();
    expect(preview.querySelector('[data-edge-id="places"]')).toHaveAttribute("data-source-concept-id", "customer");
    expect(preview.querySelector('[data-edge-id="places"]')).toHaveAttribute("data-target-concept-id", "order");
    expect(preview.querySelector("svg")?.textContent).toContain("Buyer");
    const customer = preview.querySelector('[data-concept-id="customer"]')!;
    fireEvent.click(customer);
    view.rerender(<ConceptualPreview source={source} onNodeSelect={select} activeNodeId="customer" />);
    await waitFor(() => expect(preview.querySelector('[data-edge-id="places"]')).toHaveClass("conceptual__connection--related"));
    expect(preview.querySelector('[data-edge-id="related"]')).toHaveClass("conceptual__connection--related");
    expect(preview.querySelector('[data-concept-id="archive"]')).toHaveClass("conceptual__concept--dim");
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
