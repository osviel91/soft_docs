import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import Preview from "../../../src/features/preview/Preview";
import EventFlowPreview from "../../../src/features/preview/EventFlowPreview";
import DiagramGuidance from "../../../src/features/preview/DiagramGuidance";
import type { SemanticChange } from "../../../src/domain/diff/resource-diff";

vi.mock("../../../src/renderer/causal/CausalFlowView", () => ({ default: () => <div /> }));
afterEach(cleanup);

describe("contextual diagram guidance", () => {
  it("explains Database FK direction and semantic boundaries", () => {
    render(<DiagramGuidance view="database" />);
    fireEvent.click(screen.getByRole("button", { name: "How to read Database Diagram" }));
    fireEvent.click(screen.getByText("Learn more"));
    expect(screen.getByText(/Foreign-key arrows point from the referencing\/source/)).toBeInTheDocument();
    expect(screen.getByText(/A foreign key is documented data structure/)).toBeInTheDocument();
    expect(screen.getByText(/not a semantic change/)).toBeInTheDocument();
  });

  it("is opt-in, keyboard operable, and does not replace the sequence canvas", async () => {
    render(<Preview source={"participant A\nparticipant B\nA -> B: call"} />);
    const help = screen.getByRole("button", { name: "How to read Sequence" });
    expect(help).toHaveAttribute("aria-expanded", "false");
    expect(help.closest(".viewport__rail")).toBeNull();
    expect(help.closest(".sequence-guidance-toolbar")).toBeInTheDocument();
    expect(screen.getByTestId("preview-svg")).toBeInTheDocument();
    help.focus();
    await userEvent.setup().keyboard("{Enter}");
    expect(screen.getByText(/numbered message/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close diagram guidance" }));
    expect(screen.queryByText(/numbered message/)).not.toBeInTheDocument();
    expect(screen.getByTestId("preview-svg")).toBeInTheDocument();
  });

  it("updates guidance with Event Flow representation and does not leak prior content", () => {
    const { rerender } = render(<EventFlowPreview source="event A" view="flow" />);
    fireEvent.click(screen.getByRole("button", { name: "How to read Event Flow" }));
    expect(screen.getByText(/publication and consumption context/)).toBeInTheDocument();
    rerender(<EventFlowPreview source="event A" view="causal" />);
    expect(screen.queryByText(/publication and consumption context/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "How to read Event Flow · Causal" }));
    expect(screen.getByText(/authored causal facts/)).toBeInTheDocument();
    expect(screen.queryByText(/numbered message/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "How to read Event Flow · Causal" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "Causal" }));
    expect(screen.queryByText(/authored causal facts/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "How to read Event Flow · Causal" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "How to read Event Flow · Causal" }).closest(".event-flow-toolbar")).toBeInTheDocument();
  });

  it.each([
    ["flow", "How to read Event Flow"],
    ["catalog", "How to read Event Flow · Catalog"],
    ["topology", "How to read Event Flow · Topology"],
    ["causal", "How to read Event Flow · Causal"],
  ] as const)("keeps guidance attached to the toolbar for %s", (view, label) => {
    render(<EventFlowPreview source="event A" view={view} />);
    const help = screen.getByRole("button", { name: label });
    expect(help.closest(".event-flow-toolbar")).toBeInTheDocument();
    expect(help.closest(".viewport__rail")).toBeNull();
    fireEvent.click(help);
    expect(screen.getByRole("complementary", { name: `${label.replace("How to read ", "")} guidance` })).toBeInTheDocument();
  });

  it("distinguishes resource diff decorations from semantic relationships", () => {
    render(<Preview source="participant A" reviewChanges={[{ kind: "added", entity: "participant", identity: "A" } satisfies SemanticChange]} />);
    fireEvent.click(screen.getByRole("button", { name: "How to read Sequence" }));
    expect(screen.getByText(/resource diff states, not relationship types/)).toBeInTheDocument();
    expect(screen.queryByText(/Each viewer is a separate resource/)).not.toBeInTheDocument();
  });
});
