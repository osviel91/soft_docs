import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import DiagramViewport, {
  contextHintPosition,
  nodeIdFromTarget,
  noteIndexFromTarget,
  participantDragName,
} from "../../../src/features/preview/DiagramViewport";

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><text>Hi</text></svg>';
const SIZE = { width: 400, height: 300 };

/** jsdom reports every element as 0x0; give the pane a real box. */
function stubPaneSize(width: number, height: number) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

/** The transform applied to the diagram content. */
function transformOf(): string {
  return screen.getByTestId("viewport-content").style.transform;
}

describe("DiagramViewport", () => {
  beforeEach(() => stubPaneSize(800, 600));
  afterEach(() => vi.restoreAllMocks());

  it("renders the supplied svg markup", () => {
    render(<DiagramViewport svg={SVG} size={SIZE} />);
    expect(screen.getByTestId("viewport-content").innerHTML).toContain("<svg");
  });

  it.each(["circle", "line", "polygon", "text"])("resolves a message %s to its message identity", (part) => {
    const onNodeSelect = vi.fn();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><g class="sequence-message" data-sequence-message="1" data-message-node-id="message@1:0"><circle data-sequence-number="1"/><line/><polygon/><text>request</text></g></svg>';
    render(<DiagramViewport svg={svg} size={SIZE} onNodeSelect={onNodeSelect} />);
    const target = document.querySelector(`.sequence-message ${part}`)!;
    expect(nodeIdFromTarget(target)).toBe("message@1:0");
    fireEvent.click(target);
    expect(onNodeSelect).toHaveBeenCalledWith("message@1:0");
  });

  it("resolves every self-loop segment to its common message identity", () => {
    const onNodeSelect = vi.fn();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><g class="sequence-message" data-message-node-id="message@2:0"><path data-segment="loop-top"/><path data-segment="loop-side"/><path data-segment="loop-bottom"/><text data-sequence-number="2">2</text></g></svg>';
    render(<DiagramViewport svg={svg} size={SIZE} onNodeSelect={onNodeSelect} />);
    for (const target of document.querySelectorAll(".sequence-message > *")) fireEvent.click(target);
    expect(onNodeSelect).toHaveBeenNthCalledWith(1, "message@2:0");
    expect(onNodeSelect).toHaveBeenCalledTimes(4);
  });

  it("selects a participant from its lifeline and resolves nearby screen-space corridor hits", () => {
    const onNodeSelect = vi.fn();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><g class="participant" data-participant-id="billing"><rect data-node-id="participant@0:0"/><line class="lifeline" x1="100" x2="100" y1="0" y2="300" stroke-dasharray="4 3"/></g></svg>';
    render(<DiagramViewport svg={svg} size={SIZE} onNodeSelect={onNodeSelect} participantAssist />);
    const line = document.querySelector(".lifeline")!;
    fireEvent.click(line);
    expect(onNodeSelect).toHaveBeenLastCalledWith("participant@0:0");
    vi.spyOn(line, "getBoundingClientRect").mockReturnValue({ left: 99, right: 101, top: 0, bottom: 300, width: 2, height: 300 } as DOMRect);
    fireEvent.click(screen.getByTestId("viewport-content"), { clientX: 109, clientY: 150 });
    expect(onNodeSelect).toHaveBeenLastCalledWith("participant@0:0");
  });

  it("measures context position against available space and flips away from viewport edges", () => {
    const container = document.createElement("div");
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({ left: 20, top: 30, width: 400, height: 300 } as DOMRect);
    const hint = document.createElement("div");
    vi.spyOn(hint, "getBoundingClientRect").mockReturnValue({ width: 220, height: 80 } as DOMRect);
    expect(contextHintPosition(container, 410, 320, hint)).toEqual({ left: 156, top: 196 });
  });

  it("clears node selection when the blank diagram canvas is clicked", () => {
    const onNodeSelect = vi.fn();
    render(<DiagramViewport svg={SVG} size={SIZE} activeNodeId="concept:account" onNodeSelect={onNodeSelect} />);
    fireEvent.click(screen.getByTestId("viewport-content"));
    expect(onNodeSelect).toHaveBeenCalledWith(null);
  });

  it("clears node selection when pointer capture retargets the blank-canvas click to the pane", () => {
    const onNodeSelect = vi.fn();
    render(<DiagramViewport svg={SVG} size={SIZE} activeNodeId="concept:account" onNodeSelect={onNodeSelect} />);
    fireEvent.click(screen.getByTestId("viewport-pane"));
    expect(onNodeSelect).toHaveBeenCalledWith(null);
  });

  it("inspects a participant with Alt without changing selection or viewport, and exposes it to keyboard focus", async () => {
    const onNodeSelect = vi.fn();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><g class="participant" data-participant-id="billing" data-participant-label="Billing Service" draggable="true"><rect data-node-id="participant@0:0" x="80" y="10" width="100" height="30"/><line x1="130" y1="40" x2="130" y2="280" stroke="#000" stroke-dasharray="4 3"/></g></svg>';
    render(<DiagramViewport svg={svg} size={SIZE} onNodeSelect={onNodeSelect} participantAssist />);
    const line = document.querySelector(".participant line")!;
    vi.spyOn(line, "getBoundingClientRect").mockReturnValue({ left: 100, right: 101, top: 40, bottom: 520, width: 1, height: 480 } as DOMRect);
    const before = transformOf();
    const originalPointerEvent = Object.getOwnPropertyDescriptor(window, "PointerEvent");
    Object.defineProperty(window, "PointerEvent", { configurable: true, value: MouseEvent });
    try {
      for (const clientY of [50, 300, 510]) {
        fireEvent.pointerMove(screen.getByTestId("viewport-pane"), { pointerId: 1, pointerType: "mouse", clientX: 104, clientY, altKey: true, buttons: 0 });
        expect(await screen.findByTestId("participant-context-hint")).toHaveTextContent("Billing Service");
      }
    } finally {
      if (originalPointerEvent) Object.defineProperty(window, "PointerEvent", originalPointerEvent);
      else Reflect.deleteProperty(window, "PointerEvent");
    }

    expect(screen.getByTestId("participant-context-hint")).toHaveTextContent("Billing Service");
    expect(onNodeSelect).not.toHaveBeenCalled();
    expect(transformOf()).toBe(before);
    expect(document.querySelector(".participant--inspection")).not.toBeNull();
    fireEvent.keyUp(window, { key: "Alt" });
    expect(screen.queryByTestId("participant-context-hint")).not.toBeInTheDocument();
    expect(document.querySelector(".participant--inspection")).toBeNull();

    const participant = await screen.findByRole("button", { name: "Participant Billing Service" });
    expect(participant).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(participant, { key: "Enter" });
    expect(onNodeSelect).toHaveBeenCalledWith("participant@0:0");
    fireEvent.click(participant);
    expect(onNodeSelect).toHaveBeenLastCalledWith("participant@0:0");
  });

  it("shows exact message endpoints from renderer metadata when a Sequence message is active", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><g data-participant-id="A" data-participant-label="Order Service"><line x1="80" y1="20" x2="80" y2="280" stroke-dasharray="4 3"/></g><g data-participant-id="B" data-participant-label="Billing Service"><line x1="260" y1="20" x2="260" y2="280" stroke-dasharray="4 3"/></g><g class="sequence-message" data-sequence-message="1" data-message-node-id="message@1:0" data-message-label="Create invoice" data-message-from="A" data-message-to="B"><line data-node-id="message@1:0" x1="80" y1="140" x2="260" y2="140"/></g></svg>';
    render(<DiagramViewport svg={svg} size={SIZE} activeNodeId="message@1:0" participantAssist />);

    expect(await screen.findByTestId("message-endpoints-hint")).toHaveTextContent("Create invoice · From Order Service → To Billing Service");
  });

  it("shows stable participant context for an externally selected participant", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><g class="participant" data-participant-id="billing"><rect data-node-id="participant@0:0"/><line x1="100" x2="100" y1="10" y2="290" stroke-dasharray="4 3"/></g></svg>';
    render(<DiagramViewport svg={svg} size={SIZE} activeNodeId="participant@0:0" participantAssist />);
    expect(await screen.findByTestId("participant-context-hint")).toHaveTextContent("Participant · billing");
  });

  it("clamps the participant hint inside the viewport near its lower-right edge", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><g data-participant-id="B" data-participant-label="Billing"><rect data-node-id="participant@1:0"/><line x1="380" y1="20" x2="380" y2="290" stroke-dasharray="4 3"/></g></svg>';
    render(<DiagramViewport svg={svg} size={SIZE} participantAssist />);
    vi.spyOn(document.querySelector('g[data-participant-id] line')!, "getBoundingClientRect").mockReturnValue({ left: 790, right: 791, top: 20, bottom: 590, width: 1, height: 570 } as DOMRect);
    const originalPointerEvent = Object.getOwnPropertyDescriptor(window, "PointerEvent");
    Object.defineProperty(window, "PointerEvent", { configurable: true, value: MouseEvent });
    try {
      fireEvent.pointerMove(screen.getByTestId("viewport-pane"), { pointerId: 1, clientX: 795, clientY: 590, altKey: true, buttons: 0 });
    } finally {
      if (originalPointerEvent) Object.defineProperty(window, "PointerEvent", originalPointerEvent);
      else Reflect.deleteProperty(window, "PointerEvent");
    }
    const hint = await screen.findByTestId("participant-context-hint");
    expect(Number.parseFloat(hint.style.left)).toBeLessThanOrEqual(492);
    expect(Number.parseFloat(hint.style.top)).toBeLessThanOrEqual(504);
  });

  it("uses one roving tab stop for participants and arrow keys move focus without panning", async () => {
    const onNodeSelect = vi.fn();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><g data-participant-id="A" data-participant-label="Alpha"><rect data-node-id="participant@0:0"/><line x1="80" y1="40" x2="80" y2="280" stroke-dasharray="4 3"/></g><g data-participant-id="B" data-participant-label="Beta"><rect data-node-id="participant@1:0"/><line x1="260" y1="40" x2="260" y2="280" stroke-dasharray="4 3"/></g></svg>';
    render(<DiagramViewport svg={svg} size={SIZE} onNodeSelect={onNodeSelect} participantAssist />);
    const alpha = await screen.findByRole("button", { name: "Participant Alpha" });
    const beta = await screen.findByRole("button", { name: "Participant Beta" });
    expect(document.querySelectorAll('g[data-participant-id][tabindex="0"]')).toHaveLength(1);
    expect(alpha).toHaveAttribute("tabindex", "0");
    expect(beta).toHaveAttribute("tabindex", "-1");
    const before = transformOf();

    fireEvent.keyDown(alpha, { key: "ArrowRight" });
    expect(document.activeElement).toBe(beta);
    expect(transformOf()).toBe(before);
    fireEvent.keyDown(beta, { key: "Enter" });
    expect(onNodeSelect).toHaveBeenCalledWith("participant@1:0");
  });

  it("activates bound semantic badges without starting a pan", () => {
    const onSemanticMessageSelect = vi.fn();
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">' +
      '<g data-node-id="message:1"><text class="semantic-message-badge" data-semantic-message-id="msg-1" tabindex="0" role="button">EVENT · publish</text></g></svg>';
    render(
      <DiagramViewport
        svg={svg}
        size={SIZE}
        onSemanticMessageSelect={onSemanticMessageSelect}
      />,
    );
    const badge = document.querySelector(".semantic-message-badge")!;
    fireEvent.pointerDown(badge, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.click(badge);
    expect(onSemanticMessageSelect).toHaveBeenCalledWith("msg-1", "message:1");
    expect(screen.getByTestId("viewport-pane")).not.toHaveClass("viewport__pane--panning");
    fireEvent.keyDown(badge, { key: "Enter" });
    fireEvent.keyDown(badge, { key: " " });
    expect(onSemanticMessageSelect).toHaveBeenCalledTimes(3);
  });

  it("does not capture the pointer on an interactive SVG node but still captures blank-canvas pans", () => {
    const onNodeSelect = vi.fn();
    const capture = vi.fn();
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "setPointerCapture");
    const originalPointerEvent = Object.getOwnPropertyDescriptor(window, "PointerEvent");
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: capture });
    Object.defineProperty(window, "PointerEvent", { configurable: true, value: MouseEvent });
    try {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><g data-node-id="concept:account"><rect x="20" y="20" width="120" height="60"/></g></svg>';
      render(<DiagramViewport svg={svg} size={SIZE} onNodeSelect={onNodeSelect} />);
      const node = document.querySelector('[data-node-id="concept:account"]')!;
      fireEvent.pointerDown(node, { button: 0, pointerId: 1, clientX: 30, clientY: 30 });
      expect(capture).not.toHaveBeenCalled();
      fireEvent.click(node);
      expect(onNodeSelect).toHaveBeenCalledWith("concept:account");

      fireEvent.pointerDown(screen.getByTestId("viewport-pane"), { button: 0, pointerId: 2, clientX: 200, clientY: 200 });
      expect(capture).not.toHaveBeenCalled();
      fireEvent.pointerMove(screen.getByTestId("viewport-pane"), { pointerId: 2, clientX: 212, clientY: 200 });
      expect(capture).toHaveBeenCalledTimes(1);
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, "setPointerCapture", original);
      else Reflect.deleteProperty(HTMLElement.prototype, "setPointerCapture");
      if (originalPointerEvent) Object.defineProperty(window, "PointerEvent", originalPointerEvent);
      else Reflect.deleteProperty(window, "PointerEvent");
    }
  });

  it("treats sub-threshold movement as a tap and suppresses selection after a pan", () => {
    const onNodeSelect = vi.fn();
    const original = Object.getOwnPropertyDescriptor(window, "PointerEvent");
    Object.defineProperty(window, "PointerEvent", { configurable: true, value: MouseEvent });
    try {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><g class="sequence-message" data-message-node-id="message:1"><text>number</text></g></svg>';
      render(<DiagramViewport svg={svg} size={SIZE} onNodeSelect={onNodeSelect} />);
      const target = document.querySelector(".sequence-message text")!;
      const pane = screen.getByTestId("viewport-pane");
      const before = transformOf();
      fireEvent.pointerDown(target, { button: 0, pointerId: 9, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(target, { pointerId: 9, clientX: 13, clientY: 12 });
      fireEvent.pointerUp(target, { pointerId: 9, clientX: 13, clientY: 12 });
      fireEvent.click(target);
      expect(transformOf()).toBe(before);
      expect(onNodeSelect).toHaveBeenLastCalledWith("message:1");

      fireEvent.pointerDown(target, { button: 0, pointerId: 10, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(target, { pointerId: 10, clientX: 30, clientY: 20 });
      fireEvent.pointerUp(pane, { pointerId: 10, clientX: 30, clientY: 20 });
      fireEvent.click(pane);
      expect(transformOf()).not.toBe(before);
      expect(onNodeSelect).toHaveBeenCalledTimes(1);
    } finally {
      if (original) Object.defineProperty(window, "PointerEvent", original);
      else Reflect.deleteProperty(window, "PointerEvent");
    }
  });

  it("highlights every current-resource occurrence by identity", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">' +
      '<g data-node-id="message:1" data-semantic-message-id="msg-1"><text data-semantic-message-id="msg-1">EVENT · publish</text></g>' +
      '<g data-node-id="message:2" data-semantic-message-id="msg-1"><text data-semantic-message-id="msg-1">EVENT · consume</text></g>' +
      '<g data-node-id="message:3" data-semantic-message-id="other"><text data-semantic-message-id="other">EVENT · publish</text></g></svg>';
    render(<DiagramViewport svg={svg} size={SIZE} activeSemanticMessageId="msg-1" />);
    expect(document.querySelectorAll(".semantic-message--active")).toHaveLength(4);
    expect(document.querySelector('[data-semantic-message-id="other"]')).not.toHaveClass(
      "semantic-message--active",
    );
  });

  it.each(["EVENT · consume", "COMMAND · dispatch"])(
    "activates an unbound semantic badge through node selection: %s",
    (label) => {
      const onNodeSelect = vi.fn();
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">` +
        `<g data-node-id="message:1"><text class="semantic-message-badge" data-semantic-message-name="Message" tabindex="0" role="button">${label}</text></g></svg>`;
      render(<DiagramViewport svg={svg} size={SIZE} onNodeSelect={onNodeSelect} />);
      const badge = document.querySelector(".semantic-message-badge")!;
      fireEvent.click(badge);
      expect(onNodeSelect).toHaveBeenCalledWith("message:1");
      fireEvent.keyDown(badge, { key: "Enter" });
      fireEvent.keyDown(badge, { key: " " });
      expect(onNodeSelect).toHaveBeenCalledTimes(3);
    },
  );

  it("resolves a semantic message container back to its exact child occurrence", () => {
    const onSemanticOccurrenceSelect = vi.fn();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><g data-semantic-message-name="RechargeCompleted"><line data-node-id="message@17:0" x1="20" y1="30" x2="100" y2="30"/><text>RechargeCompleted</text></g></svg>';
    render(<DiagramViewport svg={svg} size={SIZE} onSemanticOccurrenceSelect={onSemanticOccurrenceSelect} />);
    fireEvent.click(document.querySelector('[data-semantic-message-name="RechargeCompleted"] line')!);
    expect(onSemanticOccurrenceSelect).toHaveBeenCalledWith("RechargeCompleted", "message@17:0");
  });

  it("honours a caller-supplied test id for the svg element", () => {
    render(<DiagramViewport svg={SVG} size={SIZE} svgTestId="preview-svg" />);
    expect(screen.getByTestId("preview-svg").innerHTML).toContain("<svg");
  });

  it("fits the diagram on mount", () => {
    render(<DiagramViewport svg={SVG} size={SIZE} />);
    // A diagram smaller than the pane is shown at natural size, centered.
    expect(screen.getByTestId("zoom-level").textContent).toBe("100%");
    expect(transformOf()).toContain("translate(200px, 150px)");
  });

  it("zooms in and out by one step", () => {
    render(<DiagramViewport svg={SVG} size={SIZE} />);
    fireEvent.click(screen.getByTestId("zoom-in"));
    expect(screen.getByTestId("zoom-level").textContent).toBe("125%");
    fireEvent.click(screen.getByTestId("zoom-out"));
    fireEvent.click(screen.getByTestId("zoom-out"));
    expect(screen.getByTestId("zoom-level").textContent).toBe("80%");
  });

  it("returns to 100% on reset", () => {
    render(<DiagramViewport svg={SVG} size={SIZE} />);
    fireEvent.click(screen.getByTestId("zoom-in"));
    expect(screen.getByTestId("zoom-level").textContent).toBe("125%");
    fireEvent.click(screen.getByTestId("zoom-reset"));
    expect(screen.getByTestId("zoom-level").textContent).toBe("100%");
  });

  it("shrinks a diagram larger than the pane when fitting", () => {
    render(<DiagramViewport svg={SVG} size={{ width: 4000, height: 3000 }} />);
    // (800 - 64) / 4000 = 0.184
    expect(screen.getByTestId("zoom-level").textContent).toBe("18%");
  });

  it("preserves the diagram camera when the pane is resized", () => {
    let resize = () => {};
    class TestResizeObserver {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    let width = 800;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
      width, height: 600, top: 0, left: 0, right: width, bottom: 600, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect));
    render(<DiagramViewport svg={SVG} size={SIZE} />);
    fireEvent.click(screen.getByTestId("zoom-in"));
    const camera = transformOf();
    width = 1100;
    act(() => resize());
    expect(transformOf()).toBe(camera);
  });

  it("pans with the arrow keys", () => {
    render(<DiagramViewport svg={SVG} size={SIZE} />);
    const before = transformOf();
    fireEvent.keyDown(screen.getByTestId("viewport-pane"), {
      key: "ArrowRight",
    });
    expect(transformOf()).not.toBe(before);
    expect(transformOf()).toContain("translate(152px, 150px)");
  });

  it("ignores keys it does not handle", () => {
    render(<DiagramViewport svg={SVG} size={SIZE} />);
    const before = transformOf();
    fireEvent.keyDown(screen.getByTestId("viewport-pane"), { key: "a" });
    expect(transformOf()).toBe(before);
  });

  it("re-fits when the reset key changes", () => {
    const { rerender } = render(
      <DiagramViewport svg={SVG} size={SIZE} resetKey="one" />,
    );
    fireEvent.click(screen.getByTestId("zoom-in"));
    expect(screen.getByTestId("zoom-level").textContent).toBe("125%");
    rerender(<DiagramViewport svg={SVG} size={SIZE} resetKey="two" />);
    expect(screen.getByTestId("zoom-level").textContent).toBe("100%");
  });

  it("renders a minimap image and a viewport indicator", () => {
    render(<DiagramViewport svg={SVG} size={SIZE} />);
    const image = screen.getByTestId("minimap-image") as HTMLImageElement;
    // The minimap embeds the same svg as an image so labels are not duplicated
    // in the document.
    expect(decodeURIComponent(image.src)).toContain("<svg");
    expect(screen.getByTestId("minimap-view")).toBeInTheDocument();
  });

  it("exposes the zoom controls as labelled buttons", () => {
    render(<DiagramViewport svg={SVG} size={SIZE} />);
    expect(screen.getByLabelText("Zoom in")).toBeInTheDocument();
    expect(screen.getByLabelText("Zoom out")).toBeInTheDocument();
    expect(screen.getByLabelText("Fit diagram to view")).toBeInTheDocument();
    expect(screen.getByLabelText("Reset zoom to 100%")).toBeInTheDocument();
    expect(screen.queryByTestId("preview-fullscreen")).not.toBeInTheDocument();
  });

  it("does not duplicate the shell focus control inside the canvas toolbar", () => {
    render(<DiagramViewport svg={SVG} size={SIZE} />);
    expect(screen.queryByTestId("viewer-focus-toggle")).not.toBeInTheDocument();
  });

  describe("note bullets", () => {
    // A bullet inside the injected markup, as the renderer emits it.
    const SVG_WITH_NOTE =
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">' +
      '<g data-note-index="0" role="button" tabindex="0" aria-label="Note: hi">' +
      '<circle cx="10" cy="10" r="6"/></g></svg>';

    it("reports a bullet activation by index", () => {
      const onNoteToggle = vi.fn();
      render(
        <DiagramViewport
          svg={SVG_WITH_NOTE}
          size={SIZE}
          onNoteToggle={onNoteToggle}
        />,
      );
      fireEvent.click(document.querySelector('[data-note-index="0"]')!);
      expect(onNoteToggle).toHaveBeenCalledWith(0);
    });

    it("finds the index from a bullet or any of its children", () => {
      render(<DiagramViewport svg={SVG_WITH_NOTE} size={SIZE} />);
      const bullet = document.querySelector('[data-note-index="0"]')!;
      const circle = bullet.querySelector("circle")!;
      expect(noteIndexFromTarget(bullet)).toBe(0);
      // Clicks land on the drawn circle, inside the bullet group.
      expect(noteIndexFromTarget(circle)).toBe(0);
    });

    it("returns null for targets outside a bullet", () => {
      render(<DiagramViewport svg={SVG_WITH_NOTE} size={SIZE} />);
      expect(
        noteIndexFromTarget(screen.getByTestId("viewport-pane")),
      ).toBeNull();
      expect(noteIndexFromTarget(null)).toBeNull();
    });

    it("ignores clicks that are not on a bullet", () => {
      const onNoteToggle = vi.fn();
      render(
        <DiagramViewport
          svg={SVG_WITH_NOTE}
          size={SIZE}
          onNoteToggle={onNoteToggle}
        />,
      );
      fireEvent.click(screen.getByTestId("viewport-pane"));
      expect(onNoteToggle).not.toHaveBeenCalled();
    });
  });
});

