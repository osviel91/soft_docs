import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import Preview from "../../../src/features/preview/Preview";
import EventFlowPreview from "../../../src/features/preview/EventFlowPreview";
import type { SemanticChange } from "../../../src/domain/diff/resource-diff";

vi.mock("../../../src/renderer/causal/CausalFlowView", () => ({ default: () => <div /> }));
afterEach(cleanup);

describe("contextual diagram guidance", () => {
  it("is opt-in, keyboard operable, and does not replace the sequence canvas", async () => {
    render(<Preview source={"participant A\nparticipant B\nA -> B: call"} />);
    const help = screen.getByRole("button", { name: "How to read Sequence" });
    expect(help).toHaveAttribute("aria-expanded", "false");
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
  });

  it("distinguishes resource diff decorations from semantic relationships", () => {
    render(<Preview source="participant A" reviewChanges={[{ kind: "added", entity: "participant", identity: "A" } satisfies SemanticChange]} />);
    fireEvent.click(screen.getByRole("button", { name: "How to read Sequence" }));
    expect(screen.getByText(/resource diff states, not relationship types/)).toBeInTheDocument();
    expect(screen.queryByText(/Each viewer is a separate resource/)).not.toBeInTheDocument();
  });
});
