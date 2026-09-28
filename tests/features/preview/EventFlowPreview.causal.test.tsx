import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import EventFlowPreview from "../../../src/features/preview/EventFlowPreview";

const mocked = vi.hoisted(() => ({
  render: vi.fn(),
}));

vi.mock("../../../src/renderer/pipeline/eventflow-to-causal-svg", () => ({
  renderEventFlowCausalDocument: mocked.render,
}));

const SVG = '<svg aria-label="Causal event flow"></svg>';
const SOURCE_A = "event A\nhandler H\nA handled by H";
const SOURCE_B = "event B\nhandler H\nB handled by H";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function documentFor(label: string) {
  return { svg: `${SVG}<title>${label}</title>`, width: 300, height: 200, view: {} };
}

describe("EventFlowPreview causal layout lifecycle", () => {
  afterEach(() => {
    cleanup();
    mocked.render.mockReset();
  });

  it("leaves loading after successful async layout", async () => {
    const pending = deferred<ReturnType<typeof documentFor>>();
    mocked.render.mockReturnValue(pending.promise);
    render(<EventFlowPreview source={SOURCE_A} view="causal" />);
    expect(screen.getByText("Laying out causal graph...")).toBeInTheDocument();
    await act(async () => pending.resolve(documentFor("A")));
    expect(await screen.findByTestId("causal-svg")).toBeInTheDocument();
  });

  it("ignores a stale layout when switching causal documents", async () => {
    const first = deferred<ReturnType<typeof documentFor>>();
    const second = deferred<ReturnType<typeof documentFor>>();
    mocked.render.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = render(<EventFlowPreview source={SOURCE_A} view="causal" />);
    view.rerender(<EventFlowPreview source={SOURCE_B} view="causal" />);
    await act(async () => first.resolve(documentFor("stale")));
    expect(screen.getByText("Laying out causal graph...")).toBeInTheDocument();
    await act(async () => second.resolve(documentFor("current")));
    expect(await screen.findByTestId("causal-svg")).toBeInTheDocument();
  });

  it("reports rejected layout promises instead of loading forever", async () => {
    mocked.render.mockRejectedValue(new Error("ELK unavailable"));
    render(<EventFlowPreview source={SOURCE_A} view="causal" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("ELK unavailable");
    expect(screen.queryByText("Laying out causal graph...")).not.toBeInTheDocument();
  });

  it("does not update state after unmount during layout", async () => {
    const pending = deferred<ReturnType<typeof documentFor>>();
    mocked.render.mockReturnValue(pending.promise);
    const view = render(<EventFlowPreview source={SOURCE_A} view="causal" />);
    view.unmount();
    await act(async () => pending.resolve(documentFor("unmounted")));
    expect(screen.queryByTestId("causal-svg")).not.toBeInTheDocument();
  });
});