describe("DiagramViewport — linked camera", () => {
  beforeEach(() => stubPaneSize(800, 600));
  afterEach(() => vi.restoreAllMocks());

  it("ignores a fresh size object with the same numbers while linked", () => {
    const onTransformChange = vi.fn();
    const { rerender } = render(
      <DiagramViewport
        svg={SVG}
        size={{ width: 400, height: 300 }}
        onTransformChange={onTransformChange}
      />,
    );
    onTransformChange.mockClear();

    // A caller that passes a new `{ width, height }` literal each render must
    // not re-fit (and, while linked, must not echo a camera on every render).
    rerender(
      <DiagramViewport
        svg={SVG}
        size={{ width: 400, height: 300 }}
        onTransformChange={onTransformChange}
      />,
    );
    rerender(
      <DiagramViewport
        svg={SVG}
        size={{ width: 400, height: 300 }}
        onTransformChange={onTransformChange}
      />,
    );

    expect(onTransformChange).not.toHaveBeenCalled();
  });

  it("adopts a linked transform without reporting it back to the parent", () => {
    const onTransformChange = vi.fn();
    const { rerender } = render(
      <DiagramViewport
        svg={SVG}
        size={SIZE}
        onTransformChange={onTransformChange}
      />,
    );
    onTransformChange.mockClear();

    rerender(
      <DiagramViewport
        svg={SVG}
        size={SIZE}
        linkedTransform={{ x: 10, y: 20, scale: 1.5 }}
        onTransformChange={onTransformChange}
      />,
    );

    expect(transformOf()).toContain("translate(10px, 20px)");
    expect(transformOf()).toContain("scale(1.5)");
    // Following the peer is not the same as moving: no echo back to the source.
    expect(onTransformChange).not.toHaveBeenCalled();
  });

  it("does not reset the camera when the report callback appears or disappears", () => {
    const onTransformChange = vi.fn();
    const { rerender } = render(<DiagramViewport svg={SVG} size={SIZE} />);
    fireEvent.click(screen.getByTestId("zoom-in"));
    expect(screen.getByTestId("zoom-level").textContent).toBe("125%");

    // Linking toggles the callback on; that alone must not re-fit the pane.
    rerender(
      <DiagramViewport
        svg={SVG}
        size={SIZE}
        onTransformChange={onTransformChange}
      />,
    );
    expect(screen.getByTestId("zoom-level").textContent).toBe("125%");

    // Unlinking removes it; the camera must survive too.
    rerender(<DiagramViewport svg={SVG} size={SIZE} />);
    expect(screen.getByTestId("zoom-level").textContent).toBe("125%");
  });
});

