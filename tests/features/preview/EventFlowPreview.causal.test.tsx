import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import EventFlowPreview from "../../../src/features/preview/EventFlowPreview";

vi.mock("../../../src/renderer/causal/CausalFlowView", () => ({
  default: ({ view }: { view: { messages: unknown[] } }) => <div data-testid="causal-flow-view">{view.messages.length} causal messages</div>,
}));

afterEach(cleanup);

describe("EventFlowPreview causal integration", () => {
  it("renders the production React Flow causal surface for explicit causality", () => {
    render(<EventFlowPreview source={["event A", "event B", "handler H", "A handled by H", "H causes B", "effect save on H: save state"].join("\n")} view="causal" />);
    expect(screen.getByTestId("causal-flow-view")).toHaveTextContent("2 causal messages");
  });

  it("preserves the truthful empty state when no causal facts exist", () => {
    render(<EventFlowPreview source="event A" view="causal" />);
    expect(screen.getByTestId("event-causal-empty")).toHaveTextContent("explicit causal relationships");
  });
});
