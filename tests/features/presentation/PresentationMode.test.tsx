import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import PresentationMode, { orderedPresentationResources } from "../../../src/features/presentation/PresentationMode";

const resources = [
  { id: "seq", path: "architecture.seq", title: "Architecture", type: "sequence-diagram", content: "participant Browser\nparticipant API\nBrowser->API: send" },
  { id: "readme", path: "README.md", title: "README", type: "markdown-document", content: "# Welcome" },
  { id: "flow", path: "billing.eventseq", title: "Billing", type: "event-flow", content: "event Invoice" },
];

describe("PresentationMode", () => {
  it("prefers overview resources and navigates the canonical stage", () => {
    expect(orderedPresentationResources(resources).map(({ id }) => id)).toEqual(["readme", "seq", "flow"]);
    const onExit = vi.fn();
    const onSelect = vi.fn();
    render(<PresentationMode projectName="Checkout" resources={resources} initialId="readme" onExit={onExit} onSelect={onSelect} />);
    expect(screen.getByTestId("presentation-mode")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Welcome" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next presentation item" }));
    expect(screen.getByTestId("diagram-preview")).toBeInTheDocument();
    expect(onSelect).toHaveBeenCalledWith("seq");
    fireEvent.click(screen.getByRole("button", { name: "Next presentation item" }));
    expect(screen.getByTestId("event-flow-preview")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onExit).toHaveBeenCalledOnce();
  });

  it("ignores navigation shortcuts inside interactive controls", () => {
    const onExit = vi.fn();
    render(<PresentationMode projectName="Checkout" resources={resources} initialId="readme" onExit={onExit} onSelect={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Exit presentation Esc" });
    fireEvent.keyDown(button, { key: "Escape" });
    expect(onExit).not.toHaveBeenCalled();
  });

  it("renders Database resources with the canonical Database Diagram renderer", async () => {
    render(<PresentationMode projectName="Billing" resources={[{ id: "db", path: "billing.dbschema", title: "Billing schema", type: "database", content: 'table customer - "Customer"\ncolumn customer id "id" {uuid} not-null\nprimary-key customer_pk customer (id)' }]} initialId="db" onExit={vi.fn()} />);
    expect(await screen.findByTestId("database-preview-svg")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "How to read Database Diagram" })).toBeInTheDocument();
  });

  it("keeps navigator dismissal in a dedicated header control", () => {
    render(<PresentationMode projectName="Checkout" resources={resources} initialId="readme" onExit={vi.fn()} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Architecture" }));
    const navigator = screen.getByRole("navigation", { name: "Presentation resources" });
    const close = within(navigator).getByRole("button", { name: "Close navigator" });
    expect(close.parentElement).toHaveClass("presentation__navigator-header");
    expect(close).toHaveClass("presentation__navigator-close");
  });
});