describe("DiagramViewport — dragging a participant", () => {
  // A participant group as the renderer emits it.
  const SVG_WITH_PARTICIPANT =
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">' +
    '<g data-participant-id="API" data-participant-label="API" draggable="true">' +
    '<rect x="0" y="0" width="20" height="20"/></g></svg>';

  beforeEach(() => stubPaneSize(800, 600));
  afterEach(() => vi.restoreAllMocks());

  it("recognizes a participant group as a drag source", () => {
    render(<DiagramViewport svg={SVG_WITH_PARTICIPANT} size={SIZE} />);
    expect(
      participantDragName(
        document.querySelector('[data-participant-id="API"]'),
      ),
    ).toBe("API");
    expect(participantDragName(screen.getByTestId("viewport-pane"))).toBeNull();
  });

  it("puts the participant name on the drag payload as plain text", () => {
    render(<DiagramViewport svg={SVG_WITH_PARTICIPANT} size={SIZE} />);
    const setData = vi.fn();
    fireEvent.dragStart(
      document.querySelector('[data-participant-id="API"]')!,
      { dataTransfer: { setData, effectAllowed: "" } },
    );
    expect(setData).toHaveBeenCalledWith("text/plain", "API");
  });

  it("does not capture a participant drag as a canvas pan", () => {
    const original = Object.getOwnPropertyDescriptor(window, "PointerEvent");
    Object.defineProperty(window, "PointerEvent", { configurable: true, value: MouseEvent });
    try {
      render(<DiagramViewport svg={SVG_WITH_PARTICIPANT} size={SIZE} />);
      const participant = document.querySelector('[data-participant-id="API"]')!;
      const before = transformOf();
      fireEvent.pointerDown(participant, { button: 0, pointerId: 4, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(participant, { pointerId: 4, clientX: 40, clientY: 10 });
      expect(transformOf()).toBe(before);
      const setData = vi.fn();
      fireEvent.dragStart(participant, { dataTransfer: { setData, effectAllowed: "" } });
      expect(setData).toHaveBeenCalledWith("text/plain", "API");
    } finally {
      if (original) Object.defineProperty(window, "PointerEvent", original);
      else Reflect.deleteProperty(window, "PointerEvent");
    }
  });
});
